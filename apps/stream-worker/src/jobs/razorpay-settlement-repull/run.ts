/**
 * razorpay-settlement-repull/run.ts — Multi-cursor settlement re-pull job (ADR-RZ-5).
 *
 * Purpose: enumerate all connected Razorpay connectors via SECURITY DEFINER fn,
 * then for each brand run 3 cursor-bounded settlement fetch loops (C6 multi-cursor):
 *   - settlements.payments  — 30d window, daily polling
 *   - settlements.reserves  — 180d window, weekly polling (reserve releases)
 *   - settlements.adjustments — 90d window, weekly polling (chargebacks, corrections)
 *
 * Architecture (mirrors shopify-repull/run.ts pattern exactly):
 *   1. enumerate via list_razorpay_connectors_for_settlement_repull() — SECURITY DEFINER,
 *      no GUC at enumerate time (durable rule: system-job-force-rls-enumeration)
 *   2. GUC set AFTER enumerate, before any brand-scoped read/write (ADR-RZ-5 / MT-1)
 *   3. FOR UPDATE SKIP LOCKED per cursor resource (C6 — 3 locks per brand)
 *   4. Map each item via @brain/razorpay-mapper (field allowlist + boundary hash — C1/C4)
 *   5. Emit settlement.live.v1 to live lane (dev.collector.event.v1)
 *   6. Advance cursor after each page; connector_sync_status: syncing → connected
 *
 * The re-pull does NOT do the ledger join — it only lands events on the live lane.
 * The two-hop join + net-of-fees finalization is SettlementLedgerConsumer's job.
 *
 * Raw Razorpay IDs (pay_XXXX, UTR) are hashed at the mapper boundary (C1).
 * NEVER log raw payment_id, UTR, or raw API response body (C5).
 * brand_id ALWAYS from fn result (MT-1) — NEVER from env or API response.
 *
 * Dev trigger entrypoint (MB-6): pass connector_instance_id as argv[2] to re-pull
 * a single connector. This exercises all 3 cursors in one run (CI-testable).
 */

import { Pool } from 'pg';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { updateConnectorInstanceHealth, recoverConnectorInstanceHealth } from '../../infrastructure/pg/ConnectorInstanceHealthRepository.js';
import { Kafka, type Producer } from 'kafkajs';
import { createIdempotentProducer } from '../../infrastructure/kafka/idempotent-producer.js';
import { filterUnseenEventIds, markEventIdsSeen } from '../../infrastructure/pg/IngestDedupRepository.js';
import { buildPartitionKey } from '@brain/events';
import { injectKafkaTraceContext, incrementCounter } from '@brain/observability';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import { loadStreamWorkerConfig } from '@brain/config';
import { buildContextGucSql } from '@brain/db';
import {
  mapSettlementItemToEvent,
  uuidV5FromSettlementItem,
  uuidV5FromSettlementSummary,
  SETTLEMENT_LIVE_V1_EVENT_NAME,
  type RazorpaySettlementItem,
  type SettlementEntityType,
} from '@brain/razorpay-mapper';
import { RazorpaySettlementsClient, type RazorpayApiCredentials } from './razorpay-settlements-client.js';
import { createSaltProvider, type SaltProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { log } from "../../log.js";
import { acquireCursorLock, getCursorValue, upsertCursorValue } from '../../infrastructure/pg/CursorRepository.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;

const BROKERS = cfg.KAFKA_BROKERS.split(',');
// intentional raw: NODE_ENV-derived Kafka topic-prefix selection (must precede config load).
const ENV = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
const LIVE_TOPIC = `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

/** C6 multi-cursor resources and their window sizes (in milliseconds) */
const CURSOR_CONFIGS = [
  {
    resource: 'settlements.payments' as const,
    windowMs: 30 * 24 * 60 * 60 * 1000,   // 30 days — standard T+2 settlements
    label: 'payments',
  },
  {
    resource: 'settlements.reserves' as const,
    windowMs: 180 * 24 * 60 * 60 * 1000,  // 180 days — rolling reserve releases
    label: 'reserves',
  },
  {
    resource: 'settlements.adjustments' as const,
    windowMs: 90 * 24 * 60 * 60 * 1000,   // 90 days — chargebacks, corrections
    label: 'adjustments',
  },
] as const;

type CursorResource = typeof CURSOR_CONFIGS[number]['resource'];

interface RazorpayConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  secret_ref: string;
}

/** Dev credentials bundle parsed from the secret (3 creds in one JSON blob — C2) */
interface RazorpaySecretBundle {
  key_id: string;      // NEVER logged (I-S09)
  key_secret: string;  // NEVER logged (I-S09)
  webhook_secret: string;  // NEVER logged
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the settlement re-pull job (ADR-RZ-5 / MB-6).
 * If targetConnectorInstanceId is provided, only that connector is re-pulled (dev trigger).
 */
export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({
    clientId: 'razorpay-settlement-repull',
    brokers: BROKERS,
    retry: { retries: 5 },
  });
  const producer = createIdempotentProducer(kafka);

  const saltProvider = createSaltProvider(DB_URL);

  try {
    await producer.connect();
    log.info(`starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    // ── MB-5: enumerate via SECURITY DEFINER fn (no GUC at this point) ──────
    // list_razorpay_connectors_for_settlement_repull() runs as 'brain' (SECURITY DEFINER),
    // bypasses FORCE RLS, returns dispatch-only cols. GUC set AFTER enumerate (below).
    const connectors = await enumerateConnectors(pool, targetConnectorInstanceId);

    if (connectors.length === 0) {
      log.info('no connected Razorpay connectors found — exiting');
      return;
    }

    log.info(`found ${connectors.length} connector(s) to re-pull`);

    for (const connector of connectors) {
      await repullConnector({ connector, pool, producer, saltProvider });
    }
  } finally {
    await producer.disconnect();
    await pool.end();
  }
}

