/**
 * gokwik-awb-repull/run.ts — GoKwik AWB-lifecycle trailing-window re-pull (05-architecture.md §3).
 *
 * A near-verbatim clone of razorpay-settlement-repull/run.ts. The AWB outcome (RTO/Delivered)
 * is a LATE-CHANGING shipment lifecycle (research finding 3): terminal end-states arrive WEEKS
 * after order placement. So this job re-reads a WEEKS-LONG trailing window every run and RESTATES
 * terminal states idempotently.
 *
 * Architecture (mirrors razorpay-settlement-repull exactly):
 *   1. Enumerate via list_gokwik_connectors_for_awb_repull() — SECURITY DEFINER, NO GUC at
 *      enumerate time (durable rule: system-job-force-rls-enumeration). Returns gokwik_appid too.
 *   2. GUC set AFTER enumerate, before any brand-scoped read/write (MT-1).
 *   3. Single cursor resource 'awb.lifecycle', FOR UPDATE SKIP LOCKED (overlap-safe).
 *   4. WINDOW = 45 days (AWB_WINDOW_MS) — terminal states arrive weeks late.
 *   5. Per AWB record → map via @brain/gokwik-mapper (awb hashed at boundary, order_id passthrough).
 *      event_id = uuidV5FromAwb(brand, awb, status, status_changed_at) → DISTINCT per transition
 *      → a new Bronze row per state change → terminal RTO/Delivered RESTATED idempotently.
 *   6. Emit gokwik.awb_status.v1 to the live lane → cursor high-water advance → sync_status.
 *
 * The re-pull does NOT do the ledger join — it lands events on the live lane.
 * GokwikAwbLedgerConsumer turns terminal RTO/Delivered into cod_rto_clawback / cod_delivery_confirmed.
 *
 * DEV-HONESTY: the AWB read source is a labelled SYNTHETIC fixture (GokwikAwbClient) — every event
 * carries data_source='synthetic' + the Bronze envelope carries processing_flags._synthetic=true.
 * NEVER presented as live. Real partner sandbox is a platform follow-up.
 *
 * NEVER log appid/appsecret (I-S09) or raw AWB numbers (hashed at the mapper boundary).
 * brand_id ALWAYS from the enumeration fn (MT-1) — NEVER from env or payload.
 *
 * Dev trigger (MB-6): pass connector_instance_id as argv[2] to re-pull a single connector.
 */

import { Pool } from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import { buildPartitionKey } from '@brain/events';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import {
  mapGokwikAwb,
  uuidV5FromAwb,
  GOKWIK_AWB_STATUS_V1_EVENT_NAME,
  type GokwikAwbRecord,
} from '@brain/gokwik-mapper';
import { GokwikAwbClient, type GokwikApiCredentials, GOKWIK_AWB_PAGE_SIZE, GOKWIK_AUTH_ERROR } from './gokwik-awb-client.js';
import { generateSyntheticAwbFromOrders } from './synthetic-awb-from-orders.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { SaltProvider, LocalSecretsProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { resolveSaltHex } from '@brain/identity-core';
import { log } from "../../log.js";
import { acquireCursorLock, getCursorValue, upsertCursorValue } from '../../infrastructure/pg/CursorRepository.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const ENV = process.env['APP_ENV'] ?? 'dev';
const LIVE_TOPIC = process.env['COLLECTOR_TOPIC'] ?? `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

/** Single cursor resource. WINDOW = 45 days — terminal AWB states arrive weeks late. */
const AWB_CURSOR_RESOURCE = 'awb.lifecycle' as const;
const AWB_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

interface GokwikConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  secret_ref: string;
  gokwik_appid: string | null;
}

/** Dev credentials bundle parsed from the secret. NEVER logged (I-S09). */
interface GokwikSecretBundle {
  appid: string;
  appsecret: string;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({
    clientId: 'gokwik-awb-repull',
    brokers: BROKERS,
    retry: { retries: 5 },
  });
  const producer = kafka.producer();

  const saltSecrets = new LocalSecretsProvider();
  const saltProvider = new SaltProvider(saltSecrets, resolveSaltHex);

  try {
    await producer.connect();
    log.info(`starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    const connectors = await enumerateConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('no connected GoKwik connectors found — exiting');
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

