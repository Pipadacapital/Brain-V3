/**
 * meta-spend-repull/run.ts — Meta Ads trailing-window spend re-pull (ADR-AD-3 / ADR-AD-7).
 *
 * Mirrors razorpay-settlement-repull/run.ts pattern EXACTLY:
 *   1. enumerate via list_ad_connectors_for_spend_repull() — SECURITY DEFINER, NO GUC at
 *      enumerate time (durable rule: system-job-force-rls-enumeration).
 *   2. GUC set AFTER enumerate, before any brand-scoped read/write (MT-1). brand_id is from
 *      the fn result — NEVER from the Meta API response.
 *   3. ONE cursor resource `meta.insights` (28d trailing window). FOR UPDATE SKIP LOCKED
 *      overlap-lock. Cursor stores the high-water stat_date (ad spend is keyed by stat date,
 *      not a monotonic id).
 *   4. page over the Insights API (campaign/adset/ad levels), map via @brain/ad-spend-mapper,
 *      emit spend.live.v1 to the live lane (collector.event.v1 — NO new topic/envelope).
 *   5. advance cursor (high-water = max stat_date) after each page; sync_status syncing→connected.
 *
 * The re-pull only lands spend.live.v1 on the live lane. From there the Spark Bronze sink writes it
 * (server-trusted) to Bronze (Iceberg) → dbt projects silver_marketing_spend. Bronze is the SOLE
 * spend SoR; dedup is the deterministic spend event_id (uuidV5FromSpendRow) under the Bronze MERGE.
 * There is NO PostgreSQL spend ledger — ad spend is analytical, not operational state.
 *
 * Throttle (ADR-AD-7): META_RATE_LIMITED → mark health/error + abort this run (retry next run).
 * Tokens are NEVER logged (I-S09). brand_id ALWAYS from the fn result (MT-1).
 *
 * Dev trigger (ADR-AD-9): pass connector_instance_id as argv[2] to re-pull a single connector.
 */

