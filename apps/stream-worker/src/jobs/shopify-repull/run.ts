/**
 * shopify-repull/run.ts — 35-day re-pull job for Shopify orders (live lane).
 *
 * Purpose: a catch-up job for COD orders that may have changed status (RTO,
 * delivery, cancellation) within the last 35 days. Re-polls Shopify with
 * updated_at_min=now-35d, maps each order to order.live.v1, and emits to the
 * live lane (dev.collector.event.v1). Webhooks are the PRIMARY live path;
 * the re-pull is the COD catch-up mechanism (ADR-LV-12 / D-14).
 *
 * Mirrors shopify-backfill/run.ts pattern:
 *   - SECURITY DEFINER enumeration via list_connectors_for_repull() (D-7)
 *   - GUC set AFTER enumerate, before any brand-scoped read/write (ADR-LV-7)
 *   - FOR UPDATE SKIP LOCKED overlap-lock on connector_cursor row
 *     resource='orders.repull' — distinct from backfill 'orders' (D-9/D-10)
 *   - High-water cursor: updated_at max seen (not since_id — different from backfill)
 *   - event_id = uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs) (D-6)
 *   - Direct produce to live topic (dev.collector.event.v1) (ADR-LV-3)
 *   - connector_sync_status: syncing at start, connected+last_sync_at on done (D-11)
 *   - brand_id from fn result (MT-1) — NEVER from env, Shopify, or header
 *   - No raw PII in events/logs (D-10)
 *   - Token NEVER logged (I-S09)
 *
 * D-6 dedup: uuidV5FromOrderLive(brand, order, updatedAtMs) → distinct per state.
 * Same updated_at retry → same id → Bronze ON CONFLICT DO NOTHING → dedup.
 * Different updated_at → new Bronze row per state change.
 *
 * Backfill namespace ':order.backfill.v1' vs live namespace ':order.live.v1'
 * → provably no collision between backfill and re-pull Bronze rows.
 */

import { Pool } from 'pg';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { updateConnectorInstanceHealth } from '../../infrastructure/pg/ConnectorInstanceHealthRepository.js';
import { Kafka, type Producer } from 'kafkajs';
import { createIdempotentProducer } from '../../infrastructure/kafka/idempotent-producer.js';
import { buildPartitionKey } from '@brain/events';
import { injectKafkaTraceContext } from '@brain/observability';
import { createSaltProvider, type SaltProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import { loadStreamWorkerConfig } from '@brain/config';
import { ShopifyLiveClient } from './shopify-live-client.js';
import {
  mapOrderToEvent,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
} from '@brain/shopify-mapper';
import { buildWorkerSecretsManager } from '../shopify-backfill/worker-secrets.js';
import { log } from "../../log.js";
import {
  acquireCursorLock,
  getCursorValue,
  upsertCursorValue,
} from '../../infrastructure/pg/CursorRepository.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;

const BROKERS = cfg.KAFKA_BROKERS.split(',');
// intentional raw: NODE_ENV-derived Kafka topic-prefix selection (must precede config load).
const ENV = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
const LIVE_TOPIC = `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

/** 35-day re-pull window (COD delivery horizon + buffer) */
const REPULL_WINDOW_MS = 35 * 24 * 60 * 60 * 1000;

/** The cursor resource key — DISTINCT from backfill 'orders' (D-10 / ADR-LV-9) */
const REPULL_CURSOR_RESOURCE = 'orders.repull' as const;

interface ConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  shop_domain: string;
  secret_ref: string;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the 35-day re-pull job.
 * Enumerates all connected Shopify connectors via SECURITY DEFINER fn,
 * then for each, acquires an overlap-lock and re-pulls updated orders.
 *
 * Invocation:
 *   node dist/jobs/shopify-repull/run.js [connector_instance_id]
 * If connector_instance_id is specified, only that connector is re-pulled.
 */
export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });
  const kafka = new Kafka({
    clientId: 'shopify-repull-worker',
    brokers: BROKERS,
    retry: { retries: 5 },
  });
  const producer = createIdempotentProducer(kafka);
  const workerSecrets = buildWorkerSecretsManager();
  const saltProvider = createSaltProvider(DB_URL);

  try {
    await producer.connect();
    log.info(`starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    // ── D-7: enumerate via SECURITY DEFINER fn (no GUC at this point) ────────
    // list_connectors_for_repull() runs as 'brain' (SECURITY DEFINER), bypasses
    // FORCE RLS, returns dispatch-only cols. GUC is set AFTER enumerate (below).
    const connectors = await enumerateConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('no connected Shopify connectors found — exiting');
      return;
    }

    log.info(`found ${connectors.length} connector(s) to re-pull`);

    for (const connector of connectors) {
      await repullConnector({
        connector,
        pool,
        producer,
        workerSecrets,
        saltProvider,
      });
    }
  } finally {
    await producer.disconnect();
    await pool.end();
  }
}

