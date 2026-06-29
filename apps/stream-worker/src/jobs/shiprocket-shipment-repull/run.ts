/**
 * shiprocket-shipment-repull/run.ts — Shiprocket shipment-lifecycle trailing-window re-pull.
 *
 * Shiprocket is Brain's logistics source of truth (GoKwik is webhook-first payments/checkout and
 * has no AWB-read API — its synthetic logistics re-pull was retired in 0117). Shipment outcomes
 * (RTO/Delivered) are a LATE-CHANGING lifecycle (terminal states arrive days/weeks after dispatch),
 * so this job re-reads a 45-day trailing window every run and RESTATES terminal states idempotently.
 *
 * Architecture:
 *   1. Enumerate via list_shiprocket_connectors_for_repull() — SECURITY DEFINER, NO GUC at
 *      enumerate time (durable rule: system-job-force-rls-enumeration).
 *   2. GUC set AFTER enumerate, before any brand-scoped read/write (MT-1).
 *   3. Single cursor resource 'shipment.lifecycle', FOR UPDATE SKIP LOCKED (overlap-safe).
 *   4. WINDOW = 45 days — terminal states arrive late.
 *   5. Per shipment record → map via @brain/shiprocket-mapper (awb hashed at boundary, order_id
 *      passthrough). event_id = uuidV5FromShipment(brand, awb, status, status_changed_at) →
 *      DISTINCT per transition → a new Bronze row per state change → terminal RTO/Delivered RESTATED.
 *   6. Emit shiprocket.shipment_status.v1 to the live lane → cursor high-water advance → sync_status.
 *
 * The re-pull does NOT do the ledger join — it lands events on the live lane. ShipmentLedgerConsumer
 * turns terminal RTO/Delivered into the recognition ledger intent. Shiprocket is the sole logistics
 * source (GoKwik is webhook-first payments/checkout with no logistics-read API — retired in 0117).
 *
 * DEV-HONESTY: the read source is a labelled SYNTHETIC fixture (ShiprocketShipmentClient) — every
 * event carries data_source='synthetic' + processing_flags._synthetic=true. NEVER presented as live.
 *
 * NEVER log email/password/token (I-S09) or raw AWB numbers (hashed at the mapper boundary).
 * brand_id ALWAYS from the enumeration fn (MT-1) — NEVER from env or payload.
 *
 * Dev trigger (MB-6): pass connector_instance_id as argv[2] to re-pull a single connector.
 */

import { Pool } from 'pg';
import { loadStreamWorkerConfig } from '@brain/config';
import { updateConnectorInstanceHealth, recoverConnectorInstanceHealth } from '../../infrastructure/pg/ConnectorInstanceHealthRepository.js';
import { Kafka, type Producer } from 'kafkajs';
import { createIdempotentProducer } from '../../infrastructure/kafka/idempotent-producer.js';
import { buildPartitionKey } from '@brain/events';
import { injectKafkaTraceContext } from '@brain/observability';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import {
  mapShiprocketShipment,
  uuidV5FromShipment,
  SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME,
  type ShiprocketShipmentRecord,
} from '@brain/shiprocket-mapper';
import {
  ShiprocketShipmentClient,
  SHIPROCKET_SHIPMENT_PAGE_SIZE,
} from './shiprocket-client.js';
import { SHIPROCKET_AUTH_ERROR, type ShiprocketApiCredentials } from './shiprocket-token-provider.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { createSaltProvider, type SaltProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { log } from '../../log.js';
import { acquireCursorLock, getCursorValue, upsertCursorValue } from '../../infrastructure/pg/CursorRepository.js';
import { SyncRunRepository } from '../../infrastructure/pg/SyncRunRepository.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;