import { Pool } from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import { createIdempotentProducer } from '../../infrastructure/kafka/idempotent-producer.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { updateConnectorInstanceHealth, recoverConnectorInstanceHealth } from '../../infrastructure/pg/ConnectorInstanceHealthRepository.js';
import { buildPartitionKey } from '@brain/events';
import { injectKafkaTraceContext } from '@brain/observability';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import { loadStreamWorkerConfig } from '@brain/config';
import { buildContextGucSql } from '@brain/db';
import {
  mapMetaInsightToEvent,
  uuidV5FromSpendRow,
  SPEND_LIVE_V1_EVENT_NAME,
  type AdSpendLevel,
} from '@brain/ad-spend-mapper';
import {
  MetaInsightsClient,
  META_AUTH_ERROR,
  META_RATE_LIMITED,
  type MetaApiCredentials,
  type MetaBreakdownName,
} from './meta-insights-client.js';
import { log } from "../../log.js";
import { acquireCursorLock, getCursorValue, upsertCursorValue } from '../../infrastructure/pg/CursorRepository.js';

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;
const BROKERS = cfg.KAFKA_BROKERS.split(',');
// intentional raw: NODE_ENV-derived Kafka topic-prefix selection (must precede config load).
const ENV = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
const LIVE_TOPIC = `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

/** Single cursor resource (ADR-AD-3): meta.insights, 28d trailing window. */
const CURSOR_RESOURCE = 'meta.insights' as const;
const WINDOW_DAYS = 28;

/**
 * A2 — 2-year historical backfill lane (the review's HIGH "no 730-day history" finding).
 *
 * A SEPARATE cursor resource (`meta.insights.backfill`) walking BACKWARD from today in bounded
 * monthly chunks to 730 days, RESUMABLE across runs (mirrors the ingestion-backfill framework's
 * resumable/chunked/bounded-per-run contract) and DEDUPED against the 28-day trailing repull —
 * both lanes reuse the SAME mapper + the SAME deterministic uuidV5FromSpendRow event_id, so an
 * overlapping day MERGE-dedups in Bronze (no double-count). The async ad_report_run path is forced
 * (large historical pulls). Steady-state polling keeps WINDOW_DAYS=28 unchanged.
 *
 * Cursor semantics: stores the EARLIEST stat_date already covered (the `since` floor reached so far).
 * Absent → start at today. Each run processes up to BACKFILL_MAX_CHUNKS_PER_RUN monthly chunks then
 * checkpoints; the next run resumes from the persisted floor. Reaching the 730-day floor = completed
 * (later runs are an instant no-op).
 */
const BACKFILL_CURSOR_RESOURCE = 'meta.insights.backfill' as const;
const BACKFILL_TOTAL_DAYS = 730;
const BACKFILL_CHUNK_DAYS = 30;
/** Per-run monthly-chunk budget (keeps a run bounded; the resumable cursor carries the rest forward).
 *  Override via META_BACKFILL_CHUNKS_PER_RUN (clamped 1..24). Default 3 ≈ 90 days per run. */
function backfillChunksPerRun(): number {
  // intentional raw: optional per-run chunk budget; not in the typed config schema.
  const raw = process.env['META_BACKFILL_CHUNKS_PER_RUN'];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(parsed, 1), 24) : 3;
}

/** The hierarchy levels to pull (Meta Insights level param). */
const META_LEVELS: Array<'campaign' | 'adset' | 'ad'> = ['campaign', 'adset', 'ad'];

/**
 * FIREHOSE breakdown passes. `null` = the base grain (no `breakdowns=` param → base event_ids stay
 * byte-identical, zero re-dedup churn). Each non-null family runs as its OWN insights pass tagging each
 * row with its dimension value(s); the mapper folds those into breakdown_key so the dedup event_id keeps
 * base + every breakdown row distinct (never collide). The emit loop below is level × breakdown.
 */
const META_BREAKDOWN_PASSES: Array<MetaBreakdownName | null> = [
  null,
  'demographic',
  'geo',
  'placement',
  'hourly',
];

interface AdConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  provider: string;
  secret_ref: string;
  ad_account_id: string | null;
}

/** Dev secret bundle for a Meta connector. */
interface MetaSecretBundle {
  access_token: string;   // NEVER logged (I-S09)
  ad_account_id?: string;
}

export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({ clientId: 'meta-spend-repull', brokers: BROKERS, retry: { retries: 5 } });
  const producer = createIdempotentProducer(kafka);

  try {
    await producer.connect();
    log.info(`starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    const connectors = await enumerateConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('no connected meta connectors found — exiting');
      return;
    }
    log.info(`found ${connectors.length} connector(s) to re-pull`);

    for (const connector of connectors) {
      await repullConnector({ connector, pool, producer });
    }
  } finally {
    await producer.disconnect();
    await pool.end();
  }
}

// ── Enumerate (SECURITY DEFINER, NO GUC — durable rule) ──────────────────────

export async function enumerateConnectors(
  pool: Pool,
  targetConnectorInstanceId?: string,
): Promise<AdConnectorRow[]> {
  if (targetConnectorInstanceId) {
    const result = await pool.query<AdConnectorRow>(
      `SELECT connector_instance_id, brand_id, provider, secret_ref, ad_account_id
       FROM list_ad_connectors_for_spend_repull()
       WHERE connector_instance_id = $1 AND provider = 'meta'`,
      [targetConnectorInstanceId],
    );
    return result.rows;
  }
  const result = await pool.query<AdConnectorRow>(
    `SELECT connector_instance_id, brand_id, provider, secret_ref, ad_account_id
     FROM list_ad_connectors_for_spend_repull()
     WHERE provider = 'meta'`,
  );
  return result.rows;
}

// ── Per-connector re-pull ─────────────────────────────────────────────────────

interface RepullParams {
  connector: AdConnectorRow;
  pool: Pool;
  producer: Producer;
}