// ── Enumerate (durable rule system-job-force-rls-enumeration — no GUC here) ───

async function enumerateConnectors(
  pool: Pool,
  targetConnectorInstanceId?: string,
): Promise<GokwikConnectorRow[]> {
  if (targetConnectorInstanceId) {
    const result = await pool.query<GokwikConnectorRow>(
      `SELECT connector_instance_id, brand_id, secret_ref, gokwik_appid
       FROM list_gokwik_connectors_for_awb_repull()
       WHERE connector_instance_id = $1`,
      [targetConnectorInstanceId],
    );
    return result.rows;
  }
  const result = await pool.query<GokwikConnectorRow>(
    `SELECT connector_instance_id, brand_id, secret_ref, gokwik_appid
     FROM list_gokwik_connectors_for_awb_repull()`,
  );
  return result.rows;
}

// ── Per-connector re-pull ─────────────────────────────────────────────────────

interface RepullParams {
  connector: GokwikConnectorRow;
  pool: Pool;
  producer: Producer;
  saltProvider: SaltProvider;
}

async function repullConnector(params: RepullParams): Promise<void> {
  const { connector, pool, producer, saltProvider } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = connector;

  log.info(`connector=${ciId} brand=${brandId}`);

  const creds = await resolveGokwikCredentials(secretRef);
  if (!creds) {
    log.error(`connector=${ciId} — credentials not found (RECONNECT_REQUIRED)`);
    return;
  }

  let saltHex: string;
  try {
    saltHex = await saltProvider.saltHexForBrand(brandId);
  } catch (e) {
    log.error(`connector=${ciId} — salt fetch failed`, { detail: e });
    return;
  }

  // GUC-after-enumerate (MT-1): brand context set BEFORE any brand-scoped read/write.
  await setSyncState(pool, brandId, ciId, 'syncing', null);

  // DEV: generate brand-tied synthetic AWB records from the brand's own recognized orders so the GoKwik
  // analytics actually populate (the static fixture's order_ids match no real brand). Gated by
  // GOKWIK_SYNTH_FROM_ORDERS (on by default; set '0' to disable). Empty on failure (non-fatal).
  const extraRecords =
    process.env['GOKWIK_SYNTH_FROM_ORDERS'] !== '0'
      ? await generateSyntheticAwbFromOrders(pool, brandId)
      : [];
  const apiClient = new GokwikAwbClient(creds, extraRecords);

  let emitted = 0;
  try {
    emitted = await repullAwbCursor({ ciId, brandId, pool, producer, apiClient, saltHex });
  } catch (err) {
    // Auth rejection (401/403 from the real client) → reconnect signal + observability parity.
    if (String(err).includes(GOKWIK_AUTH_ERROR)) {
      recordConnectorAuthRejected('gokwik');
      log.error(`connector=${ciId} — gokwik auth error (RECONNECT_REQUIRED)`, { err: err });
      await setSyncState(pool, brandId, ciId, 'error', 'gokwik auth error — RECONNECT_REQUIRED');
      return;
    }
    log.error(`connector=${ciId} cursor=${AWB_CURSOR_RESOURCE} error`, { err: err });
    await setSyncState(pool, brandId, ciId, 'error', 'awb re-pull failed');
    return;
  }

  await setSyncState(pool, brandId, ciId, 'connected', null);
  log.info(`connector=${ciId} COMPLETED emitted=${emitted}`);
}

// ── Cursor re-pull (45-day trailing window, restates terminal states) ─────────

