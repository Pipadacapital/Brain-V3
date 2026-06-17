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
import { Kafka, Producer } from 'kafkajs';
import { buildPartitionKey } from '@brain/events';
import { SaltProvider, LocalSecretsProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { PgBackfillJobRepository } from '../../infrastructure/pg/BackfillJobRepository.js';
import { ORDER_BACKFILL_V1_TOPIC_SUFFIX, CollectorEventV1Schema } from '@brain/contracts';
import { ShopifyBackfillClient } from './shopify-paged-client.js';
import { mapOrderToBackfillEvent, computeAchievedDepthLabel } from './order-mapper.js';
import { uuidV5FromOrderBackfill } from './uuid-utils.js';
import { buildWorkerSecretsManager } from './worker-secrets.js';

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
  const producer = kafka.producer();
  const jobRepo = new PgBackfillJobRepository(DB_URL);

  // Worker-side secrets manager (ADR-BF-11: separate process from core)
  const workerSecrets = buildWorkerSecretsManager();

  // SaltProvider for PII hashing (same convention as identity bridge)
  const saltSecrets = new LocalSecretsProvider();
  const saltProvider = new SaltProvider(
    saltSecrets,
    (brandId: string) => {
      const envKey = `IDENTITY_SALT_${brandId.replace(/-/g, '').toUpperCase()}`;
      return process.env[envKey] ?? '';
    },
  );

  try {
    await producer.connect();
    console.info(`[shopify-backfill] starting — topic=${BACKFILL_TOPIC} brokers=${BROKERS.join(',')}`);

    // Poll for queued job
    let found = false;
    for (let cycle = 0; cycle < MAX_POLL_CYCLES; cycle++) {
      // Find a queued job (either for a specific connector or the oldest queued one)
      const queuedJob = await findQueuedJob(pool, connectorInstanceId);
      if (!queuedJob) {
        console.info('[shopify-backfill] no queued jobs found — exiting');
        break;
      }

      found = true;
      const { jobId, brandId, ciId } = queuedJob;

      console.info(`[shopify-backfill] found queued job=${jobId} brand=${brandId} connector=${ciId}`);

      // Claim the job: queued → running (FOR UPDATE SKIP LOCKED, D-9)
      const claimedJob = await jobRepo.claimQueued(ciId, brandId);
      if (!claimedJob) {
        console.info(`[shopify-backfill] job=${jobId} was claimed by another worker — skipping`);
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
        console.error(`[shopify-backfill] connector_instance ${ciId} not found for brand ${brandId}`);
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
        console.error(`[shopify-backfill] job=${jobId} — token not found (RECONNECT_REQUIRED)`);
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
        console.error(`[shopify-backfill] salt fetch failed for brand=${brandId}`, saltErr);
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
      console.info('[shopify-backfill] no work to do — exiting cleanly');
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
 * Uses the superuser pool for enumeration (the job table brand GUC is set per-query).
 */
async function findQueuedJob(
  pool: Pool,
  connectorInstanceId?: string,
): Promise<QueuedJobInfo | null> {
  let result;
  if (connectorInstanceId) {
    result = await pool.query<{ id: string; brand_id: string; connector_instance_id: string }>(
      `SELECT id, brand_id, connector_instance_id
       FROM backfill_job
       WHERE connector_instance_id = $1 AND status = 'queued'
       ORDER BY created_at ASC
       LIMIT 1`,
      [connectorInstanceId],
    );
  } else {
    result = await pool.query<{ id: string; brand_id: string; connector_instance_id: string }>(
      `SELECT id, brand_id, connector_instance_id
       FROM backfill_job
       WHERE status = 'queued'
       ORDER BY created_at ASC
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
  // Need brand context from the brand table for currency_code
  const result = await pool.query<ConnectorRow>(
    `SELECT ci.brand_id, ci.shop_domain, ci.secret_ref,
            COALESCE(b.currency_code, 'INR') AS currency_code
     FROM connector_instance ci
     JOIN brand b ON b.id = ci.brand_id
     WHERE ci.id = $1 AND ci.brand_id = $2`,
    [connectorInstanceId, brandId],
  );
  return result.rows[0] ?? null;
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
  console.info(
    `[shopify-backfill] job=${jobId} estimated_total=${estimatedTotal ?? 'null (count failed)'}`,
  );

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
      console.info(
        `[shopify-backfill] job=${jobId} page=${pageCount} sinceId=${sinceId ?? 'null'}`,
      );

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
          console.error(`[shopify-backfill] job=${jobId} 401 auth error — marked failed`);
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
        console.error(`[shopify-backfill] job=${jobId} page error — marked partial`, err);
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
          properties: mapped.properties as Record<string, unknown>,
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

      console.info(
        `[shopify-backfill] job=${jobId} page=${pageCount} emitted=${messages.length} total=${recordsProcessed}`,
      );

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

    console.info(
      `[shopify-backfill] job=${jobId} COMPLETED records=${recordsProcessed} depth="${depthLabel}"`,
    );
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
    console.error(`[shopify-backfill] job=${jobId} unexpected error`, err);
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
    console.error(`[shopify-backfill] connector_cursor upsert failed (non-fatal)`, err);
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
    console.error('[shopify-backfill] fatal', err);
    process.exit(1);
  });
}

export { runBackfillLoop, findQueuedJob, upsertConnectorCursor };
