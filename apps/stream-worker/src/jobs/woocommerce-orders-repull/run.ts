/**
 * woocommerce-orders-repull/run.ts — WooCommerce REST order backfill + incremental re-pull.
 *
 * Mirrors shopify-repull/run.ts. WooCommerce is the SECOND storefront source; it emits the SHARED
 * canonical `order.live.v1` event (via @brain/woocommerce-mapper) so orders flow through the
 * EXISTING order→ledger + silver_order_state pipeline with ZERO new downstream code.
 *
 * Architecture (mirrors shopify-repull):
 *   1. Enumerate via list_woocommerce_connectors_for_repull() — SECURITY DEFINER, NO GUC at
 *      enumerate (durable rule system-job-force-rls-enumeration).
 *   2. GUC set AFTER enumerate (MT-1). FOR UPDATE SKIP LOCKED on the 'orders.repull' cursor.
 *   3. Page WooCommerce orders by date_modified asc, from a trailing window / prior high-water.
 *   4. Per order → mapWooOrderToEvent → order.live.v1; event_id = uuidV5FromOrderLive(brand, order,
 *      updatedAtMs) → DISTINCT per state change → Bronze restated idempotently.
 *   5. Emit to the live lane → advance cursor (max date_modified ms) → sync_status.
 *
 * DEV-HONESTY: the order read source is a labelled SYNTHETIC fixture (WooCommerceClient) — every
 * event carries data_source='synthetic'. NEVER presented as live.
 *
 * NEVER log consumer_key/secret (I-S09) or raw PII (hashed at the mapper boundary).
 * brand_id ALWAYS from the enumeration fn (MT-1).
 *
 * Dev trigger (MB-6): pass connector_instance_id as argv[2].
 */

import { Pool } from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import { buildPartitionKey } from '@brain/events';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import {
  mapWooOrderToEvent,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  type WooOrderShape,
} from '@brain/woocommerce-mapper';
import {
  WooCommerceClient,
  WOOCOMMERCE_PAGE_SIZE,
  WOOCOMMERCE_AUTH_ERROR,
  type WooCommerceApiCredentials,
} from './woocommerce-client.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { SaltProvider, LocalSecretsProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { resolveSaltHex } from '@brain/identity-core';
import { log } from '../../log.js';
import { acquireCursorLock, getCursorValue, upsertCursorValue } from '../../infrastructure/pg/CursorRepository.js';
import { SyncRunRepository } from '../../infrastructure/pg/SyncRunRepository.js';

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const ENV = process.env['APP_ENV'] ?? 'dev';
const LIVE_TOPIC = process.env['COLLECTOR_TOPIC'] ?? `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;
const REGION_CODE = process.env['BRAIN_REGION_CODE'] ?? 'IN';

const ORDERS_CURSOR_RESOURCE = 'orders.repull' as const;
const ORDERS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90-day trailing window (storefront backfill)

interface WooConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  secret_ref: string;
  woocommerce_site_url: string | null;
}

interface WooSecretBundle {
  consumer_key: string;
  consumer_secret: string;
}

export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({ clientId: 'woocommerce-orders-repull', brokers: BROKERS, retry: { retries: 5 } });
  const producer = kafka.producer({ idempotent: true });
  const saltProvider = new SaltProvider(new LocalSecretsProvider(), resolveSaltHex);
  const syncRunRepo = new SyncRunRepository(pool);

  try {
    await producer.connect();
    log.info(`starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    const connectors = await enumerateConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('no connected WooCommerce connectors found — exiting');
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

async function enumerateConnectors(
  pool: Pool,
  targetConnectorInstanceId?: string,
): Promise<WooConnectorRow[]> {
  if (targetConnectorInstanceId) {
    const result = await pool.query<WooConnectorRow>(
      `SELECT connector_instance_id, brand_id, secret_ref, woocommerce_site_url
       FROM list_woocommerce_connectors_for_repull()
       WHERE connector_instance_id = $1`,
      [targetConnectorInstanceId],
    );
    return result.rows;
  }
  const result = await pool.query<WooConnectorRow>(
    `SELECT connector_instance_id, brand_id, secret_ref, woocommerce_site_url
     FROM list_woocommerce_connectors_for_repull()`,
  );
  return result.rows;
}