interface CursorRepullParams {
  ciId: string;
  brandId: string;
  pool: Pool;
  producer: Producer;
  apiClient: GokwikAwbClient;
  saltHex: string;
}

async function repullAwbCursor(params: CursorRepullParams): Promise<number> {
  const { ciId, brandId, pool, producer, apiClient, saltHex } = params;

  // FOR UPDATE SKIP LOCKED — overlap-lock on the single AWB cursor resource.
  const lockAcquired = await acquireCursorLock(pool, brandId, ciId, AWB_CURSOR_RESOURCE);
  if (!lockAcquired) {
    log.info(`connector=${ciId} cursor=${AWB_CURSOR_RESOURCE} — locked by another worker, skipping`);
    return 0;
  }

  const priorCursorValue = await getCursorValue(pool, brandId, ciId, AWB_CURSOR_RESOURCE);

  const nowTs = Math.floor(Date.now() / 1000);
  const windowStartTs = nowTs - Math.floor(AWB_WINDOW_MS / 1000);

  // Re-read the WHOLE trailing window so terminal-state transitions are restated.
  // Cap the lower bound at the window start even if a stored cursor is older — the window
  // is intentionally wide (45d) so late RTO/Delivered transitions are always re-pulled.
  const fromTs = priorCursorValue
    ? Math.max(parseInt(priorCursorValue, 10), windowStartTs)
    : windowStartTs;
  // The restatement guarantee: we always start no later than (now - window), so any AWB whose
  // status changed within the last 45 days is re-read and re-emitted (idempotent via event_id).
  const effectiveFromTs = windowStartTs;   // ALWAYS re-scan the full window for restatement
  const toTs = nowTs;

  log.info(`[gokwik-awb-repull] connector=${ciId} cursor=${AWB_CURSOR_RESOURCE} ` +
        `from=${effectiveFromTs} to=${toTs} (priorHighWater=${fromTs})`);

  let skip = 0;
  let recordsProcessed = 0;
  let maxChangedAt: number | null = priorCursorValue ? parseInt(priorCursorValue, 10) : null;

  while (true) {
    const page = await apiClient.fetchAwbPage(effectiveFromTs, toTs, skip);
    if (page.items.length === 0) break;

    const messages = [];
    for (const rawRecord of page.items) {
      const record = rawRecord as GokwikAwbRecord;
      const orderId = record.order_id ? String(record.order_id) : '';
      const rawAwb = record.awb_number ? String(record.awb_number) : '';
      const rawStatus = record.status ? String(record.status) : '';
      if (!orderId || !rawStatus) continue;

      const mapped = mapGokwikAwb(record, brandId, saltHex, page.dataSource);
      const statusChangedAt = mapped.properties.status_changed_at;

      // DISTINCT per (awb, status, status_changed_at) → restatement-safe Bronze key.
      const eventId = uuidV5FromAwb(brandId, rawAwb, rawStatus, statusChangedAt);

      const envelope = CollectorEventV1Schema.parse({
        schema_version: '1',
        event_id: eventId,
        brand_id: brandId,                  // from fn result (MT-1) — never from payload
        correlation_id: `gokwik-awb-repull:${ciId}:${eventId}`,
        event_name: GOKWIK_AWB_STATUS_V1_EVENT_NAME,
        occurred_at: mapped.occurred_at,
        ingested_at: new Date().toISOString(),
        properties: {
          ...(mapped.properties as unknown as Record<string, unknown>),
          // DEV-HONESTY: stamp the synthetic flag onto processing_flags so Bronze carries it.
          processing_flags: { _synthetic: page.dataSource === 'synthetic' },
        },
      });

      messages.push({
        key: buildPartitionKey(brandId, eventId),
        value: Buffer.from(JSON.stringify(envelope)),
      });

      const changedSec = Math.floor(Date.parse(statusChangedAt) / 1000);
      if (!Number.isNaN(changedSec) && (maxChangedAt === null || changedSec > maxChangedAt)) {
        maxChangedAt = changedSec;
      }
      recordsProcessed++;
    }

    if (messages.length > 0) {
      await producer.send({ topic: LIVE_TOPIC, messages });
    }
    log.info(`[gokwik-awb-repull] connector=${ciId} cursor=${AWB_CURSOR_RESOURCE} ` +
            `skip=${skip} emitted=${messages.length} total=${recordsProcessed}`);

    if (maxChangedAt !== null) {
      await upsertCursorValue(pool, brandId, ciId, AWB_CURSOR_RESOURCE, String(maxChangedAt));
    }

    if (!page.hasMore) break;
    skip += GOKWIK_AWB_PAGE_SIZE;
  }

  log.info(`connector=${ciId} cursor=${AWB_CURSOR_RESOURCE} DONE records=${recordsProcessed}`);
  return recordsProcessed;
}