async function repullConnector(params: RepullParams): Promise<void> {
  const { connector, pool, producer } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = connector;

  log.info(`connector=${ciId} brand=${brandId}`);

  const creds = await resolveMetaCredentials(secretRef, connector.ad_account_id);
  if (!creds) {
    // FAIL LOUDLY (not a silent early-return): a missing/expired stored credential must surface as
    // RECONNECT_REQUIRED on the connector — otherwise the tile shows a stale 'connected' while spend
    // silently never ingests (the exact symptom seen in dev). setSyncState upserts, so the row is
    // created even if connect never wrote one. token_expired → TokenExpired/blocked (needs reconnect).
    log.error(`connector=${ciId} — credentials not found (RECONNECT_REQUIRED)`);
    recordConnectorAuthRejected('meta');
    await setSyncState(pool, brandId, ciId, 'error', 'meta credentials missing — RECONNECT_REQUIRED');
    await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
    return;
  }

  // GUC-after-enumerate (MT-1): brand_id authority = fn result. set sync state first.
  await setSyncState(pool, brandId, ciId, 'syncing', null);

  // Overlap-lock on the single cursor resource (FOR UPDATE SKIP LOCKED).
  const lockAcquired = await acquireCursorLock(pool, brandId, ciId, CURSOR_RESOURCE);
  if (!lockAcquired) {
    log.info(`connector=${ciId} — cursor locked by another worker, skipping`);
    return;
  }

  const client = new MetaInsightsClient(creds);

  let accountMeta;
  try {
    accountMeta = await client.fetchAccountMeta();
  } catch (err) {
    if (String(err).includes(META_AUTH_ERROR)) {
      recordConnectorAuthRejected('meta'); // P2.6: make the silent token-expiry death loud
      await setSyncState(pool, brandId, ciId, 'error', 'meta auth error — RECONNECT_REQUIRED');
      await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
      return;
    }
    if (String(err).includes(META_RATE_LIMITED)) {
      await setSyncState(pool, brandId, ciId, 'error', 'RateLimited — retry next run');
      await updateConnectorInstanceHealth(pool, brandId, ciId, 'rate_limited');
      return;
    }
    log.error(`connector=${ciId} account meta fetch failed`, { err: err });
    await setSyncState(pool, brandId, ciId, 'error', 'account meta fetch failed');
    return;
  }

  // Trailing 28d window. stat_date keyed (ADR-AD-3): cursor stores the max stat_date seen.
  const until = isoDate(new Date());
  const since = isoDate(addDays(new Date(), -WINDOW_DAYS));

  let totalEmitted = 0;
  let maxStatDate: string | null = null;

  // FIREHOSE: pull EVERY breakdown as its own insights pass (plus the base pass), across all levels.
  // The mapper tags each row with its breakdown dims + folds them into breakdown_key so the dedup
  // event_id keeps base + every breakdown distinct. A per-(breakdown,level) error is non-fatal.
  for (const breakdown of META_BREAKDOWN_PASSES) {
    for (const level of META_LEVELS) {
      const canonicalLevel: AdSpendLevel = level === 'adset' ? 'adset' : (level as AdSpendLevel);
      try {
        let pageUrlResult = await client.fetchInsightsFirstPage(level, since, until, { breakdown });
        while (true) {
          const { emitted, maxDate } = await emitPage({
            rows: pageUrlResult.rows,
            brandId,
            ciId,
            canonicalLevel,
            breakdown,
            accountCurrency: accountMeta.currencyCode,
            accountTz: accountMeta.timezoneName,
            producer,
            pool,
          });
          totalEmitted += emitted;
          if (maxDate && (maxStatDate === null || maxDate > maxStatDate)) maxStatDate = maxDate;

          // Checkpoint cursor after each page (high-water stat_date).
          if (maxStatDate) await upsertCursorValue(pool, brandId, ciId, CURSOR_RESOURCE, maxStatDate);

          if (!pageUrlResult.nextUrl) break;
          pageUrlResult = await client.fetchInsightsByUrl(pageUrlResult.nextUrl, level);
        }
      } catch (err) {
        if (String(err).includes(META_RATE_LIMITED)) {
          log.error(`connector=${ciId} RateLimited — aborting run (retry next)`);
          await setSyncState(pool, brandId, ciId, 'error', 'RateLimited — retry next run');
          await updateConnectorInstanceHealth(pool, brandId, ciId, 'rate_limited');
          return;
        }
        if (String(err).includes(META_AUTH_ERROR)) {
          recordConnectorAuthRejected('meta'); // P2.6: make the silent token-expiry death loud
          await setSyncState(pool, brandId, ciId, 'error', 'meta auth error — RECONNECT_REQUIRED');
          await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
          return;
        }
        log.error(`connector=${ciId} level=${level} breakdown=${breakdown ?? 'base'} page error`, { err: err });
        // Non-fatal per (breakdown,level) — continue to the next pass.
      }
    }
  }

  await setSyncState(pool, brandId, ciId, 'connected', null);
  // Recovery edge: self-heal a prior TokenExpired/RateLimited badge on success (no-op otherwise).
  await recoverConnectorInstanceHealth(pool, brandId, ciId);
  log.info(`connector=${ciId} COMPLETED totalEmitted=${totalEmitted}`);
}

