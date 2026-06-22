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
 * The re-pull does NOT write the ledger — it only lands spend.live.v1 on the live lane.
 * SpendLedgerConsumer writes ad_spend_ledger (ON CONFLICT DO NOTHING — idempotent re-read).
 *
 * Throttle (ADR-AD-7): META_RATE_LIMITED → mark health/error + abort this run (retry next run).
 * Tokens are NEVER logged (I-S09). brand_id ALWAYS from the fn result (MT-1).
 *
 * Dev trigger (ADR-AD-9): pass connector_instance_id as argv[2] to re-pull a single connector.
 */

import { Pool } from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { buildPartitionKey } from '@brain/events';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
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
} from './meta-insights-client.js';
import { log } from "../../log.js";
import { acquireCursorLock, upsertCursorValue } from '../../infrastructure/pg/CursorRepository.js';

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const ENV = process.env['APP_ENV'] ?? 'dev';
const LIVE_TOPIC = `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

/** Single cursor resource (ADR-AD-3): meta.insights, 28d trailing window. */
const CURSOR_RESOURCE = 'meta.insights' as const;
const WINDOW_DAYS = 28;

/** The hierarchy levels to pull (Meta Insights level param). */
const META_LEVELS: Array<'campaign' | 'adset' | 'ad'> = ['campaign', 'adset', 'ad'];

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
  const producer = kafka.producer({ idempotent: true });

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
    log.error(`connector=${ciId} — credentials not found (RECONNECT_REQUIRED)`);
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
      return;
    }
    if (String(err).includes(META_RATE_LIMITED)) {
      await setSyncState(pool, brandId, ciId, 'error', 'RateLimited — retry next run');
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

  for (const level of META_LEVELS) {
    const canonicalLevel: AdSpendLevel = level === 'adset' ? 'adset' : (level as AdSpendLevel);
    try {
      let pageUrlResult = await client.fetchInsightsFirstPage(level, since, until);
      while (true) {
        const { emitted, maxDate } = await emitPage({
          rows: pageUrlResult.rows,
          brandId,
          ciId,
          canonicalLevel,
          accountCurrency: accountMeta.currencyCode,
          accountTz: accountMeta.timezoneName,
          producer,
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
        return;
      }
      if (String(err).includes(META_AUTH_ERROR)) {
        recordConnectorAuthRejected('meta'); // P2.6: make the silent token-expiry death loud
        await setSyncState(pool, brandId, ciId, 'error', 'meta auth error — RECONNECT_REQUIRED');
        return;
      }
      log.error(`connector=${ciId} level=${level} page error`, { err: err });
      // Non-fatal per level — continue to next level.
    }
  }

  await setSyncState(pool, brandId, ciId, 'connected', null);
  log.info(`connector=${ciId} COMPLETED totalEmitted=${totalEmitted}`);
}

// ── Page emit ─────────────────────────────────────────────────────────────────

interface EmitPageParams {
  rows: Array<Record<string, unknown>>;
  brandId: string;
  ciId: string;
  canonicalLevel: AdSpendLevel;
  accountCurrency: string;
  accountTz: string | null;
  producer: Producer;
}

async function emitPage(p: EmitPageParams): Promise<{ emitted: number; maxDate: string | null }> {
  if (p.rows.length === 0) return { emitted: 0, maxDate: null };

  const messages = [];
  let maxDate: string | null = null;

  for (const raw of p.rows) {
    const mapped = mapMetaInsightToEvent(raw, p.accountCurrency, p.accountTz);
    const props = mapped.properties;
    if (!props.stat_date || !props.level_id) continue; // skip rows missing the dedup grain

    const eventId = uuidV5FromSpendRow(
      p.brandId, 'meta', props.stat_date, props.level, props.level_id,
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

    messages.push({ key: buildPartitionKey(p.brandId, eventId), value: Buffer.from(JSON.stringify(envelope)) });
    if (maxDate === null || props.stat_date > maxDate) maxDate = props.stat_date;
  }

  if (messages.length > 0) {
    await p.producer.send({ topic: LIVE_TOPIC, messages });
    log.info(`connector=${p.ciId} level=${p.canonicalLevel} emitted=${messages.length}`);
  }
  return { emitted: messages.length, maxDate };
}

// ── Cursor + sync helpers (mirror razorpay-settlement-repull exactly) ────────

export async function setSyncState(
  pool: Pool, brandId: string, connectorInstanceId: string,
  state: 'syncing' | 'connected' | 'error', lastError: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    if (state === 'connected') {
      await client.query(
        `UPDATE connector_sync_status
           SET state = $3, last_sync_at = NOW(), last_error = $4, updated_at = NOW()
         WHERE brand_id = $1 AND connector_instance_id = $2`,
        [brandId, connectorInstanceId, state, lastError],
      );
    } else {
      await client.query(
        `UPDATE connector_sync_status
           SET state = $3, last_error = $4, updated_at = NOW()
         WHERE brand_id = $1 AND connector_instance_id = $2`,
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

// ── Credentials resolver (dev: dev_secret JSON bundle; never logged — I-S09) ──

async function resolveMetaCredentials(
  secretRef: string, adAccountIdCol: string | null,
): Promise<MetaApiCredentials | null> {
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

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  const ciArg = process.argv[2];
  run(ciArg).catch((err) => {
    log.error('fatal', { err: err });
    process.exit(1);
  });
}