interface RepullParams {
  connector: WooConnectorRow;
  pool: Pool;
  producer: Producer;
  saltProvider: SaltProvider;
  syncRunRepo: SyncRunRepository;
}

async function repullConnector(params: RepullParams): Promise<void> {
  const { connector, pool, producer, saltProvider, syncRunRepo } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef, woocommerce_site_url: siteUrl } = connector;

  log.info(`connector=${ciId} brand=${brandId}`);

  const runId = SyncRunRepository.newRunId();
  const startedAt = await syncRunRepo.startRun({
    runId, brandId, provider: 'woocommerce', runType: 'repull',
    correlationId: `woocommerce-orders-repull:${ciId}:${runId}`,
  });

  const creds = await resolveWooCredentials(secretRef, siteUrl ?? '');
  if (!creds) {
    log.error(`connector=${ciId} — credentials not found (RECONNECT_REQUIRED)`);
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

  await setSyncState(pool, brandId, ciId, 'syncing', null);

  const apiClient = new WooCommerceClient(creds);

  let emitted = 0;
  try {
    emitted = await repullOrdersCursor({ ciId, brandId, pool, producer, apiClient, saltHex });
  } catch (err) {
    if (String(err).includes(WOOCOMMERCE_AUTH_ERROR)) {
      recordConnectorAuthRejected('woocommerce');
      log.error(`connector=${ciId} — woocommerce auth error (RECONNECT_REQUIRED)`, { err });
      await setSyncState(pool, brandId, ciId, 'error', 'woocommerce auth error — RECONNECT_REQUIRED');
      await syncRunRepo.closeRun({ runId, brandId, startedAt, status: 'failed', errorClass: 'AUTH_ERROR', errorDetail: 'woocommerce auth error — RECONNECT_REQUIRED' });
      return;
    }
    log.error(`connector=${ciId} cursor=${ORDERS_CURSOR_RESOURCE} error`, { err });
    await setSyncState(pool, brandId, ciId, 'error', 'woocommerce re-pull failed');
    await syncRunRepo.closeRun({ runId, brandId, startedAt, status: 'failed', errorClass: 'FETCH_ERROR', errorDetail: String(err) });
    return;
  }

  await setSyncState(pool, brandId, ciId, 'connected', null);
  await syncRunRepo.closeRun({ runId, brandId, startedAt, status: 'succeeded', rowsIngested: emitted });
  log.info(`connector=${ciId} COMPLETED emitted=${emitted}`);
}

interface CursorRepullParams {
  ciId: string;
  brandId: string;
  pool: Pool;
  producer: Producer;
  apiClient: WooCommerceClient;
  saltHex: string;
}