// ── Page emit ─────────────────────────────────────────────────────────────────

interface EmitPageParams {
  rows: Array<Record<string, unknown>>;
  brandId: string;
  ciId: string;
  canonicalLevel: AdSpendLevel;
  breakdown: MetaBreakdownName | null;
  accountCurrency: string;
  accountTz: string | null;
  producer: Producer;
  pool: Pool;
}

async function emitPage(p: EmitPageParams): Promise<{ emitted: number; maxDate: string | null }> {
  if (p.rows.length === 0) return { emitted: 0, maxDate: null };

  const messages: Array<{ eventId: string; key: string; value: Buffer }> = [];
  let maxDate: string | null = null;

  for (const raw of p.rows) {
    const mapped = mapMetaInsightToEvent(raw, p.accountCurrency, p.accountTz);
    const props = mapped.properties;
    if (!props.stat_date || !props.level_id) continue; // skip rows missing the dedup grain

    // FIREHOSE: fold the row's breakdown dims (the mapper already canonicalized them into
    // props.breakdown_key — '' for the base pass) into the dedup event_id, so a base row and every
    // breakdown row at the same (brand,platform,statDate,level,levelId) mint DISTINCT ids and an
    // idempotent re-pull of the same breakdown row re-mints the same id → Silver MERGE dedups.
    const eventId = uuidV5FromSpendRow(
      p.brandId, 'meta', props.stat_date, props.level, props.level_id, props.breakdown_key ?? '',
    );

    const envelope = CollectorEventV1Schema.parse({
      schema_version: '1',
      event_id: eventId,
      brand_id: p.brandId,        // from fn result (MT-1) — never from API response
      correlation_id: `meta-spend-repull:${p.ciId}:${eventId}`,
      event_name: SPEND_LIVE_V1_EVENT_NAME,
      occurred_at: mapped.occurred_at,
      ingested_at: new Date().toISOString(),
      properties: props as unknown as Record<string, unknown>,
    });

    messages.push({ eventId, key: buildPartitionKey(p.brandId, eventId), value: Buffer.from(JSON.stringify(envelope)) });
    if (maxDate === null || props.stat_date > maxDate) maxDate = props.stat_date;
  }

  let emitted = 0;
  if (messages.length > 0) {
    // ADR-0015: produce unconditionally — the PG ingest-dedup gate is removed. event_id is
    // deterministic (uuidV5FromSpendRow), so a re-pull/backfill overlap re-mints the SAME
    // (brand_id, event_id) and is collapsed by Bronze compaction dedup + the Silver MERGE
    // (keep-latest also lands late spend restatements for the same grain).
    // OTel trace-context propagation (OBS-1/OBS-2): stamp traceparent on each
    // message so the bronze-bridge consumer resumes this repull's trace.
    const traceHeaders: Record<string, Buffer | string> = {};
    injectKafkaTraceContext(traceHeaders);
    await p.producer.send({
      topic: LIVE_TOPIC,
      messages: messages.map((m) => ({ key: m.key, value: m.value, headers: traceHeaders })),
    });
    emitted = messages.length;
    log.info(`connector=${p.ciId} level=${p.canonicalLevel} emitted=${emitted}`);
  }
  return { emitted, maxDate };
}