// ── Enumerate (D-7) ──────────────────────────────────────────────────────────

async function enumerateConnectors(
  pool: Pool,
  targetConnectorInstanceId?: string,
): Promise<ConnectorRow[]> {
  // SECURITY DEFINER fn — brain_app calls it, runs as 'brain', bypasses FORCE RLS.
  // No GUC needed at this step (we're discovering which brand to work for).
  let result;
  if (targetConnectorInstanceId) {
    result = await pool.query<ConnectorRow>(
      `SELECT connector_instance_id, brand_id, shop_domain, secret_ref
       FROM list_connectors_for_repull()
       WHERE connector_instance_id = $1`,
      [targetConnectorInstanceId],
    );
  } else {
    result = await pool.query<ConnectorRow>(
      `SELECT connector_instance_id, brand_id, shop_domain, secret_ref
       FROM list_connectors_for_repull()`,
    );
  }
  return result.rows;
}

// ── Per-connector re-pull ─────────────────────────────────────────────────────

interface RepullParams {
  connector: ConnectorRow;
  pool: Pool;
  producer: Producer;
  workerSecrets: { getShopifyToken(ref: string): Promise<string | null> };
  saltProvider: SaltProvider;
}

async function repullConnector(params: RepullParams): Promise<void> {
  const { connector, pool, producer, workerSecrets, saltProvider } = params;
  const { connector_instance_id: ciId, brand_id: brandId, shop_domain: shopDomain, secret_ref: secretRef } = connector;

  log.info(`connector=${ciId} brand=${brandId} shop=${shopDomain}`);

  // ── D-9: overlap-lock via FOR UPDATE SKIP LOCKED on connector_cursor ─────────
  // Acquire a row-level lock on the cursor row BEFORE any work. A second concurrent
  // trigger will find the row locked and SKIP — preventing double re-pull.
  // Lock held for the duration of the repull via the transaction.
  const lockAcquired = await acquireRepullLock(pool, brandId, ciId);
  if (!lockAcquired) {
    log.info(`connector=${ciId} — already locked by another worker, skipping`);
    return;
  }

  // ── GUC-after-enumerate (ADR-LV-7): set brand_id BEFORE any brand-scoped read ─
  // brand_id authority = list_connectors_for_repull() fn result (MT-1).
  // Token fetch + saltProvider are not brand-scoped reads, but connector_sync_status is.

  // Resolve access token (I-S09: NEVER logged).
  // The token can be ABSENT two ways: getShopifyToken returns null (secret_ref present but empty), or
  // it THROWS (the Secrets Manager secret itself is gone — "can't find the specified secret"). BOTH mean
  // the same thing: the credential needs a human reconnect. Mark connector_sync_status='error' with a
  // RECONNECT_REQUIRED reason (mirrors the 401 path below + meta/woo) so (a) the tile prompts reconnect
  // instead of showing a stale 'connected', and (b) the scheduler's claim_due_repull_connectors backs
  // this connector off (0112) instead of re-dispatching a guaranteed-to-fail repull every interval.
  let accessToken: string | null = null;
  try {
    accessToken = await workerSecrets.getShopifyToken(secretRef);
  } catch (err) {
    log.error(`connector=${ciId} — token fetch failed (RECONNECT_REQUIRED)`, { detail: String(err) });
  }
  if (!accessToken) {
    log.error(`connector=${ciId} — token not found (RECONNECT_REQUIRED)`);
    await setSyncState(pool, brandId, ciId, 'error', 'shopify token not found — RECONNECT_REQUIRED');
    return;
  }

  // Per-brand salt for PII hashing
  let saltHex: string;
  try {
    saltHex = await saltProvider.saltHexForBrand(brandId);
  } catch (e) {
    log.error(`connector=${ciId} — salt fetch failed`, { detail: e });
    return;
  }

  // ── D-11 + SEC-LV-M1: atomically CLAIM state=syncing BEFORE any Shopify fetch ──
  // Closes the lock-release window: if a second trigger also slipped past acquireRepullLock, only
  // the worker that wins this compare-and-swap proceeds; the loser skips (no double API calls).
  const claimedSyncing = await claimSyncingState(pool, brandId, ciId);
  if (!claimedSyncing) {
    log.info(`connector=${ciId} — already syncing (claimed by another worker), skipping`);
    return;
  }

  const shopClient = new ShopifyLiveClient(shopDomain, accessToken);
  const updatedAtMin = new Date(Date.now() - REPULL_WINDOW_MS).toISOString();
  const regionCode = 'IN';

  // ── Read existing high-water cursor (updated_at of last seen order) ───────────
  const priorCursor = await getRepullCursor(pool, brandId, ciId);
  log.info(`connector=${ciId} updatedAtMin=${updatedAtMin} priorCursor=${priorCursor ?? 'none'}`);

  let recordsProcessed = 0;
  let maxUpdatedAtMs: number | null = null;
  let pageCount = 0;
  const POLL_SLEEP_MS = cfg.REPULL_PAGE_SLEEP_MS;

  try {
    // ── Page loop using updated_at_min filter (not created_at_min) ──────────────
    // ShopifyLiveClient.fetchOrdersPage uses since_id pagination with updated_at_min.
    // Shopify returns id-ascending pages filtered by updated_at >= updatedAtMin.
    // We walk all pages; high-water cursor tracks max updated_at seen.
    let sinceId: string | null = null;

    while (true) {
      pageCount++;
      log.info(`connector=${ciId} page=${pageCount} sinceId=${sinceId ?? 'null'}`);

      let page;
      try {
        page = await shopClient.fetchOrdersPage(sinceId, updatedAtMin);
      } catch (err) {
        const msg = String(err);
        if (msg.startsWith('SHOPIFY_AUTH_ERROR')) {
          log.error(`connector=${ciId} 401 auth error — aborting re-pull`);
          recordConnectorAuthRejected('shopify'); // P2.6: make the silent token-expiry death loud
          await setSyncState(pool, brandId, ciId, 'error', '401 auth error — RECONNECT_REQUIRED');
          await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
          return;
        }
        log.error(`connector=${ciId} page error — aborting`, { err: err });
        await setSyncState(pool, brandId, ciId, 'error', `page_error: ${msg.slice(0, 200)}`);
        return;
      }

      if (page.orders.length === 0) break;

      // ── Per-order: map → live event → emit ───────────────────────────────────
      const messages = [];
      for (const order of page.orders) {
        // D-6: live event_id includes updatedAtMs — distinct per state change
        const updatedAt = order.updated_at ?? order.processed_at ?? order.created_at;
        const updatedAtMs = new Date(updatedAt!).getTime();

        const eventId = uuidV5FromOrderLive(brandId, String(order.id), updatedAtMs);

        const mapped = mapOrderToEvent(order, saltHex, regionCode, ORDER_LIVE_V1_EVENT_NAME);

        // Build CollectorEventV1 envelope
        const envelope = CollectorEventV1Schema.parse({
          schema_version: '1',
          event_id: eventId,
          brand_id: brandId,          // from fn result (MT-1) — never from Shopify
          correlation_id: `repull:${ciId}:${eventId}`,
          event_name: mapped.event_name,
          occurred_at: mapped.occurred_at,   // updated_at — state's economic time (D-6)
          ingested_at: new Date().toISOString(),
          properties: mapped.properties as unknown as Record<string, unknown>,
        });

        messages.push({
          key: buildPartitionKey(brandId, eventId),
          value: Buffer.from(JSON.stringify(envelope)),
        });

        // Track max updated_at for high-water cursor (D-10 / ADR-LV-9)
        if (maxUpdatedAtMs === null || updatedAtMs > maxUpdatedAtMs) {
          maxUpdatedAtMs = updatedAtMs;
        }

        recordsProcessed++;
      }

      // OTel trace-context propagation (OBS-1/OBS-2): stamp traceparent on each
      // message so the bronze-bridge consumer resumes this repull's trace.
      const traceHeaders: Record<string, Buffer | string> = {};
      injectKafkaTraceContext(traceHeaders);
      const tracedMessages = messages.map((m) => ({ ...m, headers: traceHeaders }));

      // Emit to LIVE lane (ADR-LV-3 / ADR-LV-12 / D-14)
      await producer.send({ topic: LIVE_TOPIC, messages: tracedMessages });

      log.info(`connector=${ciId} page=${pageCount} emitted=${messages.length} total=${recordsProcessed}`);

      // ── Advance cursor after each page (checkpoint) ───────────────────────────
      if (maxUpdatedAtMs !== null) {
        await upsertRepullCursor(pool, brandId, ciId, String(maxUpdatedAtMs));
      }

      sinceId = page.nextSinceId;
      if (sinceId === null) break;

      if (POLL_SLEEP_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_SLEEP_MS));
      }
    }

    // ── D-11: set connected + last_sync_at on completion ─────────────────────
    await setSyncState(pool, brandId, ciId, 'connected', null);

    log.info(`connector=${ciId} COMPLETED records=${recordsProcessed} maxUpdatedAt=${maxUpdatedAtMs}`);
  } catch (err) {
    log.error(`connector=${ciId} unexpected error`, { err: err });
    await setSyncState(pool, brandId, ciId, 'error', `unexpected: ${String(err).slice(0, 200)}`);
    throw err;
  }
}

