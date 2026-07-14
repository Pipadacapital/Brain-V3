/**
 * ga4-repull/run.ts — GA4 Data API trailing-window re-pull job.
 *
 * Mirrors google-ads-spend-repull/run.ts EXACTLY in structure:
 *   1. Enumerate via list_connectors_for_repull('ga4') — SECURITY DEFINER, NO GUC at
 *      enumerate time (durable rule: system-job-force-rls-enumeration).
 *   2. GUC-after-enumerate (MT-1): brand_id from fn result, NEVER from the GA4 API response.
 *   3. ONE cursor resource 'ga4.sessions' (28d trailing window — covers GA4's processing lag
 *      which can be up to 72h; 28d catches any late-arriving session corrections).
 *   4. Ga4DataClient.runReport (POST /properties/{propertyId}:runReport) per connector.
 *   5. mapGa4RowToEvent → uuidV5FromGa4Row (deterministic event_id) → emit ga4.session.v1
 *      on the collector.event.v1 live lane (NO new topic/envelope — I-ST04/ADR-AD-4 pattern).
 *   6. Advance cursor (high-water = max date pulled); sync_status syncing→connected.
 *
 * HONEST-EMPTY GUARD (Brain data truth rule):
 *   When no GA4 credential / property is configured for a connector instance the job
 *   surfaces 'GA4 not connected — add credentials' (Ga4NotConnectedError) and emits ZERO
 *   events. It NEVER fabricates sessions or returns synthetic data.
 *
 * QUOTA handling:
 *   GA4_QUOTA_EXHAUSTED (daily property token) → mark RateLimited + ABORT run (no in-run retry).
 *   GA4_AUTH_ERROR (token expired / revoked / wrong scope) → mark token_expired + abort.
 *
 * Tokens NEVER logged (I-S09). brand_id ALWAYS from fn result (MT-1).
 */

import { Pool } from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import { createIdempotentProducer } from '../../infrastructure/kafka/idempotent-producer.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { updateConnectorInstanceHealth, recoverConnectorInstanceHealth } from '../../infrastructure/pg/ConnectorInstanceHealthRepository.js';
import { filterUnseenEventIds, markEventIdsSeen } from '../../infrastructure/pg/IngestDedupRepository.js';
import { buildPartitionKey } from '@brain/events';
import { injectKafkaTraceContext, incrementCounter } from '@brain/observability';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import { loadStreamWorkerConfig } from '@brain/config';
import { buildContextGucSql } from '@brain/db';
import {
  mapGa4RowToEvent,
  uuidV5FromGa4Row,
  GA4_SESSION_EVENT_NAME,
  type Ga4ReportRow,
  type Ga4RunReportSampling,
} from '@brain/ga4-mapper';
import {
  Ga4DataClient,
  GA4_QUOTA_EXHAUSTED,
  GA4_AUTH_ERROR,
  type Ga4Credentials,
} from './ga4-data-client.js';
import { setSyncState } from '../meta-spend-repull/run.js';
import {
  acquireCursorLock,
  upsertCursorValue,
} from '../../infrastructure/pg/CursorRepository.js';
import { log } from '../../log.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;
const BROKERS = cfg.KAFKA_BROKERS.split(',');
// intentional raw: NODE_ENV-derived Kafka topic-prefix selection (must precede config load).
const ENV = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
const LIVE_TOPIC = `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

/** Single cursor resource: ga4.sessions, 28d trailing window. */
const CURSOR_RESOURCE = 'ga4.sessions' as const;
const WINDOW_DAYS = 28;

// ── Enumeration row shape (from list_connectors_for_repull('ga4')) ───────────

interface Ga4ConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  provider: string;
  secret_ref: string;
  /** GA4 property id stored in connector_instance.ad_account_id column (generic repull contract). */
  ad_account_id: string | null;
}

// ── Credential secret bundle shape ────────────────────────────────────────────

/**
 * Secret bundle shapes (NEVER logged — I-S09):
 *   - SERVICE-ACCOUNT (the generic per-brand credential connect, HandleGa4ConnectCommand):
 *     { auth_method:'service_account', client_email, private_key, property_id, currency_code? }.
 *     Self-contained — needs NO shared Google app env pair.
 *   - Legacy OAUTH (stored via the historic OAuth callback): { refresh_token, property_id? } —
 *     still resolved against the shared GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET env app.
 */
interface Ga4SecretBundle {
  refresh_token?: string;    // legacy OAuth bundle — NEVER logged (I-S09)
  client_email?: string;     // service-account bundle
  private_key?: string;      // service-account bundle — NEVER logged (I-S09)
  property_id?: string;      // GA4 property id (may also come from ad_account_id column)
  currency_code?: string;    // ISO-4217 property reporting currency (absent ⇒ USD)
}

// ── Main entrypoint ───────────────────────────────────────────────────────────

export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({ clientId: 'ga4-repull', brokers: BROKERS, retry: { retries: 5 } });
  const producer = createIdempotentProducer(kafka);

  try {
    await producer.connect();
    log.info(`[ga4-repull] starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    const connectors = await enumerateGa4Connectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('[ga4-repull] no connected ga4 connectors found — exiting');
      return;
    }
    log.info(`[ga4-repull] found ${connectors.length} connector(s) to re-pull`);

    for (const connector of connectors) {
      await repullConnector({ connector, pool, producer });
    }
  } finally {
    await producer.disconnect();
    await pool.end();
  }
}