// ── A2: 2-year historical backfill lane (resumable, chunked, async, dedup-by-event_id) ──

/**
 * Run one bounded slice of the Meta 2-year backfill across all (or one) connected Meta connector(s).
 *
 * RESUMABLE: progress is the per-connector `meta.insights.backfill` cursor (the earliest stat_date
 * floor reached so far). Each invocation walks at most backfillChunksPerRun() monthly chunks further
 * back, checkpointing after each chunk, then returns — the next invocation resumes from the floor.
 * Reaching BACKFILL_TOTAL_DAYS = completed (instant no-op thereafter).
 *
 * DEDUP: identical mapper + uuidV5FromSpendRow → Bronze MERGE drops any day overlapping the trailing
 * repull. No new event_name/lane: it emits spend.live.v1 on the SAME live collector lane.
 */
export async function runBackfill(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({ clientId: 'meta-spend-backfill', brokers: BROKERS, retry: { retries: 5 } });
  const producer = createIdempotentProducer(kafka);

  try {
    await producer.connect();
    log.info(`[meta-backfill] starting — topic=${LIVE_TOPIC} totalDays=${BACKFILL_TOTAL_DAYS} chunkDays=${BACKFILL_CHUNK_DAYS}`);

    const connectors = await enumerateConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('[meta-backfill] no connected meta connectors found — exiting');
      return;
    }

    for (const connector of connectors) {
      await backfillConnector({ connector, pool, producer });
    }
  } finally {
    await producer.disconnect();
    await pool.end();
  }
}

async function backfillConnector(params: RepullParams): Promise<void> {
  const { connector, pool, producer } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = connector;

  const creds = await resolveMetaCredentials(secretRef, connector.ad_account_id);
  if (!creds) {
    log.error(`[meta-backfill] connector=${ciId} — credentials not found (RECONNECT_REQUIRED), skipping`);
    recordConnectorAuthRejected('meta');
    return;
  }

  // Overlap-lock on the BACKFILL cursor resource (distinct from the trailing-repull lock → the two
  // lanes never block each other, and two backfill runs cannot double-process the same connector).
  const lockAcquired = await acquireCursorLock(pool, brandId, ciId, BACKFILL_CURSOR_RESOURCE);
  if (!lockAcquired) {
    log.info(`[meta-backfill] connector=${ciId} — backfill cursor locked by another worker, skipping`);
    return;
  }

  const today = isoDate(new Date());
  const floor = isoDate(addDays(new Date(), -BACKFILL_TOTAL_DAYS));

  // Earliest stat_date already covered (the `since` floor reached so far). Absent → start at today.
  let reached = (await getCursorValue(pool, brandId, ciId, BACKFILL_CURSOR_RESOURCE)) ?? today;
  if (reached <= floor) {
    log.info(`[meta-backfill] connector=${ciId} — backfill COMPLETE (reached=${reached} floor=${floor})`);
    return;
  }

  const client = new MetaInsightsClient(creds);
  let accountMeta;
  try {
    accountMeta = await client.fetchAccountMeta();
  } catch (err) {
    log.error(`[meta-backfill] connector=${ciId} account meta fetch failed — retry next run`, { err });
    return;
  }

  const maxChunks = backfillChunksPerRun();
  let chunksDone = 0;
  let totalEmitted = 0;

  for (let i = 0; i < maxChunks && reached > floor; i++) {
    const chunkUntil = reached;
    const candidateSince = isoDate(addDays(new Date(`${chunkUntil}T00:00:00.000Z`), -BACKFILL_CHUNK_DAYS));
    const chunkSince = candidateSince < floor ? floor : candidateSince;

    try {
      // FIREHOSE: backfill covers base + every breakdown pass identically to the live repull (extra loop).
      for (const breakdown of META_BREAKDOWN_PASSES) {
        for (const level of META_LEVELS) {
          const canonicalLevel: AdSpendLevel = level === 'adset' ? 'adset' : (level as AdSpendLevel);
          // Force the async ad_report_run path — historical month-wide pulls are large.
          let page = await client.fetchInsightsFirstPage(level, chunkSince, chunkUntil, {
            asyncMode: true,
            breakdown,
          });
          while (true) {
            const { emitted } = await emitPage({
              rows: page.rows,
              brandId,
              ciId,
              canonicalLevel,
              breakdown,
              accountCurrency: accountMeta.currencyCode,
              accountTz: accountMeta.timezoneName,
              producer,
              pool,
            });
            totalEmitted += emitted;
            if (!page.nextUrl) break;
            page = await client.fetchInsightsByUrl(page.nextUrl, level);
          }
        }
      }
    } catch (err) {
      if (String(err).includes(META_RATE_LIMITED)) {
        log.error(`[meta-backfill] connector=${ciId} RateLimited — checkpoint + retry next run (reached=${reached})`);
        return; // cursor already checkpointed at the last completed chunk; resume next run
      }
      if (String(err).includes(META_AUTH_ERROR)) {
        recordConnectorAuthRejected('meta');
        log.error(`[meta-backfill] connector=${ciId} auth error — RECONNECT_REQUIRED`);
        return;
      }
      log.error(`[meta-backfill] connector=${ciId} chunk [${chunkSince},${chunkUntil}] error — retry next run`, { err });
      return;
    }

    // Chunk complete → advance the floor and checkpoint (resumable).
    reached = chunkSince;
    await upsertCursorValue(pool, brandId, ciId, BACKFILL_CURSOR_RESOURCE, reached);
    chunksDone += 1;
    log.info(`[meta-backfill] connector=${ciId} chunk done [${chunkSince},${chunkUntil}] emitted-so-far=${totalEmitted}`);
  }

  const done = reached <= floor;
  log.info(
    `[meta-backfill] connector=${ciId} pass done chunks=${chunksDone} emitted=${totalEmitted} ` +
      `reached=${reached} floor=${floor} complete=${done}`,
  );
}