const BROKERS = cfg.KAFKA_BROKERS.split(',');
// intentional raw: ENV/LIVE_TOPIC default is NODE_ENV-derived (topic-prefix selection).
const ENV = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
const LIVE_TOPIC = process.env['COLLECTOR_TOPIC'] ?? `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

/** Single cursor resource. WINDOW = 45 days — terminal shipment states arrive late. */
const SHIPMENT_CURSOR_RESOURCE = 'shipment.lifecycle' as const;
const SHIPMENT_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

interface ShiprocketConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  secret_ref: string;
  shiprocket_channel_id: string | null;
}

/** Dev credentials bundle parsed from the secret. NEVER logged (I-S09). */
interface ShiprocketSecretBundle {
  email: string;
  password: string;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({
    clientId: 'shiprocket-shipment-repull',
    brokers: BROKERS,
    retry: { retries: 5 },
  });
  const producer = createIdempotentProducer(kafka);

  const saltProvider = createSaltProvider(DB_URL);
  const syncRunRepo = new SyncRunRepository(pool);

  try {
    await producer.connect();
    log.info(`starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    const connectors = await enumerateConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('no connected Shiprocket connectors found — exiting');
      return;
    }
    log.info(`found ${connectors.length} connector(s) to re-pull`);

    for (const connector of connectors) {
      await repullConnector({ connector, pool, producer, saltProvider, syncRunRepo });
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
): Promise<ShiprocketConnectorRow[]> {
  if (targetConnectorInstanceId) {
    const result = await pool.query<ShiprocketConnectorRow>(
      `SELECT connector_instance_id, brand_id, secret_ref, shiprocket_channel_id
       FROM list_shiprocket_connectors_for_repull()
       WHERE connector_instance_id = $1`,
      [targetConnectorInstanceId],
    );
    return result.rows;
  }
  const result = await pool.query<ShiprocketConnectorRow>(
    `SELECT connector_instance_id, brand_id, secret_ref, shiprocket_channel_id
     FROM list_shiprocket_connectors_for_repull()`,
  );
  return result.rows;
}

// ── Per-connector re-pull ─────────────────────────────────────────────────────

interface RepullParams {
  connector: ShiprocketConnectorRow;
  pool: Pool;
  producer: Producer;
  saltProvider: SaltProvider;
  syncRunRepo: SyncRunRepository;
}

async function repullConnector(params: RepullParams): Promise<void> {
  const { connector, pool, producer, saltProvider, syncRunRepo } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = connector;

  log.info(`connector=${ciId} brand=${brandId}`);

  const runId = SyncRunRepository.newRunId();
  const startedAt = await syncRunRepo.startRun({
    runId, brandId, provider: 'shiprocket', runType: 'repull',
    correlationId: `shiprocket-shipment-repull:${ciId}:${runId}`,
  });

  const creds = await resolveShiprocketCredentials(secretRef);
  if (!creds) {
    log.error(`connector=${ciId} — credentials not found (RECONNECT_REQUIRED)`);
    // Mark the tile RECONNECT_REQUIRED (not just close the run) so the UI prompts reconnect and the
    // scheduler backs this connector off (0112) instead of re-dispatching a doomed repull every tick.
    await setSyncState(pool, brandId, ciId, 'error', 'shiprocket credentials not found — RECONNECT_REQUIRED');
    await syncRunRepo.closeRun({ runId, brandId, startedAt, status: 'failed', errorClass: 'AUTH_ERROR', errorDetail: 'credentials not found — RECONNECT_REQUIRED' });
    return;
  }

  let saltHex: string;
  try {
    saltHex = await saltProvider.saltHexForBrand(brandId);
  } catch (e) {
    log.error(`connector=${ciId} — salt fetch failed`, { detail: e });
    await syncRunRepo.closeRun({ runId, brandId, startedAt, status: 'failed', errorClass: 'CONFIG_ERROR', errorDetail: String(e) });
    return;
  }

  // GUC-after-enumerate (MT-1): brand context set BEFORE any brand-scoped read/write.
  await setSyncState(pool, brandId, ciId, 'syncing', null);

  const apiClient = new ShiprocketShipmentClient(creds);

  let emitted = 0;
  try {
    emitted = await repullShipmentCursor({ ciId, brandId, pool, producer, apiClient, saltHex });
  } catch (err) {
    // Auth rejection (401/403 from the real client) → reconnect signal + observability parity.
    if (String(err).includes(SHIPROCKET_AUTH_ERROR)) {
      recordConnectorAuthRejected('shiprocket');
      log.error(`connector=${ciId} — shiprocket auth error (RECONNECT_REQUIRED)`, { err });
      await setSyncState(pool, brandId, ciId, 'error', 'shiprocket auth error — RECONNECT_REQUIRED');
      await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
      await syncRunRepo.closeRun({ runId, brandId, startedAt, status: 'failed', errorClass: 'AUTH_ERROR', errorDetail: 'shiprocket auth error — RECONNECT_REQUIRED' });
      return;
    }
    log.error(`connector=${ciId} cursor=${SHIPMENT_CURSOR_RESOURCE} error`, { err });
    await setSyncState(pool, brandId, ciId, 'error', 'shipment re-pull failed');
    await syncRunRepo.closeRun({ runId, brandId, startedAt, status: 'failed', errorClass: 'FETCH_ERROR', errorDetail: String(err) });
    return;
  }

  await setSyncState(pool, brandId, ciId, 'connected', null);
  // Recovery edge: a successful repull self-heals a prior TokenExpired/RateLimited badge back to
  // Healthy/safe (no-op if already Healthy or in a sticky state). Symmetric to the error branch's
  // updateConnectorInstanceHealth('token_expired') above.
  await recoverConnectorInstanceHealth(pool, brandId, ciId);
  await syncRunRepo.closeRun({ runId, brandId, startedAt, status: 'succeeded', rowsIngested: emitted });
  log.info(`connector=${ciId} COMPLETED emitted=${emitted}`);
}

