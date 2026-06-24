/**
 * google-ads-spend-repull/run.ts — Google Ads trailing-window spend re-pull (ADR-AD-3 / ADR-AD-7).
 *
 * Mirrors meta-spend-repull/run.ts (and razorpay-settlement-repull) EXACTLY:
 *   1. enumerate via list_ad_connectors_for_spend_repull() — SECURITY DEFINER, NO GUC at
 *      enumerate (durable rule: system-job-force-rls-enumeration).
 *   2. GUC-after-enumerate (MT-1): brand_id from fn result, NEVER from API response.
 *   3. ONE cursor resource `google_ads.spend` (35d trailing window — covers Google's up-to-90d
 *      default-30d conversion window with margin). FOR UPDATE SKIP LOCKED overlap-lock.
 *   4. GoogleAdsService.SearchStream over campaign / ad_group / ad_group_ad (1 query = 1 op);
 *      cost_micros→minor (mapper, I-S07); RAW conversions + all_conversions (ADR-AD-8).
 *   5. emit spend.live.v1 to the live lane (collector.event.v1 — NO new topic/envelope);
 *      advance cursor (high-water = max stat_date); sync_status syncing→connected.
 *
 * THROTTLE (ADR-AD-7 two-error branch):
 *   GOOGLE_RESOURCE_EXHAUSTED            (daily ops-quota) → mark RateLimited + ABORT run.
 *   GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED (QPS) → handled inside the client (bounded backoff);
 *                                         if it still surfaces here, mark RateLimited + abort.
 *   Self-imposed QPS cap is enforced in the client (token bucket, default 1 rps/CID).
 *
 * Tokens NEVER logged (I-S09). The re-pull only lands spend.live.v1 on the live lane; the Spark
 * Bronze sink writes it (server-trusted) to Bronze (Iceberg) → silver_marketing_spend. Bronze is the
 * SOLE spend SoR (dedup = deterministic event_id MERGE). There is NO PostgreSQL spend ledger.
 */

import { Pool } from 'pg';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { updateConnectorInstanceHealth } from '../../infrastructure/pg/ConnectorInstanceHealthRepository.js';
import { Kafka, type Producer } from 'kafkajs';
import { buildPartitionKey } from '@brain/events';
import { injectKafkaTraceContext } from '@brain/observability';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import {
  mapGoogleRowToEvent,
  uuidV5FromSpendRow,
  SPEND_LIVE_V1_EVENT_NAME,
} from '@brain/ad-spend-mapper';
import {
  GoogleAdsSearchStreamClient,
  GOOGLE_AUTH_ERROR,
  GOOGLE_RESOURCE_EXHAUSTED,
  GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED,
  type GoogleAdsCredentials,
} from './google-ads-searchstream-client.js';
import { setSyncState } from '../meta-spend-repull/run.js';
import {
  acquireCursorLock,
  upsertCursorValue,
} from '../../infrastructure/pg/CursorRepository.js';
import { log } from "../../log.js";

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const ENV = process.env['APP_ENV'] ?? 'dev';
const LIVE_TOPIC = `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

const CURSOR_RESOURCE = 'google_ads.spend' as const;
const WINDOW_DAYS = 35;
const GOOGLE_LEVELS: Array<'campaign' | 'adset' | 'ad'> = ['campaign', 'adset', 'ad'];

interface AdConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  provider: string;
  secret_ref: string;
  ad_account_id: string | null;
}

/** Dev secret bundle for a Google Ads connector. */
interface GoogleSecretBundle {
  refresh_token: string;     // NEVER logged (I-S09)
  client_id?: string;
  client_secret?: string;
  developer_token?: string;
  customer_id?: string;      // CID
  login_customer_id?: string;
  ad_account_id?: string;
}

export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({ clientId: 'google-ads-spend-repull', brokers: BROKERS, retry: { retries: 5 } });
  const producer = kafka.producer({ idempotent: true });

  try {
    await producer.connect();
    log.info(`starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    const connectors = await enumerateGoogleConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('no connected google_ads connectors found — exiting');
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

// ── Enumerate (filter provider='google_ads') ─────────────────────────────────