// ── Enumerate (MB-5 / durable rule system-job-force-rls-enumeration) ─────────

async function enumerateConnectors(
  pool: Pool,
  targetConnectorInstanceId?: string,
): Promise<RazorpayConnectorRow[]> {
  // SECURITY DEFINER fn — brain_app calls it, runs as 'brain', bypasses FORCE RLS.
  // No GUC needed at this step (discovering WHICH connector to process).
  if (targetConnectorInstanceId) {
    const result = await pool.query<RazorpayConnectorRow>(
      `SELECT connector_instance_id, brand_id, secret_ref
       FROM list_razorpay_connectors_for_settlement_repull()
       WHERE connector_instance_id = $1`,
      [targetConnectorInstanceId],
    );
    return result.rows;
  }
  const result = await pool.query<RazorpayConnectorRow>(
    `SELECT connector_instance_id, brand_id, secret_ref
     FROM list_razorpay_connectors_for_settlement_repull()`,
  );
  return result.rows;
}

// ── Per-connector re-pull ─────────────────────────────────────────────────────

interface RepullParams {
  connector: RazorpayConnectorRow;
  pool: Pool;
  producer: Producer;
  saltProvider: SaltProvider;
}

async function repullConnector(params: RepullParams): Promise<void> {
  const { connector, pool, producer, saltProvider } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = connector;

  log.info(`connector=${ciId} brand=${brandId}`);

  // ── Resolve Razorpay credentials from secret bundle (C2 — 3 creds in one JSON blob) ─
  const creds = await resolveRazorpayCredentials(secretRef);
  if (!creds) {
    log.error(`connector=${ciId} — credentials not found (RECONNECT_REQUIRED)`);
    // Mark RECONNECT_REQUIRED so the tile prompts reconnect (not a stale 'connected') and the scheduler
    // backs this connector off (0112) instead of re-dispatching a guaranteed-to-fail repull every tick.
    await setSyncState(pool, brandId, ciId, 'error', 'razorpay credentials not found — RECONNECT_REQUIRED');
    return;
  }

  // ── Per-brand salt for DPDP boundary hashing (C1) ────────────────────────
  let saltHex: string;
  try {
    saltHex = await saltProvider.saltHexForBrand(brandId);
  } catch (e) {
    log.error(`connector=${ciId} — salt fetch failed`, { detail: e });
    return;
  }

  // ── GUC-after-enumerate (ADR-RZ-5 / MT-1): set brand_id BEFORE any brand-scoped read ──
  // brand_id authority = list_razorpay_connectors_for_settlement_repull() fn result (MT-1).
  await setSyncState(pool, brandId, ciId, 'syncing', null);

  const apiClient = new RazorpaySettlementsClient(creds);

  // ── C6: process all 3 cursor resources per brand ─────────────────────────
  let totalEmitted = 0;
  for (const cursorConfig of CURSOR_CONFIGS) {
    try {
      const emitted = await repullCursorResource({
        ciId,
        brandId,
        pool,
        producer,
        apiClient,
        saltHex,
        cursorConfig,
      });
      totalEmitted += emitted;
    } catch (err) {
      log.error(`connector=${ciId} cursor=${cursorConfig.resource} error`, { err: err });
      // Non-fatal: one cursor failure doesn't abort the other cursors
    }
  }

  await setSyncState(pool, brandId, ciId, 'connected', null);
  // Recovery edge: self-heal a prior TokenExpired/RateLimited badge on success (no-op otherwise).
  await recoverConnectorInstanceHealth(pool, brandId, ciId);
  log.info(`connector=${ciId} COMPLETED totalEmitted=${totalEmitted}`);
}