// ── Cursor + sync helpers (mirror razorpay-settlement-repull exactly) ────────

export async function setSyncState(
  pool: Pool, brandId: string, connectorInstanceId: string,
  state: 'syncing' | 'connected' | 'error', lastError: string | null,
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

/**
 * Reset a connector's sync-state row if it is stuck at 'syncing' beyond `thresholdMs`. A repull killed
 * by a pod termination (or the ingest-scheduler dispatch deadline) never runs its closing
 * setSyncState('connected'), so the row wedges at 'syncing' forever ("Already syncing — please wait")
 * with no auto-recovery. This is the self-heal (mirror of the backfill claimer's requeueStaleRunning):
 * a periodic reaper calls this per connected connector; a genuinely-active repull holds a fresher
 * updated_at (setSyncState('syncing') stamps NOW()) so it is never reset out from under itself.
 *
 * Runs under the SAME brain_app pool + per-brand GUC idiom as setSyncState (buildContextGucSql) so RLS
 * FORCE / grants match. Brand-scoped (RLS + the explicit brand_id predicate). Returns the rowCount reset.
 */
export async function resetStaleSyncing(
  pool: Pool, connectorInstanceId: string, brandId: string, thresholdMs: number,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(buildContextGucSql({ brandId, correlationId: '' }));
    const res = await client.query(
      `UPDATE connector_sync_status
          SET state = 'error', last_error = 'stale syncing — auto-reset', updated_at = NOW()
        WHERE connector_instance_id = $1
          AND brand_id = $2
          AND state = 'syncing'
          AND updated_at < NOW() - make_interval(secs => $3 / 1000.0)`,
      [connectorInstanceId, brandId, thresholdMs],
    );
    await client.query('COMMIT');
    return res.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.error(`resetStaleSyncing failed (non-fatal) connector=${connectorInstanceId}`, { err });
    return 0;
  } finally {
    client.release();
  }
}