export async function enumerateGoogleConnectors(
  pool: Pool, targetConnectorInstanceId?: string,
): Promise<AdConnectorRow[]> {
  if (targetConnectorInstanceId) {
    const result = await pool.query<AdConnectorRow>(
      `SELECT connector_instance_id, brand_id, provider, secret_ref, ad_account_id
       FROM list_ad_connectors_for_spend_repull()
       WHERE connector_instance_id = $1 AND provider = 'google_ads'`,
      [targetConnectorInstanceId],
    );
    return result.rows;
  }
  const result = await pool.query<AdConnectorRow>(
    `SELECT connector_instance_id, brand_id, provider, secret_ref, ad_account_id
     FROM list_ad_connectors_for_spend_repull()
     WHERE provider = 'google_ads'`,
  );
  return result.rows;
}

interface RepullParams {
  connector: AdConnectorRow;
  pool: Pool;
  producer: Producer;
}

async function repullConnector(params: RepullParams): Promise<void> {
  const { connector, pool, producer } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = connector;

  log.info(`connector=${ciId} brand=${brandId}`);

  const creds = await resolveGoogleCredentials(secretRef, connector.ad_account_id);
  if (!creds) {
    log.error(`connector=${ciId} — credentials not found (RECONNECT_REQUIRED)`);
    return;
  }

  await setSyncState(pool, brandId, ciId, 'syncing', null);

  const lockAcquired = await acquireCursorLock(pool, brandId, ciId, CURSOR_RESOURCE);
  if (!lockAcquired) {
    log.info(`connector=${ciId} — cursor locked, skipping`);
    return;
  }

  const client = new GoogleAdsSearchStreamClient(creds);
  try {
    await client.authenticate();
  } catch (err) {
    if (String(err).includes(GOOGLE_AUTH_ERROR)) {
      recordConnectorAuthRejected('google_ads'); // P2.6: make the silent token-expiry death loud
      await setSyncState(pool, brandId, ciId, 'error', 'google auth error — RECONNECT_REQUIRED');
      await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
      return;
    }
    log.error(`connector=${ciId} auth failed`, { err: err });
    await setSyncState(pool, brandId, ciId, 'error', 'auth failed');
    return;
  }

  const to = isoDate(new Date());
  const from = isoDate(addDays(new Date(), -WINDOW_DAYS));

  let totalEmitted = 0;
  let maxStatDate: string | null = null;

  for (const level of GOOGLE_LEVELS) {
    let rows;
    try {
      rows = await client.streamLevel(level, from, to);
    } catch (err) {
      const s = String(err);
      if (s.includes(GOOGLE_RESOURCE_EXHAUSTED) || s.includes(GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED)) {
        // ADR-AD-7: daily quota (or exhausted QPS backoff) → mark RateLimited + ABORT run.
        log.error(`connector=${ciId} RateLimited — aborting run (retry next)`);
        await setSyncState(pool, brandId, ciId, 'error', 'RateLimited — retry next run');
        await updateConnectorInstanceHealth(pool, brandId, ciId, 'rate_limited');
        return;
      }
      if (s.includes(GOOGLE_AUTH_ERROR)) {
        recordConnectorAuthRejected('google_ads'); // P2.6: make the silent token-expiry death loud
        await setSyncState(pool, brandId, ciId, 'error', 'google auth error — RECONNECT_REQUIRED');
        await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
        return;
      }
      log.error(`connector=${ciId} level=${level} stream error`, { err: err });
      continue; // non-fatal per level
    }

    const { emitted, maxDate } = await emitRows({
      rows, brandId, ciId, producer,
    });
    totalEmitted += emitted;
    if (maxDate && (maxStatDate === null || maxDate > maxStatDate)) maxStatDate = maxDate;
    if (maxStatDate) await upsertCursorValue(pool, brandId, ciId, CURSOR_RESOURCE, maxStatDate);
  }

  await setSyncState(pool, brandId, ciId, 'connected', null);
  log.info(`connector=${ciId} COMPLETED totalEmitted=${totalEmitted}`);
}

interface EmitParams {
  rows: Array<Record<string, unknown>>;
  brandId: string;
  ciId: string;
  producer: Producer;
}