// ── Per-cursor resource re-pull ───────────────────────────────────────────────

interface CursorRepullParams {
  ciId: string;
  brandId: string;
  pool: Pool;
  producer: Producer;
  apiClient: RazorpaySettlementsClient;
  saltHex: string;
  cursorConfig: typeof CURSOR_CONFIGS[number];
}

async function repullCursorResource(params: CursorRepullParams): Promise<number> {
  const { ciId, brandId, pool, producer, apiClient, saltHex, cursorConfig } = params;
  const { resource, windowMs, label } = cursorConfig;

  // ── FOR UPDATE SKIP LOCKED — overlap-lock on this cursor resource ─────────
  // A second concurrent trigger finds this row locked → SKIP (non-blocking).
  // One lock per resource (C6 — 3 independent locks per brand).
  const lockAcquired = await acquireCursorLock(pool, brandId, ciId, resource);
  if (!lockAcquired) {
    log.info(`connector=${ciId} cursor=${resource} — locked by another worker, skipping`);
    return 0;
  }

  // ── Read existing cursor high-water mark ─────────────────────────────────
  const priorCursorValue = await getCursorValue(pool, brandId, ciId, resource);

  const nowTs = Math.floor(Date.now() / 1000);
  const windowStartTs = nowTs - Math.floor(windowMs / 1000);

  // The cursor stores the Unix timestamp of the last processed settlement.
  // On first run (no cursor), use the window start.
  const fromTs = priorCursorValue ? Math.max(parseInt(priorCursorValue, 10), windowStartTs) : windowStartTs;
  const toTs = nowTs;

  log.info(`connector=${ciId} cursor=${resource} from=${fromTs} to=${toTs} (${label})`);

  // ── Page loop ─────────────────────────────────────────────────────────────
  // fetchReconWindowPages walks the DOCUMENTED recon query shape (year/month calendar buckets
  // across the window — see razorpay-settlements-client.ts) and yields only in-window items.
  let pageIndex = 0;
  let recordsProcessed = 0;
  let maxSettledAt: number | null = null;

  const pages = apiClient.fetchReconWindowPages(fromTs, toTs);
  while (true) {
    let next;
    try {
      next = await pages.next();
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith('RAZORPAY_AUTH_ERROR')) {
        log.error(`connector=${ciId} 401 auth error — aborting cursor=${resource}`);
        recordConnectorAuthRejected('razorpay'); // P2.6: make the silent token-expiry death loud
        await setSyncState(pool, brandId, ciId, 'error', '401 auth error — RECONNECT_REQUIRED');
        await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
        return recordsProcessed;
      }
      log.error(`connector=${ciId} cursor=${resource} page error`, { err: err });
      throw err;
    }

    if (next.done) break;
    const page = next.value;
    pageIndex += 1;
    if (page.items.length === 0) continue;

    // ── Per-item: map → settlement.live.v1 → emit ────────────────────────────
    const messages: Array<{ eventId: string; key: string; value: Buffer }> = [];
    for (const rawItem of page.items) {
      const mapped = mapSettlementItemToEvent(rawItem as RazorpaySettlementItem, brandId, saltHex);

      // Derive event_id from the mapped properties (mb-2 seeds use rawItem values pre-hash)
      const settlementId = rawItem.settlement_id ? String(rawItem.settlement_id) : '';
      const rawPaymentId = rawItem.payment_id ? String(rawItem.payment_id) : null;
      const entityType = mapped.properties.entity_type as SettlementEntityType;
      const isBrandLevel = mapped.properties.reconciliation_type === 'brand_level';

      let eventId: string;
      if (isBrandLevel || !rawPaymentId) {
        // brand_level path — use :summary: token (MB-2)
        eventId = uuidV5FromSettlementSummary(brandId, settlementId);
      } else {
        // per-order path — use entityType discriminator (MB-2)
        eventId = uuidV5FromSettlementItem(brandId, settlementId, rawPaymentId, entityType);
      }

      const envelope = CollectorEventV1Schema.parse({
        schema_version: '1',
        event_id: eventId,
        brand_id: brandId,          // from fn result (MT-1) — never from API response
        correlation_id: `razorpay-repull:${ciId}:${eventId}`,
        event_name: SETTLEMENT_LIVE_V1_EVENT_NAME,
        occurred_at: mapped.occurred_at,
        ingested_at: new Date().toISOString(),
        properties: mapped.properties as unknown as Record<string, unknown>,
      });

      messages.push({
        eventId,
        key: buildPartitionKey(brandId, eventId),
        value: Buffer.from(JSON.stringify(envelope)),
      });

      // Track max settled_at for cursor high-water advancement
      const settledAtRaw = rawItem.settled_at;
      if (settledAtRaw != null) {
        const settledAtTs = typeof settledAtRaw === 'number'
          ? settledAtRaw
          : parseInt(String(settledAtRaw), 10);
        if (!isNaN(settledAtTs) && (maxSettledAt === null || settledAtTs > maxSettledAt)) {
          maxSettledAt = settledAtTs;
        }
      }

      recordsProcessed++;
    }

    // ADR-0012 ingest dedup gate: drop event_ids already ingested for this brand BEFORE producing,
    // so a re-pull/backfill overlap never re-floods Bronze. brand GUC set on a short pooled client,
    // then filter+mark. ORDER IS CRITICAL: produce FIRST, mark AFTER (a crash between at worst
    // re-produces a dup on retry, which Silver backstops — never loses an event).
    let emittedThisPage = 0;
    if (messages.length > 0) {
      const dedupClient = await pool.connect();
      try {
        await dedupClient.query(buildContextGucSql({ brandId, correlationId: '' }));
        const unseen = await filterUnseenEventIds(dedupClient, brandId, messages.map((m) => m.eventId));

        const toSend = messages.filter((m) => unseen.has(m.eventId));
        const dropped = messages.length - toSend.length;
        if (dropped > 0) {
          incrementCounter('ingest_dedup_dropped_total', { provider: 'razorpay' });
          log.info(`connector=${ciId} cursor=${resource} dedup: dropped ${dropped} already-ingested events`);
        }

        if (toSend.length > 0) {
          // OTel trace-context propagation (OBS-1/OBS-2): stamp traceparent on each
          // message so the bronze-bridge consumer resumes this repull's trace.
          const traceHeaders: Record<string, Buffer | string> = {};
          injectKafkaTraceContext(traceHeaders);
          await producer.send({
            topic: LIVE_TOPIC,
            messages: toSend.map((m) => ({ key: m.key, value: m.value, headers: traceHeaders })),
          });
          await markEventIdsSeen(dedupClient, brandId, toSend.map((m) => m.eventId));
          emittedThisPage = toSend.length;
        }
      } finally {
        dedupClient.release();
      }
    }
    log.info(`connector=${ciId} cursor=${resource} page=${pageIndex} emitted=${emittedThisPage} total=${recordsProcessed}`);

    // ── Advance cursor after each page (checkpoint) ──────────────────────────
    if (maxSettledAt !== null) {
      await upsertCursorValue(pool, brandId, ciId, resource, String(maxSettledAt));
    }
  }

  log.info(`connector=${ciId} cursor=${resource} DONE records=${recordsProcessed}`);

  return recordsProcessed;
}

