/**
 * shopify-backfill/run.ts — Shopify order history backfill worker.
 *
 * Mirrors the revenue-finalization.ts pattern: standalone Node.js job invoked as
 *   node dist/jobs/shopify-backfill/run.js
 * No new deployable — runs within the stream-worker deployable (D-1 / I-E05).
 *
 * State machine (§5 architecture-plan):
 *   queued → [claim: running] → page loop → [completed | partial | failed]
 *
 * Page loop (D-14):
 *   countOrders(created_at_min=2Y-ago) → estimated_total (null on failure, D-8/HP-1)
 *   while next page:
 *     fetchOrdersPage(sinceId, createdAtMin, limit=250)
 *     per order: map → emit to backfill topic (D-4: direct Kafka, not collector HTTP)
 *     update cursor + progress after EACH page (D-14 checkpoint)
 *     on 429: fetchOrdersPage retries internally (IR-2)
 *     on 401: mark failed + checkpoint cursor (SP-3)
 *   compute achieved_depth_label → finalize completed
 *
 * Brand isolation:
 *   brand_id from connector_instance.brand_id (never from Shopify — MT-1)
 *   All DB writes under set_config('app.current_brand_id', brand_id, true)
 *   All emitted events carry brand_id (asserted from connector, not Shopify)
 *
 * PII:
 *   Raw customer.email/phone hashed at order-mapper boundary (D-10 / I-S02)
 *   Token NEVER logged (I-S09)
 *
 * Replayability:
 *   event_id = uuidV5FromOrderBackfill(brand_id, shopify_order_id) — deterministic (D-5)
 *   Bronze: ON CONFLICT DO NOTHING (idempotent re-run — I-ST04)
 *   cursor_value persisted after each page — mid-run crash is recoverable
 */