// ── Cursor re-pull (45-day trailing window, restates terminal states) ─────────

interface CursorRepullParams {
  ciId: string;
  brandId: string;
  pool: Pool;
  producer: Producer;
  apiClient: ShiprocketShipmentClient;
  saltHex: string;
}

async function repullShipmentCursor(params: CursorRepullParams): Promise<number> {
  const { ciId, brandId, pool, producer, apiClient, saltHex } = params;

  // FOR UPDATE SKIP LOCKED — overlap-lock on the single shipment cursor resource.
  const lockAcquired = await acquireCursorLock(pool, brandId, ciId, SHIPMENT_CURSOR_RESOURCE);
  if (!lockAcquired) {
    log.info(`connector=${ciId} cursor=${SHIPMENT_CURSOR_RESOURCE} — locked by another worker, skipping`);
    return 0;
  }

  const priorCursorValue = await getCursorValue(pool, brandId, ciId, SHIPMENT_CURSOR_RESOURCE);

  const nowTs = Math.floor(Date.now() / 1000);
  const windowStartTs = nowTs - Math.floor(SHIPMENT_WINDOW_MS / 1000);

  // Re-read the WHOLE trailing window so terminal-state transitions are restated.
  const fromTs = priorCursorValue
    ? Math.max(parseInt(priorCursorValue, 10), windowStartTs)
    : windowStartTs;
  const effectiveFromTs = windowStartTs;   // ALWAYS re-scan the full window for restatement
  const toTs = nowTs;

  log.info(`[shiprocket-shipment-repull] connector=${ciId} cursor=${SHIPMENT_CURSOR_RESOURCE} ` +
        `from=${effectiveFromTs} to=${toTs} (priorHighWater=${fromTs})`);

  let skip = 0;
  let recordsProcessed = 0;
  let maxChangedAt: number | null = priorCursorValue ? parseInt(priorCursorValue, 10) : null;

  while (true) {
    const page = await apiClient.fetchShipmentPage(effectiveFromTs, toTs, skip);
    if (page.items.length === 0) break;

    const messages = [];
    for (const rawRecord of page.items) {
      const record = rawRecord as ShiprocketShipmentRecord;
      const orderId = record.order_id ? String(record.order_id) : '';
      const rawAwb = record.awb ? String(record.awb) : '';
      const rawStatus = record.status ? String(record.status) : '';
      if (!orderId || !rawStatus) continue;

      const mapped = mapShiprocketShipment(record, brandId, saltHex, page.dataSource);
      const statusChangedAt = mapped.properties.status_changed_at;

      // DISTINCT per (awb, status, status_changed_at) → restatement-safe Bronze key.
      const eventId = uuidV5FromShipment(brandId, rawAwb, rawStatus, statusChangedAt);

      const envelope = CollectorEventV1Schema.parse({
        schema_version: '1',
        event_id: eventId,
        brand_id: brandId,                  // from fn result (MT-1) — never from payload
        correlation_id: `shiprocket-shipment-repull:${ciId}:${eventId}`,
        event_name: SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME,
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
      // OTel trace-context propagation (OBS-1/OBS-2): stamp traceparent on each
      // message so the bronze-bridge consumer resumes this repull's trace.
      const traceHeaders: Record<string, Buffer | string> = {};
      injectKafkaTraceContext(traceHeaders);
      await producer.send({ topic: LIVE_TOPIC, messages: messages.map((m) => ({ ...m, headers: traceHeaders })) });
    }
    log.info(`[shiprocket-shipment-repull] connector=${ciId} cursor=${SHIPMENT_CURSOR_RESOURCE} ` +
            `skip=${skip} emitted=${messages.length} total=${recordsProcessed}`);

    if (maxChangedAt !== null) {
      await upsertCursorValue(pool, brandId, ciId, SHIPMENT_CURSOR_RESOURCE, String(maxChangedAt));
    }

    if (!page.hasMore) break;
    skip += SHIPROCKET_SHIPMENT_PAGE_SIZE;
  }

  log.info(`connector=${ciId} cursor=${SHIPMENT_CURSOR_RESOURCE} DONE records=${recordsProcessed}`);
  return recordsProcessed;
}

// ── Sync status (connector re-pull setSyncState pattern) ──────────────

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
    // UPSERT, not UPDATE (connector re-pull pattern): a missing connect-time row would make an
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
    log.error(`sync_status update failed (non-fatal)`, { err });
  } finally {
    client.release();
  }
}