// ── Sync status (mirrors shopify-repull/run.ts setSyncState exactly) ──────────

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
    await client.query(buildContextGucSql({ brandId, correlationId: '' }));
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

// ── Credentials resolver (dev: env vars; prod: AWS Secrets Manager via JSON bundle) ──

export async function resolveRazorpayCredentials(secretRef: string): Promise<RazorpayApiCredentials | null> {
  // The secret is a JSON bundle {key_id, key_secret, webhook_secret} (C2 — three creds in one
  // secret_ref, independently rotatable). NEVER log the returned credentials (I-S09).

  // ── PROD: read the bundle from AWS Secrets Manager via the shared @brain/connector-secrets
  //    AwsSecretsManager — the SAME implementation the connect path wrote it with (#75). This is
  //    the previously-missing prod path that blocked real settlement re-pull. getSecret resolves the
  //    ARN; decryption is IAM/CMK-gated (no kmsKeyId needed for a read). Dynamic import keeps the
  //    AWS SDK out of the dev path. Fail-closed: a missing/partial bundle returns null (RECONNECT),
  //    NEVER fabricated creds.
  if (process.env['NODE_ENV'] === 'production') {
    const { AwsSecretsManager } = await import('@brain/connector-secrets');
    const region = process.env['BRAIN_AWS_REGION'] ?? 'us-east-1';
    const mgr = new AwsSecretsManager(region, '', process.env['CONNECTOR_SECRETS_KMS_KEY_ID'] ?? '');
    const bundle = await mgr.getSecret(secretRef);
    if (bundle?.['key_id'] && bundle?.['key_secret']) {
      return { keyId: bundle['key_id'], keySecret: bundle['key_secret'] };
    }
    return null;
  }

  // ── DEV: read from dev_secret table (same convention as WorkerLocalSecretsManager), env fallback.
  const { Pool: PgPool } = await import('pg');
  const devPool = new PgPool({
    connectionString: process.env['BRAIN_APP_DATABASE_URL'] ?? process.env['DATABASE_URL'],
    max: 1,
  });

  try {
    const name = secretRef.split(':secret:')[1] ?? secretRef;
    const res = await devPool.query<{ secret_value: string }>(
      `SELECT secret_value FROM dev_secret WHERE name = $1`,
      [name],
    );

    const raw = res.rows[0]?.secret_value;
    if (raw) {
      try {
        const bundle = JSON.parse(raw) as RazorpaySecretBundle;
        if (bundle.key_id && bundle.key_secret) {
          return { keyId: bundle.key_id, keySecret: bundle.key_secret };
        }
      } catch {
        // Malformed bundle — fall through
      }
    }

    // Dev env-var fallback: RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET
    const envKeyId = process.env['RAZORPAY_KEY_ID'];
    const envKeySecret = process.env['RAZORPAY_KEY_SECRET'];
    if (envKeyId && envKeySecret) {
      return { keyId: envKeyId, keySecret: envKeySecret };
    }

    return null;
  } finally {
    await devPool.end();
  }
}

// ── Entrypoint (MB-6: dev trigger) ───────────────────────────────────────────

if (
  process.argv[1]?.endsWith('run.ts') ||
  process.argv[1]?.endsWith('run.js')
) {
  const ciArg = process.argv[2]; // optional: connector_instance_id (dev trigger, MB-6)
  run(ciArg).catch((err) => {
    log.error('fatal', { err: err });
    process.exit(1);
  });
}

export {
  enumerateConnectors,
  setSyncState,
  CURSOR_CONFIGS,
};