// ── Enumerate (filter provider='ga4') ─────────────────────────────────────────

export async function enumerateGa4Connectors(
  pool: Pool,
  targetConnectorInstanceId?: string,
): Promise<Ga4ConnectorRow[]> {
  if (targetConnectorInstanceId) {
    const result = await pool.query<Ga4ConnectorRow>(
      `SELECT connector_instance_id, brand_id, provider, secret_ref, ad_account_id
       FROM list_connectors_for_repull($1)
       WHERE connector_instance_id = $2`,
      ['ga4', targetConnectorInstanceId],
    );
    return result.rows;
  }
  const result = await pool.query<Ga4ConnectorRow>(
    `SELECT connector_instance_id, brand_id, provider, secret_ref, ad_account_id
     FROM list_connectors_for_repull($1)`,
    ['ga4'],
  );
  return result.rows;
}

// ── Per-connector repull ──────────────────────────────────────────────────────

interface RepullParams {
  connector: Ga4ConnectorRow;
  pool: Pool;
  producer: Producer;
}

async function repullConnector(params: RepullParams): Promise<void> {
  const { connector, pool, producer } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = connector;

  log.info(`[ga4-repull] connector=${ciId} brand=${brandId}`);

  // Resolve credentials — HONEST-EMPTY GUARD:
  // If no credentials are stored the job surfaces a clear error and emits ZERO events.
  const creds = await resolveGa4Credentials(secretRef, connector.ad_account_id);
  if (!creds) {
    // Honest-empty guard: no credentials configured → surface the error, no fabrication.
    log.warn(
      `[ga4-repull] connector=${ciId} brand=${brandId} — GA4 not connected: no credentials found. ` +
      `Add credentials (complete OAuth or provide a service-account JSON key + propertyId). ` +
      `No sessions will be emitted.`,
    );
    await setSyncState(pool, brandId, ciId, 'error', 'GA4 not connected — add credentials');
    return;
  }

  await setSyncState(pool, brandId, ciId, 'syncing', null);

  const lockAcquired = await acquireCursorLock(pool, brandId, ciId, CURSOR_RESOURCE);
  if (!lockAcquired) {
    log.info(`[ga4-repull] connector=${ciId} — cursor locked, skipping`);
    return;
  }

  const client = new Ga4DataClient(creds);

  // Authenticate — NEVER log the token (I-S09)
  try {
    await client.authenticate();
  } catch (err) {
    const s = String(err);
    if (s.includes(GA4_AUTH_ERROR)) {
      recordConnectorAuthRejected('ga4');
      await setSyncState(pool, brandId, ciId, 'error', 'GA4 auth error — RECONNECT_REQUIRED');
      await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
      return;
    }
    log.error(`[ga4-repull] connector=${ciId} auth failed`, { err: err });
    await setSyncState(pool, brandId, ciId, 'error', 'auth failed');
    return;
  }

  const to = isoDate(new Date());
  const from = isoDate(addDays(new Date(), -WINDOW_DAYS));

  let result: { rows: Ga4ReportRow[]; sampling: Ga4RunReportSampling | null; rowCount: number };
  try {
    result = await client.runReport(from, to);
  } catch (err) {
    const s = String(err);
    if (s.includes(GA4_QUOTA_EXHAUSTED)) {
      log.error(`[ga4-repull] connector=${ciId} — GA4 quota exhausted, aborting run`);
      await setSyncState(pool, brandId, ciId, 'error', 'GA4 quota exhausted — retry next run');
      await updateConnectorInstanceHealth(pool, brandId, ciId, 'rate_limited');
      return;
    }
    if (s.includes(GA4_AUTH_ERROR)) {
      recordConnectorAuthRejected('ga4');
      await setSyncState(pool, brandId, ciId, 'error', 'GA4 auth error — RECONNECT_REQUIRED');
      await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
      return;
    }
    log.error(`[ga4-repull] connector=${ciId} runReport error`, { err: err });
    await setSyncState(pool, brandId, ciId, 'error', 'runReport failed');
    return;
  }

  const { emitted, maxDate } = await emitRows({
    rows: result.rows,
    sampling: result.sampling,
    propertyId: creds.propertyId,
    // Property reporting currency from the connect form (stored in the secret bundle);
    // USD only as the last-resort default for legacy bundles that never captured it.
    currencyCode: creds.currencyCode ?? 'USD',
    brandId,
    ciId,
    producer,
    pool,
  });

  if (maxDate) {
    await upsertCursorValue(pool, brandId, ciId, CURSOR_RESOURCE, maxDate);
  }

  await setSyncState(pool, brandId, ciId, 'connected', null);
  // Recovery edge: self-heal a prior TokenExpired/RateLimited badge on success (no-op otherwise).
  await recoverConnectorInstanceHealth(pool, brandId, ciId);
  log.info(`[ga4-repull] connector=${ciId} COMPLETED emitted=${emitted} rowCount=${result.rowCount}`);
}