// ── Credentials resolver (prod: AWS Secrets Manager; dev: dev_secret bundle; NEVER log — I-S09) ──

async function resolveShiprocketCredentials(secretRef: string): Promise<ShiprocketApiCredentials | null> {
  if (process.env['NODE_ENV'] === 'production') {
    try {
      const { AwsSecretsManager } = await import('@brain/connector-secrets');
      const region = process.env['BRAIN_AWS_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1';
      const mgr = new AwsSecretsManager(region, '', process.env['KMS_KEY_ID'] ?? '');
      const bundle = await mgr.getSecret(secretRef);
      if (bundle && typeof bundle['email'] === 'string' && typeof bundle['password'] === 'string') {
        return { email: bundle['email'], password: bundle['password'] };
      }
      log.error(`[shiprocket] secret ${secretRef.slice(-24)} resolved but missing email/password`);
    } catch (err) {
      log.error('[shiprocket] AwsSecretsManager getSecret failed', { err });
    }
    // fall through to the env fallback below; dev_secret won't exist in prod.
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
        const bundle = JSON.parse(raw) as ShiprocketSecretBundle;
        if (bundle.email && bundle.password) {
          return { email: bundle.email, password: bundle.password };
        }
      } catch {
        // Malformed bundle — fall through
      }
    }
    const envEmail = process.env['SHIPROCKET_EMAIL'];
    const envPassword = process.env['SHIPROCKET_PASSWORD'];
    if (envEmail && envPassword) {
      return { email: envEmail, password: envPassword };
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
    log.error('fatal', { err });
    process.exit(1);
  });
}

export {
  enumerateConnectors,
  setSyncState,
  SHIPMENT_CURSOR_RESOURCE,
  SHIPMENT_WINDOW_MS,
};