import { Pool } from 'pg';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { Kafka, Producer } from 'kafkajs';
import { buildPartitionKey } from '@brain/events';
import { SaltProvider, LocalSecretsProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { resolveSaltHex } from '@brain/identity-core';
import { PgBackfillJobRepository } from '../../infrastructure/pg/BackfillJobRepository.js';
import { ORDER_BACKFILL_V1_TOPIC_SUFFIX, CollectorEventV1Schema } from '@brain/contracts';
import { ShopifyBackfillClient } from './shopify-paged-client.js';
import { mapOrderToBackfillEvent, computeAchievedDepthLabel } from './order-mapper.js';
import { uuidV5FromOrderBackfill } from './uuid-utils.js';
import { buildWorkerSecretsManager } from './worker-secrets.js';
import { log } from "../../log.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const ENV = process.env['APP_ENV'] ?? 'dev';
const BACKFILL_TOPIC = `${ENV}.${ORDER_BACKFILL_V1_TOPIC_SUFFIX}`;

/** 24-month backfill window in milliseconds (D-8 / D-14) */
const BACKFILL_WINDOW_MS = 24 * 30 * 24 * 60 * 60 * 1000;

/** Poll interval for queued jobs (D-2: worker polls, no spawn() from web process) */
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_CYCLES = 1; // for this invocation: process one job run then exit

interface ConnectorRow {
  brand_id: string;
  shop_domain: string;
  secret_ref: string;
  currency_code: string;
}

/**
 * Main entry point.
 * Invoked as: node dist/jobs/shopify-backfill/run.js [connector_instance_id]
 *
 * If connector_instance_id is passed as argv[2], process that specific connector.
 * Otherwise, poll for the first queued job across all connectors.
 *
 * Exits 0 on completion (no job found or job terminal), 1 on fatal error.
 */
export async function run(connectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });
  const kafka = new Kafka({ clientId: 'shopify-backfill-worker', brokers: BROKERS, retry: { retries: 5 } });
  const producer = kafka.producer({ idempotent: true });
  const jobRepo = new PgBackfillJobRepository(DB_URL);

  // Worker-side secrets manager (ADR-BF-11: separate process from core)
  const workerSecrets = buildWorkerSecretsManager();

  // SaltProvider for PII hashing (same convention as identity bridge)
  const saltSecrets = new LocalSecretsProvider();
  const saltProvider = new SaltProvider(saltSecrets, resolveSaltHex);

  try {
    await producer.connect();
    log.info(`starting — topic=${BACKFILL_TOPIC} brokers=${BROKERS.join(',')}`);

    // Poll for queued job
    let found = false;
    for (let cycle = 0; cycle < MAX_POLL_CYCLES; cycle++) {
      // Find a queued job (either for a specific connector or the oldest queued one)
      const queuedJob = await findQueuedJob(pool, connectorInstanceId);
      if (!queuedJob) {
        log.info('no queued jobs found — exiting');
        break;
      }

      found = true;
      const { jobId, brandId, ciId } = queuedJob;

      log.info(`found queued job=${jobId} brand=${brandId} connector=${ciId}`);

      // Claim the job: queued → running (FOR UPDATE SKIP LOCKED, D-9)
      const claimedJob = await jobRepo.claimQueued(ciId, brandId);
      if (!claimedJob) {
        log.info(`job=${jobId} was claimed by another worker — skipping`);
        continue;
      }

      // Load connector_instance details (brand GUC enforced)
      const connectorRow = await loadConnectorInstance(pool, ciId, brandId);
      if (!connectorRow) {
        await jobRepo.finalize({
          jobId,
          brandId,
          status: 'failed',
          achievedDepthLabel: null,
          failureReason: 'CONNECTOR_NOT_FOUND',
          recordsProcessed: 0n,
          cursorValue: null,
        });
        log.error(`connector_instance ${ciId} not found for brand ${brandId}`);
        continue;
      }

      // Worker-side token resolution (ADR-BF-11 cross-process)
      const accessToken = await workerSecrets.getShopifyToken(connectorRow.secret_ref);
      if (!accessToken) {
        // null → RECONNECT_REQUIRED (D-7 / ADR-BF-11 / SP-3)
        await jobRepo.finalize({
          jobId,
          brandId,
          status: 'failed',
          achievedDepthLabel: null,
          failureReason: 'RECONNECT_REQUIRED',
          recordsProcessed: 0n,
          cursorValue: claimedJob.cursor_value,  // preserve cursor for resume
        });
        recordConnectorAuthRejected('shopify'); // P2.6: make the silent token-loss death loud
        log.error(`job=${jobId} — token not found (RECONNECT_REQUIRED)`);
        continue;
      }

      // Fetch per-brand salt for PII hashing (hard-crash on failure — D-2)
      let saltHex: string;
      try {
        saltHex = await saltProvider.saltHexForBrand(brandId);
      } catch (saltErr) {
        await jobRepo.finalize({
          jobId,
          brandId,
          status: 'failed',
          achievedDepthLabel: null,
          failureReason: `SALT_FETCH_FAILED: ${String(saltErr).slice(0, 200)}`,
          recordsProcessed: 0n,
          cursorValue: claimedJob.cursor_value,
        });
        log.error(`salt fetch failed for brand=${brandId}`, { err: saltErr });
        continue;
      }

      // Execute the page loop
      await runBackfillLoop({
        jobId,
        brandId,
        connectorInstanceId: ciId,
        connectorRow,
        accessToken,
        saltHex,
        resumeSinceId: claimedJob.cursor_value,
        producer,
        jobRepo,
        pool,
      });
    }

    if (!found) {
      log.info('no work to do — exiting cleanly');
    }
  } finally {
    await producer.disconnect();
    await pool.end();
    await jobRepo.end();
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface QueuedJobInfo {
  jobId: string;
  brandId: string;
  ciId: string;
}

/**
 * Find a queued job for a specific connector, or any queued job (for poll mode).
 *
 * SEC-BF-H1 FIX (0023): Uses the brain_app pool + the SECURITY DEFINER fn
 * list_queued_backfill_jobs() for enumeration. At poll time no brand GUC is
 * known (we are discovering WHICH brand to work for), so a bare SELECT on
 * backfill_job under FORCE RLS returns 0 rows always (two-arg fail-closed:
 * missing GUC → NULL → FALSE for every row). The SECURITY DEFINER fn runs
 * as the migration owner (superuser 'brain'), bypasses FORCE RLS for this
 * enumeration step only, and returns ONLY dispatch metadata:
 *   (id, brand_id, connector_instance_id) — no tenant data content.
 * brain_app holds EXECUTE (granted in migration 0023).
 *
 * The brand_id from the fn result is the authority for all subsequent GUC
 * calls — never from env or Shopify (MT-1). GUC is set BEFORE any
 * brand-scoped read/write (claimQueued, loadConnectorInstance, LedgerWriter).
 */
async function findQueuedJob(
  pool: Pool,
  connectorInstanceId?: string,
): Promise<QueuedJobInfo | null> {
  // Call the SECURITY DEFINER enumeration fn (no GUC needed — fn bypasses RLS).
  // Returns rows ordered by created_at ASC (see 0023); filter by connectorInstanceId
  // if specified, otherwise take the first (oldest queued) job across all brands.
  let result;
  if (connectorInstanceId) {
    result = await pool.query<{ id: string; brand_id: string; connector_instance_id: string }>(
      `SELECT id, brand_id, connector_instance_id
       FROM list_queued_backfill_jobs()
       WHERE connector_instance_id = $1
       LIMIT 1`,
      [connectorInstanceId],
    );
  } else {
    result = await pool.query<{ id: string; brand_id: string; connector_instance_id: string }>(
      `SELECT id, brand_id, connector_instance_id
       FROM list_queued_backfill_jobs()
       LIMIT 1`,
    );
  }

  const row = result.rows[0];
  if (!row) return null;
  return { jobId: row.id, brandId: row.brand_id, ciId: row.connector_instance_id };
}

async function loadConnectorInstance(
  pool: Pool,
  connectorInstanceId: string,
  brandId: string,
): Promise<ConnectorRow | null> {
  // SEC-BF-H1 FIX: connector_instance has FORCE RLS under brain_app.
  // Must set the brand GUC before querying — brand_id comes from the
  // list_queued_backfill_jobs() fn result (MT-1: never from env or Shopify).
  // Sentinel uuid (all-zero) for the user-context GUCs. The `brand` table's brand_self_read RLS
  // policy casts app.current_user_id / app.current_workspace_id to uuid; this worker is a SYSTEM
  // job with NO user context, and a pooled connection can carry a stale EMPTY STRING that ''::uuid
  // rejects ("invalid input syntax for type uuid"). A valid zero-uuid satisfies the cast while the
  // membership subquery matches nothing — so only brand_isolation (app.current_brand_id) governs
  // access. NOTE: txn-local GUCs (true) only apply WITHIN a transaction, so we wrap in BEGIN/COMMIT
  // (the original code set them outside a txn, so they never reached the SELECT).
  const NIL_UUID = '00000000-0000-0000-0000-000000000000';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );
    const result = await client.query<ConnectorRow>(
      `SELECT ci.brand_id, ci.shop_domain, ci.secret_ref,
              COALESCE(b.currency_code, 'INR') AS currency_code
       FROM connector_instance ci
       JOIN brand b ON b.id = ci.brand_id
       WHERE ci.id = $1 AND ci.brand_id = $2`,
      [connectorInstanceId, brandId],
    );
    await client.query('COMMIT');
    return result.rows[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface BackfillLoopParams {
  jobId: string;
  brandId: string;
  connectorInstanceId: string;
  connectorRow: ConnectorRow;
  accessToken: string;
  saltHex: string;
  resumeSinceId: string | null;
  producer: Producer;
  jobRepo: PgBackfillJobRepository;
  pool: Pool;
}

async function runBackfillLoop(params: BackfillLoopParams): Promise<void> {
  const {
    jobId, brandId, connectorRow, accessToken, saltHex,
    resumeSinceId, producer, jobRepo, pool,
  } = params;

  const shopClient = new ShopifyBackfillClient(connectorRow.shop_domain, accessToken);

  // 24-month lower bound for the backfill window (D-8 / D-14)
  const createdAtMin = new Date(Date.now() - BACKFILL_WINDOW_MS).toISOString();

  // ── D-8: count orders before first page (HP-1: null on failure, never fabricate) ──
  let estimatedTotal: bigint | null = null;
  const countResult = await shopClient.countOrders(createdAtMin);
  if (countResult !== null) {
    estimatedTotal = BigInt(countResult);
  }
  log.info(`job=${jobId} estimated_total=${estimatedTotal ?? 'null (count failed)'}`);

  // Brand region for phone normalization (default IN for M1)
  const regionCode = 'IN';

  let sinceId: string | null = resumeSinceId;
  let recordsProcessed = 0n;
  let oldestOccurredAt: Date | null = null;
  let pageCount = 0;

  const POLL_SLEEP_MS = parseInt(process.env['BACKFILL_PAGE_SLEEP_MS'] ?? '0', 10);

  try {
    while (true) {
      pageCount++;
      log.info(`job=${jobId} page=${pageCount} sinceId=${sinceId ?? 'null'}`);

      let page;
      try {
        page = await shopClient.fetchOrdersPage(sinceId, createdAtMin);
      } catch (err) {
        const msg = String(err);
        if (msg.startsWith('SHOPIFY_AUTH_ERROR')) {
          // 401 → fail + checkpoint (SP-3)
          await jobRepo.finalize({
            jobId,
            brandId,
            status: 'failed',
            achievedDepthLabel: null,
            failureReason: 'SHOPIFY_AUTH_ERROR',
            recordsProcessed,
            cursorValue: sinceId,
          });
          recordConnectorAuthRejected('shopify'); // P2.6: make the silent token-expiry death loud
          log.error(`job=${jobId} 401 auth error — marked failed`);
          return;
        }
        // Other page error — mark partial (cursor preserved) and exit
        await jobRepo.finalize({
          jobId,
          brandId,
          status: 'partial',
          achievedDepthLabel: null,
          failureReason: `PAGE_ERROR: ${msg.slice(0, 200)}`,
          recordsProcessed,
          cursorValue: sinceId,
        });
        log.error(`job=${jobId} page error — marked partial`, { err: err });
        return;
      }

      if (page.orders.length === 0) {
        // No orders on this page → done
        break;
      }

      // ── Per-order: map → emit ──────────────────────────────────────────────
      const messages = [];
      for (const order of page.orders) {
        const mapped = mapOrderToBackfillEvent(order, saltHex, regionCode);

        // Deterministic event_id (D-5 / ADR-BF-2)
        const eventId = uuidV5FromOrderBackfill(brandId, String(order.id));

        // Build the full CollectorEventV1 envelope
        const envelope = CollectorEventV1Schema.parse({
          schema_version: '1',
          event_id: eventId,
          brand_id: brandId,   // from connector_instance, never from Shopify (MT-1 / ADR-BF-13)
          correlation_id: `backfill:${jobId}:${eventId}`,
          event_name: mapped.event_name,
          occurred_at: mapped.occurred_at,  // D-6: processed_at ?? created_at, NOT NOW()
          ingested_at: new Date().toISOString(),
          properties: mapped.properties as unknown as Record<string, unknown>,
        });

        messages.push({
          key: buildPartitionKey(brandId, eventId),
          value: Buffer.from(JSON.stringify(envelope)),
        });

        // Track oldest occurred_at for achieved_depth_label (HP-3)
        const occurredAt = new Date(mapped.occurred_at);
        if (!oldestOccurredAt || occurredAt < oldestOccurredAt) {
          oldestOccurredAt = occurredAt;
        }

        recordsProcessed += 1n;
      }

      // ── D-4: Emit directly to Redpanda (not via collector HTTP edge) ──────
      await producer.send({
        topic: BACKFILL_TOPIC,
        messages,
      });

      log.info(`job=${jobId} page=${pageCount} emitted=${messages.length} total=${recordsProcessed}`);

      // ── D-14: Update cursor + progress after EACH page ────────────────────
      // sinceId for resume = last order's ID on this page
      const lastOrder = page.orders[page.orders.length - 1];
      const newSinceId = lastOrder ? String(lastOrder.id) : sinceId;

      await jobRepo.updateProgress({
        jobId,
        brandId,
        recordsProcessed,
        estimatedTotal,
        cursorValue: newSinceId ?? '',
        cursorDate: oldestOccurredAt ?? new Date(),
      });

      // Also update connector_cursor (watermark for resume, D-14)
      await upsertConnectorCursor(pool, {
        brandId,
        connectorInstanceId: params.connectorInstanceId,
        resource: 'orders',
        cursorValue: newSinceId ?? '',
      });

      sinceId = page.nextSinceId;

      if (sinceId === null) {
        // No next page — done
        break;
      }

      // Optional rate-limit courtesy sleep between pages (avoid 429 storms)
      if (POLL_SLEEP_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_SLEEP_MS));
      }
    }

    // ── Terminal: completed ───────────────────────────────────────────────────
    const depthLabel = oldestOccurredAt
      ? computeAchievedDepthLabel(oldestOccurredAt, BACKFILL_WINDOW_MS)
      : null;

    await jobRepo.finalize({
      jobId,
      brandId,
      status: 'completed',
      achievedDepthLabel: depthLabel,
      failureReason: null,
      recordsProcessed,
      cursorValue: sinceId,
    });

    // Reflect that data is now flowing: the dashboard Connection Status reads
    // connector_sync_status, which sat at 'waiting_for_data' since connect. On a successful
    // backfill with records, transition it to 'connected' + stamp last_sync_at. Updated under the
    // brand GUC (txn-local); connector_sync_status RLS only needs app.current_brand_id.
    if (recordsProcessed > 0n) {
      const sc = await pool.connect();
      try {
        await sc.query('BEGIN');
        await sc.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
        await sc.query(
          `UPDATE connector_sync_status
             SET state = 'connected', last_sync_at = NOW(), last_error = NULL, updated_at = NOW()
           WHERE brand_id = $1 AND connector_instance_id = $2`,
          [brandId, params.connectorInstanceId],
        );
        await sc.query('COMMIT');
      } catch (e) {
        await sc.query('ROLLBACK').catch(() => undefined);
        log.error(`job=${jobId} connector_sync_status update failed`, { detail: e });
      } finally {
        sc.release();
      }
    }

    log.info(`job=${jobId} COMPLETED records=${recordsProcessed} depth="${depthLabel}"`);
  } catch (err) {
    // Unexpected error — mark partial (cursor preserved in jobRepo state)
    await jobRepo.finalize({
      jobId,
      brandId,
      status: 'partial',
      achievedDepthLabel: null,
      failureReason: `UNEXPECTED: ${String(err).slice(0, 200)}`,
      recordsProcessed,
      cursorValue: sinceId,
    }).catch(() => undefined);
    log.error(`job=${jobId} unexpected error`, { err: err });
    throw err;
  }
}

interface ConnectorCursorParams {
  brandId: string;
  connectorInstanceId: string;
  resource: string;
  cursorValue: string;
}

async function upsertConnectorCursor(pool: Pool, params: ConnectorCursorParams): Promise<void> {
  // Note: connector_cursor has FORCE RLS — must set GUC first
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [params.brandId]);
    await client.query(
      `INSERT INTO connector_cursor (brand_id, connector_instance_id, resource, cursor_value, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT ON CONSTRAINT connector_cursor_upsert_key
       DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()`,
      [params.brandId, params.connectorInstanceId, params.resource, params.cursorValue],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Non-fatal: log but don't abort the backfill — progress is still tracked in backfill_job
    log.error(`connector_cursor upsert failed (non-fatal)`, { err: err });
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

export { runBackfillLoop, findQueuedJob, upsertConnectorCursor };