// ── Credentials resolver (dev: dev_secret JSON bundle; never logged — I-S09) ──

export async function resolveMetaCredentials(
  secretRef: string, adAccountIdCol: string | null,
): Promise<MetaApiCredentials | null> {
  // PROD / local-prod: the token bundle is stored in AWS Secrets Manager at connect time (core's
  // AwsSecretsManager.storeSecret). Resolve it from THERE — dev_secret only exists in pure dev, so
  // the legacy dev-only path below returned null in local-prod (NODE_ENV=production) → "credentials
  // not found (RECONNECT_REQUIRED)" even though the secret was present. Mirrors gokwik/razorpay.
  if (process.env['NODE_ENV'] === 'production') {
    try {
      const { AwsSecretsManager } = await import('@brain/connector-secrets');
      const region = process.env['BRAIN_AWS_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1';
      const mgr = new AwsSecretsManager(
        region, '', process.env['CONNECTOR_SECRETS_KMS_KEY_ID'] ?? process.env['KMS_KEY_ID'] ?? '',
      );
      const bundle = await mgr.getSecret(secretRef); // GetSecretValue → parsed JSON (honors AWS_ENDPOINT_URL)
      const adAccountId =
        (typeof bundle?.['ad_account_id'] === 'string' ? bundle['ad_account_id'] : adAccountIdCol) ?? '';
      if (bundle && typeof bundle['access_token'] === 'string' && adAccountId) {
        return { accessToken: bundle['access_token'], adAccountId };
      }
      log.error(`[meta] secret ${secretRef.slice(-24)} resolved but missing access_token`);
    } catch (err) {
      log.error('[meta] AwsSecretsManager getSecret failed', { err });
    }
    // fall through to dev_secret / env (won't exist in prod, but harmless).
  }

  const { Pool: PgPool } = await import('pg');
  const devPool = new PgPool({
    connectionString: process.env['BRAIN_APP_DATABASE_URL'] ?? process.env['DATABASE_URL'],
    max: 1,
  });
  try {
    const name = secretRef.split(':secret:')[1] ?? secretRef;
    const res = await devPool.query<{ secret_value: string }>(
      `SELECT secret_value FROM dev_secret WHERE name = $1`, [name],
    );
    const raw = res.rows[0]?.secret_value;
    if (raw) {
      try {
        const bundle = JSON.parse(raw) as MetaSecretBundle;
        const adAccountId = bundle.ad_account_id ?? adAccountIdCol ?? '';
        if (bundle.access_token && adAccountId) {
          return { accessToken: bundle.access_token, adAccountId };
        }
      } catch { /* malformed — fall through */ }
    }
    const envToken = process.env['META_ACCESS_TOKEN'];
    const envAcct = process.env['META_AD_ACCOUNT_ID'] ?? adAccountIdCol ?? '';
    if (envToken && envAcct) return { accessToken: envToken, adAccountId: envAcct };
    return null;
  } finally {
    await devPool.end();
  }
}

// ── Date utils ────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

// ── Entrypoint (dev trigger) ──────────────────────────────────────────────────

// Path-specific entrypoint guard: meta-token-refresh/run.ts IMPORTS from this module, and its own
// entry path also endsWith('run.js') — a bare endsWith('run.js') would CROSS-FIRE this CLI block when
// the token-refresh job loads this module. Match the full directory-qualified path so only a direct
// invocation of THIS file runs the CLI (mirrors ingestion-backfill/run.ts).
if (process.argv[1]?.endsWith('meta-spend-repull/run.ts') || process.argv[1]?.endsWith('meta-spend-repull/run.js')) {
  const args = process.argv.slice(2);
  const isBackfill = args.includes('--backfill');           // 2-year historical lane (A2)
  const ciArg = args.find((a) => !a.startsWith('--'));      // optional single-connector target
  const entry = isBackfill ? runBackfill(ciArg) : run(ciArg);
  entry.catch((err) => {
    log.error('fatal', { err: err });
    process.exit(1);
  });
}