// ── Overlap-lock + cursor management (D-9..D-11 / ADR-LV-8/9) ────────────────
// These delegate to the shared CursorRepository — the standard connector_cursor
// read/upsert/overlap-lock for trailing-window re-pulls, bound here to the fixed
// resource='orders.repull'. Names kept for the live-connector e2e test imports.

/**
 * Acquire the FOR UPDATE SKIP LOCKED overlap-lock on the orders.repull cursor row.
 * Returns false immediately if another re-pull holds it (non-blocking).
 */
function acquireRepullLock(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
): Promise<boolean> {
  return acquireCursorLock(pool, brandId, connectorInstanceId, REPULL_CURSOR_RESOURCE);
}

/** Read the orders.repull high-water cursor (null when absent or the empty sentinel). */
function getRepullCursor(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
): Promise<string | null> {
  return getCursorValue(pool, brandId, connectorInstanceId, REPULL_CURSOR_RESOURCE);
}

/** Advance the orders.repull high-water cursor (non-fatal on error). */
function upsertRepullCursor(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
  cursorValue: string,
): Promise<void> {
  return upsertCursorValue(pool, brandId, connectorInstanceId, REPULL_CURSOR_RESOURCE, cursorValue);
}

// ── Sync status (D-11 / ADR-LV-10) ──────────────────────────────────────────