async function repullOrdersCursor(params: CursorRepullParams): Promise<number> {
  const { ciId, brandId, pool, producer, apiClient, saltHex } = params;

  const lockAcquired = await acquireCursorLock(pool, brandId, ciId, ORDERS_CURSOR_RESOURCE);
  if (!lockAcquired) {
    log.info(`connector=${ciId} cursor=${ORDERS_CURSOR_RESOURCE} — locked by another worker, skipping`);
    return 0;
  }

  const priorCursorValue = await getCursorValue(pool, brandId, ciId, ORDERS_CURSOR_RESOURCE);
  const windowStartMs = Date.now() - ORDERS_WINDOW_MS;
  // Incremental from the prior high-water, but never earlier than the trailing window floor.
  const fromMs = priorCursorValue
    ? Math.max(parseInt(priorCursorValue, 10), windowStartMs)
    : windowStartMs;
  const modifiedAfterIso = new Date(fromMs).toISOString();

  log.info(`[woocommerce-orders-repull] connector=${ciId} from=${modifiedAfterIso} (priorHighWater=${priorCursorValue ?? 'none'})`);

  let page = 1;
  let recordsProcessed = 0;
  let maxModifiedMs: number | null = priorCursorValue ? parseInt(priorCursorValue, 10) : null;

  while (true) {
    const pageResult = await apiClient.fetchOrdersPage(modifiedAfterIso, page);
    if (pageResult.orders.length === 0) break;

    const messages = [];
    for (const rawOrder of pageResult.orders) {
      const order = rawOrder as WooOrderShape;
      const orderId = order.id != null ? String(order.id) : '';
      if (!orderId) continue;

      const mapped = mapWooOrderToEvent(order, brandId, saltHex, REGION_CODE, pageResult.dataSource);
      const updatedAtMs = Date.parse(mapped.occurred_at);
      const eventId = uuidV5FromOrderLive(brandId, orderId, updatedAtMs);

      const envelope = CollectorEventV1Schema.parse({
        schema_version: '1',
        event_id: eventId,
        brand_id: brandId, // from fn result (MT-1) — never from payload
        correlation_id: `woocommerce-orders-repull:${ciId}:${eventId}`,
        event_name: ORDER_LIVE_V1_EVENT_NAME,
        occurred_at: mapped.occurred_at,
        ingested_at: new Date().toISOString(),
        properties: {
          ...(mapped.properties as unknown as Record<string, unknown>),
          processing_flags: { _synthetic: pageResult.dataSource === 'synthetic' },
        },
      });

      messages.push({
        key: buildPartitionKey(brandId, eventId),
        value: Buffer.from(JSON.stringify(envelope)),
      });

      if (!Number.isNaN(updatedAtMs) && (maxModifiedMs === null || updatedAtMs > maxModifiedMs)) {
        maxModifiedMs = updatedAtMs;
      }
      recordsProcessed++;
    }

    if (messages.length > 0) {
      await producer.send({ topic: LIVE_TOPIC, messages });
    }
    log.info(`[woocommerce-orders-repull] connector=${ciId} page=${page} emitted=${messages.length} total=${recordsProcessed}`);

    if (maxModifiedMs !== null) {
      await upsertCursorValue(pool, brandId, ciId, ORDERS_CURSOR_RESOURCE, String(maxModifiedMs));
    }

    if (!pageResult.hasMore) break;
    page += 1;
    if (page > 10000) break; // defensive bound
  }

  log.info(`connector=${ciId} cursor=${ORDERS_CURSOR_RESOURCE} DONE records=${recordsProcessed}`);
  return recordsProcessed;
}

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
    log.error(`sync_status update failed (non-fatal)`, { err });
  } finally {
    client.release();
  }
}

async function resolveWooCredentials(
  secretRef: string,
  siteUrl: string,
): Promise<WooCommerceApiCredentials | null> {
  if (process.env['NODE_ENV'] === 'production') {
    try {
      const { AwsSecretsManager } = await import('@brain/connector-secrets');
      const region = process.env['BRAIN_AWS_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1';
      const mgr = new AwsSecretsManager(region, '', process.env['KMS_KEY_ID'] ?? '');
      const bundle = await mgr.getSecret(secretRef);
      if (bundle && typeof bundle['consumer_key'] === 'string' && typeof bundle['consumer_secret'] === 'string') {
        return { consumer_key: bundle['consumer_key'], consumer_secret: bundle['consumer_secret'], site_url: siteUrl };
      }
      log.error(`[woocommerce] secret ${secretRef.slice(-24)} resolved but missing consumer_key/secret`);
    } catch (err) {
      log.error('[woocommerce] AwsSecretsManager getSecret failed', { err });
    }
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
        const bundle = JSON.parse(raw) as WooSecretBundle;
        if (bundle.consumer_key && bundle.consumer_secret) {
          return { consumer_key: bundle.consumer_key, consumer_secret: bundle.consumer_secret, site_url: siteUrl };
        }
      } catch {
        // malformed — fall through
      }
    }
    const envKey = process.env['WOOCOMMERCE_CONSUMER_KEY'];
    const envSecret = process.env['WOOCOMMERCE_CONSUMER_SECRET'];
    if (envKey && envSecret) {
      return { consumer_key: envKey, consumer_secret: envSecret, site_url: siteUrl };
    }
    return null;
  } finally {
    await devPool.end();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  const ciArg = process.argv[2];
  run(ciArg).catch((err) => {
    log.error('fatal', { err });
    process.exit(1);
  });
}

export { enumerateConnectors, setSyncState, ORDERS_CURSOR_RESOURCE, ORDERS_WINDOW_MS };