// ── Sync status (mirrors razorpay-settlement-repull setSyncState exactly) ─────

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
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    // UPSERT, not UPDATE: a freshly-connected connector has no connector_sync_status row yet (it is
    // created lazily by the first sync, not at connect time), so an UPDATE-only write is a silent
    // no-op and the UI is stuck on "Not synced yet" forever. INSERT ... ON CONFLICT guarantees the row
    // exists after the first repull. (brand_id, connector_instance_id) is UNIQUE.
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

// ── Credentials resolver (prod: AWS Secrets Manager; dev: dev_secret bundle; NEVER log — I-S09) ──

async function resolveGokwikCredentials(secretRef: string): Promise<GokwikApiCredentials | null> {
  // PROD: the credential bundle is stored in AWS Secrets Manager at connect time (core's
  // AwsSecretsManager.storeSecret). Resolve it from there — dev_secret only exists in dev, so the
  // legacy dev-only path below returned null in prod → "credentials not found (RECONNECT_REQUIRED)"
  // even though the secret was present. Mirrors the shopify worker-secrets prod/dev split.
  if (process.env['NODE_ENV'] === 'production') {
    try {
      const { AwsSecretsManager } = await import('@brain/connector-secrets');
      const region = process.env['BRAIN_AWS_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1';
      const mgr = new AwsSecretsManager(region, '', process.env['KMS_KEY_ID'] ?? '');
      const bundle = await mgr.getSecret(secretRef); // GetSecretValue → parsed JSON (honors AWS_ENDPOINT_URL)
      if (bundle && typeof bundle['appid'] === 'string' && typeof bundle['appsecret'] === 'string') {
        return { appid: bundle['appid'], appsecret: bundle['appsecret'] };
      }
      log.error(`[gokwik] secret ${secretRef.slice(-24)} resolved but missing appid/appsecret`);
    } catch (err) {
      log.error('[gokwik] AwsSecretsManager getSecret failed', { err });
    }
    // fall through to the env fallback (GOKWIK_APPID/APPSECRET) below; dev_secret won't exist in prod.
  }

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
        const bundle = JSON.parse(raw) as GokwikSecretBundle;
        if (bundle.appid && bundle.appsecret) {
          return { appid: bundle.appid, appsecret: bundle.appsecret };
        }
      } catch {
        // Malformed bundle — fall through
      }
    }
    const envAppId = process.env['GOKWIK_APPID'];
    const envAppSecret = process.env['GOKWIK_APPSECRET'];
    if (envAppId && envAppSecret) {
      return { appid: envAppId, appsecret: envAppSecret };
    }
    return null;
  } finally {
    await devPool.end();
  }
}

// ── Entrypoint (dev trigger MB-6) ─────────────────────────────────────────────

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  const ciArg = process.argv[2];
  run(ciArg).catch((err) => {
    log.error('fatal', { err: err });
    process.exit(1);
  });
}

export {
  enumerateConnectors,
  setSyncState,
  AWB_CURSOR_RESOURCE,
  AWB_WINDOW_MS,
};