async function setSyncState(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
  state: 'syncing' | 'connected' | 'error',
  lastError: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // GUC BEFORE brand-scoped write (NN-1 / ADR-LV-7)
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true)`,
      [brandId],
    );
    // UPSERT, not UPDATE (matches the shared connector re-pull pattern): a missing connect-time row would make an
    // UPDATE-only write a silent no-op → UI stuck on "Not synced yet". (brand_id, connector_instance_id) UNIQUE.
    if (state === 'connected') {
      await client.query(
        `INSERT INTO connector_sync_status (brand_id, connector_instance_id, state, last_sync_at, last_error)
           VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (brand_id, connector_instance_id)
           DO UPDATE SET state = EXCLUDED.state, last_sync_at = NOW(),
                         last_error = EXCLUDED.last_error, updated_at = NOW()`,
        [brandId, connectorInstanceId, state, lastError],
      );
    } else {
      await client.query(
        `INSERT INTO connector_sync_status (brand_id, connector_instance_id, state, last_error)
           VALUES ($1, $2, $3, $4)
         ON CONFLICT (brand_id, connector_instance_id)
           DO UPDATE SET state = EXCLUDED.state, last_error = EXCLUDED.last_error, updated_at = NOW()`,
        [brandId, connectorInstanceId, state, lastError],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.error(`sync_status update failed (non-fatal)`, { err: err });
  } finally {
    client.release();
  }
}

/**
 * SEC-LV-M1 — atomically CLAIM the 'syncing' state (compare-and-swap).
 *
 * acquireRepullLock commits (and so releases) the cursor row-lock before the re-pull runs — by
 * design, to avoid holding a DB lock for the whole job. That leaves a narrow window where a second
 * concurrent trigger can also acquire the (now-free) lock. The 'syncing' state is the real
 * in-progress guard, so we claim it atomically: UPSERT ... ON CONFLICT DO UPDATE ... WHERE
 * state <> 'syncing'. Exactly one contender's WHERE passes (Postgres serializes the conflicting
 * upserts and re-evaluates the predicate against the just-committed row); the loser gets 0 rows and
 * skips — closing the double-API-call window. The connector_sync_status row carries a UNIQUE
 * (brand_id, connector_instance_id) (migration 0025) which is the conflict arbiter.
 *
 * Returns true iff THIS worker won the claim.
 */
async function claimSyncingState(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // GUC BEFORE brand-scoped write (NN-1 / ADR-LV-7) — RLS FORCE on connector_sync_status.
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    const res = await client.query(
      `INSERT INTO connector_sync_status (brand_id, connector_instance_id, state, last_error, updated_at)
       VALUES ($1, $2, 'syncing', NULL, NOW())
       ON CONFLICT (brand_id, connector_instance_id)
       DO UPDATE SET state = 'syncing', last_error = NULL, updated_at = NOW()
       WHERE connector_sync_status.state <> 'syncing'
       RETURNING id`,
      [brandId, connectorInstanceId],
    );
    await client.query('COMMIT');
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Fail CLOSED: if we can't prove we won the claim, do not proceed (avoids double re-pull).
    log.error(`claim syncing-state failed`, { err: err });
    return false;
  } finally {
    client.release();
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

if (
  process.argv[1]?.endsWith('run.ts') ||
  process.argv[1]?.endsWith('run.js')
) {
  const ciArg = process.argv[2]; // optional: connector_instance_id
  run(ciArg).catch((err) => {
    log.error('fatal', { err: err });
    process.exit(1);
  });
}

export { enumerateConnectors, acquireRepullLock, upsertRepullCursor, setSyncState, claimSyncingState };