// ── Emit rows ─────────────────────────────────────────────────────────────────

interface EmitParams {
  rows: Ga4ReportRow[];
  sampling: Ga4RunReportSampling | null;
  propertyId: string;
  currencyCode: string;
  brandId: string;
  ciId: string;
  producer: Producer;
  pool: Pool;
}

async function emitRows(
  p: EmitParams,
): Promise<{ emitted: number; maxDate: string | null }> {
  if (p.rows.length === 0) return { emitted: 0, maxDate: null };

  const messages: Array<{ eventId: string; key: string; value: Buffer }> = [];
  let maxDate: string | null = null;

  for (const raw of p.rows) {
    const mapped = mapGa4RowToEvent(raw, p.propertyId, p.currencyCode, p.sampling);
    const props = mapped.properties;
    if (!props.date) continue; // skip rows without a date dimension — dedup grain is undefined

    const eventId = uuidV5FromGa4Row(
      p.brandId,       // MT-1 — never from API response
      p.propertyId,
      props.date,
      props.session_source ?? '',
      props.session_medium ?? '',
      props.session_campaign_name ?? '',
      props.session_default_channel_group ?? '',
      props.device_category ?? '',
      props.country ?? '',
    );

    const envelope = CollectorEventV1Schema.parse({
      schema_version: '1',
      event_id: eventId,
      brand_id: p.brandId,     // MT-1 — from connector row, NEVER from GA4 API
      correlation_id: `ga4-repull:${p.ciId}:${eventId}`,
      event_name: GA4_SESSION_EVENT_NAME,
      occurred_at: mapped.occurred_at,
      ingested_at: new Date().toISOString(),
      properties: props as unknown as Record<string, unknown>,
    });

    messages.push({
      eventId,
      key: buildPartitionKey(p.brandId, eventId),
      value: Buffer.from(JSON.stringify(envelope)),
    });

    if (maxDate === null || props.date > maxDate) maxDate = props.date;
  }

  let emitted = 0;
  if (messages.length > 0) {
    // ADR-0012 ingest dedup gate: drop event_ids already ingested for this brand BEFORE producing,
    // so a re-pull/backfill overlap never re-floods Bronze. brand GUC set on a short pooled client,
    // then filter+mark. ORDER IS CRITICAL: produce FIRST, mark AFTER (a crash between at worst
    // re-produces a dup on retry, which Silver backstops — never loses an event).
    const dedupClient = await p.pool.connect();
    try {
      await dedupClient.query(buildContextGucSql({ brandId: p.brandId, correlationId: '' }));
      const unseen = await filterUnseenEventIds(dedupClient, p.brandId, messages.map((m) => m.eventId));

      const toSend = messages.filter((m) => unseen.has(m.eventId));
      const dropped = messages.length - toSend.length;
      if (dropped > 0) {
        incrementCounter('ingest_dedup_dropped_total', { provider: 'ga4' });
        log.info(`[ga4-repull] connector=${p.ciId} dedup: dropped ${dropped} already-ingested events`);
      }

      if (toSend.length > 0) {
        // OTel trace-context propagation (OBS-1/OBS-2): stamp traceparent on each
        // message so the bronze-bridge consumer resumes this repull's trace.
        const traceHeaders: Record<string, Buffer | string> = {};
        injectKafkaTraceContext(traceHeaders);
        await p.producer.send({
          topic: LIVE_TOPIC,
          messages: toSend.map((m) => ({ key: m.key, value: m.value, headers: traceHeaders })),
        });
        await markEventIdsSeen(dedupClient, p.brandId, toSend.map((m) => m.eventId));
        emitted = toSend.length;
      }
    } finally {
      dedupClient.release();
    }
    log.info(`[ga4-repull] connector=${p.ciId} emitted=${emitted}`);
  }

  return { emitted, maxDate };
}