async function emitRows(p: EmitParams): Promise<{ emitted: number; maxDate: string | null }> {
  if (p.rows.length === 0) return { emitted: 0, maxDate: null };

  const messages = [];
  let maxDate: string | null = null;

  for (const raw of p.rows) {
    // currency authority is the row's customer.currency_code (carried per-row); fallback handled in mapper.
    const accountCurrency = (raw['currency_code'] as string) ?? 'USD';
    const mapped = mapGoogleRowToEvent(raw, accountCurrency, null);
    const props = mapped.properties;
    if (!props.stat_date || !props.level_id) continue;

    const eventId = uuidV5FromSpendRow(
      p.brandId, 'google_ads', props.stat_date, props.level, props.level_id,
    );

    const envelope = CollectorEventV1Schema.parse({
      schema_version: '1',
      event_id: eventId,
      brand_id: p.brandId,        // MT-1 — never from API response
      correlation_id: `google-ads-spend-repull:${p.ciId}:${eventId}`,
      event_name: SPEND_LIVE_V1_EVENT_NAME,
      occurred_at: mapped.occurred_at,
      ingested_at: new Date().toISOString(),
      properties: props as unknown as Record<string, unknown>,
    });

    messages.push({ key: buildPartitionKey(p.brandId, eventId), value: Buffer.from(JSON.stringify(envelope)) });
    if (maxDate === null || props.stat_date > maxDate) maxDate = props.stat_date;
  }

  if (messages.length > 0) {
    // OTel trace-context propagation (OBS-1/OBS-2): stamp traceparent on each
    // message so the bronze-bridge consumer resumes this repull's trace.
    const traceHeaders: Record<string, Buffer | string> = {};
    injectKafkaTraceContext(traceHeaders);
    await p.producer.send({ topic: LIVE_TOPIC, messages: messages.map((m) => ({ ...m, headers: traceHeaders })) });
    log.info(`connector=${p.ciId} emitted=${messages.length}`);
  }
  return { emitted: messages.length, maxDate };
}

// ── Credentials resolver (dev: dev_secret JSON bundle; never logged — I-S09) ──

export async function resolveGoogleCredentials(
  secretRef: string, adAccountIdCol: string | null,
): Promise<GoogleAdsCredentials | null> {
  // P0 CREDENTIAL-BUNDLE FIX: the OAuth callback stores ONLY {refresh_token, ad_account_id} in the
  // per-brand secret. The app-level Google Cloud creds (client_id, client_secret, developer_token)
  // are the SAME for every brand and come from ENV — NOT the per-brand bundle. The previous resolver
  // demanded all five from the bundle → b.client_id/etc were undefined → returned null → ZERO spend
  // on every real connect. App creds from env + the bundle's refresh_token/ad_account_id is correct.
  const clientId = process.env['GOOGLE_ADS_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_ADS_CLIENT_SECRET'];
  const developerToken = process.env['GOOGLE_ADS_DEVELOPER_TOKEN'];
  if (!clientId || !clientSecret || !developerToken) {
    log.warn(
      '[google-ads] app-level creds missing (GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / ' +
        'GOOGLE_ADS_DEVELOPER_TOKEN) — cannot resolve credentials',
    );
    return null;
  }

  const bundle = await readGoogleSecretBundle(secretRef);
  if (!bundle?.refresh_token) return null;
  // customer_id (CID) is the OAuth-stored ad_account_id (or the connector_instance column); digits only.
  const customerId = (bundle.customer_id ?? bundle.ad_account_id ?? adAccountIdCol ?? '').replace(/-/g, '');
  if (!customerId) return null;

  return {
    refreshToken: bundle.refresh_token,
    clientId,
    clientSecret,
    developerToken,
    customerId,
    loginCustomerId: bundle.login_customer_id ?? process.env['GOOGLE_ADS_LOGIN_CUSTOMER_ID'],
  };
}

/** Read the per-brand {refresh_token, ad_account_id} bundle — prod: AWS Secrets Manager; dev: dev_secret. */
async function readGoogleSecretBundle(secretRef: string): Promise<GoogleSecretBundle | null> {
  // PROD: AWS Secrets Manager via the shared @brain/connector-secrets AwsSecretsManager — the SAME
  // impl the connect path wrote it with (#75). Replaces the dev_secret-only resolver in prod.
  if (process.env['NODE_ENV'] === 'production') {
    const { AwsSecretsManager } = await import('@brain/connector-secrets');
    const region = process.env['BRAIN_AWS_REGION'] ?? 'us-east-1';
    const mgr = new AwsSecretsManager(region, '', process.env['CONNECTOR_SECRETS_KMS_KEY_ID'] ?? '');
    const b = await mgr.getSecret(secretRef);
    return b ? (b as unknown as GoogleSecretBundle) : null;
  }
  // DEV: dev_secret table (never logged — I-S09).
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
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GoogleSecretBundle;
    } catch {
      return null;
    }
  } finally {
    await devPool.end();
  }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  const ciArg = process.argv[2];
  run(ciArg).catch((err) => {
    log.error('fatal', { err: err });
    process.exit(1);
  });
}