// ── Credentials resolver ──────────────────────────────────────────────────────

/**
 * Resolve GA4 credentials from the secret bundle.
 * Returns null when no credentials are configured → the honest-empty guard surfaces this.
 * Tokens NEVER logged (I-S09).
 *
 * SERVICE-ACCOUNT FIRST (the generic per-brand connect path): a bundle carrying
 * {client_email, private_key} is self-contained — it resolves WITHOUT the shared
 * GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET env app. The legacy OAuth refresh_token bundle
 * still falls back to the env pair.
 */
export async function resolveGa4Credentials(
  secretRef: string,
  adAccountIdCol: string | null,
): Promise<Ga4Credentials | null> {
  const bundle = await readGa4SecretBundle(secretRef);
  if (!bundle) {
    // Honest-empty guard: no stored credential → caller surfaces 'GA4 not connected'
    return null;
  }

  const propertyId = (bundle.property_id ?? adAccountIdCol ?? '').trim();
  if (!propertyId || !/^\d+$/.test(propertyId)) {
    log.warn(`[ga4-repull] secretRef=${secretRef} — GA4 propertyId missing or non-numeric`);
    return null;
  }

  const currencyCode = (bundle.currency_code ?? '').trim().toUpperCase() || undefined;

  // ── Service-account bundle (per-brand connect) — no shared env app needed ──
  if (bundle.client_email && bundle.private_key) {
    return {
      kind: 'service_account',
      clientEmail: bundle.client_email,
      privateKeyPem: bundle.private_key,   // NEVER logged (I-S09)
      propertyId,
      ...(currencyCode ? { currencyCode } : {}),
    };
  }

  // ── Legacy OAuth bundle — resolved against the shared Google app env pair ──
  if (!bundle.refresh_token) {
    // Honest-empty guard: bundle carries neither a SA key nor a refresh token.
    return null;
  }
  const clientId = process.env['GOOGLE_CLIENT_ID'] ?? process.env['GOOGLE_ADS_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] ?? process.env['GOOGLE_ADS_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    log.warn(
      '[ga4-repull] legacy OAuth bundle but app-level creds missing (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) — reconnect with a service-account key instead',
    );
    return null;
  }

  return {
    kind: 'oauth',
    refreshToken: bundle.refresh_token,    // NEVER logged (I-S09)
    clientId,
    clientSecret,
    propertyId,
    ...(currencyCode ? { currencyCode } : {}),
  };
}

/** Read the per-brand GA4 secret bundle — prod: AWS Secrets Manager; dev: dev_secret table. */
async function readGa4SecretBundle(secretRef: string): Promise<Ga4SecretBundle | null> {
  if (process.env['NODE_ENV'] === 'production') {
    const { AwsSecretsManager } = await import('@brain/connector-secrets');
    const region = process.env['BRAIN_AWS_REGION'] ?? 'us-east-1';
    const mgr = new AwsSecretsManager(region, '', process.env['CONNECTOR_SECRETS_KMS_KEY_ID'] ?? '');
    const b = await mgr.getSecret(secretRef);
    return b ? (b as unknown as Ga4SecretBundle) : null;
  }
  // DEV: dev_secret table (never logged — I-S09)
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
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Ga4SecretBundle;
    } catch {
      return null;
    }
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

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  const ciArg = process.argv[2];
  run(ciArg).catch((err) => {
    log.error('[ga4-repull] fatal', { err: err });
    process.exit(1);
  });
}
