/**
 * ingestion-backfill/run.ts — the GENERIC resumable, chunked, multi-resource backfill job.
 *
 * This is the proof of the ingestion framework: ONE job that can backfill ANY declared resource of
 * Shopify or WooCommerce (and trivially any future connector) by composing @brain/connector-core's
 * `runResumableBackfill` with a per-resource page-fetcher and the runtime sinks. Compared to the
 * legacy shopify-backfill (one bespoke job hand-coded for orders only), adding a resource here is a
 * MANIFEST + FETCHER change, not new lifecycle code.
 *
 * What the driver guarantees (composed, not re-implemented here):
 *   - RESUMABLE / CHUNKED — `maxChunksThisRun` runs a bounded slice of pages then pauses; the next
 *     run resumes from the persisted cursor in jobs.resource_backfill_state (never restarts).
 *   - DEDUP — each record's event_id is derived deterministically from the manifest's
 *     dedupKeyStrategy, so a replay/overlap is dropped by Bronze on event_id.
 *   - NO LOSS — each event is delivered with bounded retry → DLQ spool (never dropped).
 *
 * Brand isolation (MT-1 / NN-1): brand_id ALWAYS comes from the enumeration fn / connector row,
 * never a payload. Every brand-scoped DB op sets app.current_brand_id first (the repo + sinks do).
 *
 * Invocation (dev trigger):
 *   node dist/jobs/ingestion-backfill/run.js <provider> <connector_instance_id> <resource> [chunks]
 *     provider              'shopify' | 'woocommerce'
 *     connector_instance_id the connector to backfill
 *     resource              e.g. 'products' | 'customers' | 'refunds' | 'fulfillments' | 'orders'
 *     chunks                optional per-run page budget (default: run to completion)
 *
 * Secrets / PII are NEVER logged (I-S09); raw PII is hashed inside the pure mappers (D-10).
 */

import { Pool } from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import {
  runResumableBackfill,
  getResource,
  type IResourcePageFetcher,
  type IngestionManifest,
} from '@brain/connector-core';
import { SHOPIFY_MANIFEST } from '@brain/shopify-mapper';
import { WOOCOMMERCE_MANIFEST } from '@brain/woocommerce-mapper';
import { ORDER_BACKFILL_V1_TOPIC_SUFFIX } from '@brain/contracts';
import { loadStreamWorkerConfig } from '@brain/config';
import { createIdempotentProducer } from '../../infrastructure/kafka/idempotent-producer.js';
import { createSaltProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { DlqRecordRepository } from '../../infrastructure/pg/DlqRecordRepository.js';
import { buildWorkerSecretsManager } from '../shopify-backfill/worker-secrets.js';
import { PgResourceBackfillStateRepository } from './PgResourceBackfillStateRepository.js';
import { KafkaEventSink, PgDeadLetterSink } from './sinks.js';
import {
  ShopifyProductsFetcher,
  ShopifyCustomersFetcher,
  ShopifyRefundsFetcher,
  ShopifyFulfillmentsFetcher,
} from './shopify-resource-fetchers.js';
import {
  WooOrdersFetcher,
  WooProductsFetcher,
  WooCustomersFetcher,
  WooCouponsFetcher,
  WooRefundsFetcher,
} from './woocommerce-resource-fetchers.js';
import { WooCommerceClient } from '../woocommerce-orders-repull/woocommerce-client.js';
import { resolveWooCredentialsForConnector } from './woocommerce-creds.js';
import { log } from '../../log.js';

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;
const BROKERS = cfg.KAFKA_BROKERS.split(',');
// intentional raw: NODE_ENV-derived Kafka topic-prefix selection (must precede config load).
const ENV = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
// §6.4 lane isolation: backfill events MUST go to the backfill topic (same lane the
// BackfillOrderConsumer reads) — NEVER to the live collector topic. Using the live topic
// would starve/contaminate the live consumer group and violates ADR-BF-7 / SI-3.
export const BACKFILL_TOPIC = `${ENV}.${ORDER_BACKFILL_V1_TOPIC_SUFFIX}`;
const REGION_CODE = cfg.BRAIN_REGION_CODE;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export type SupportedProvider = 'shopify' | 'woocommerce';

function manifestFor(provider: SupportedProvider): IngestionManifest {
  return provider === 'shopify' ? SHOPIFY_MANIFEST : WOOCOMMERCE_MANIFEST;
}

interface ShopifyConnectorRow {
  brand_id: string;
  shop_domain: string;
  secret_ref: string;
}

interface WooConnectorRow {
  brand_id: string;
  secret_ref: string;
  woocommerce_site_url: string | null;
}

/**
 * Load a connector instance under the brand GUC (FORCE RLS). The brand is provided by the caller
 * (INGEST_BACKFILL_BRAND_ID — the dev trigger's known brand); brand_id is NEVER inferred from a
 * payload (MT-1). connector_instance has FORCE RLS, so the brand GUC is set first; the all-zero
 * user/workspace GUCs satisfy the brand_self_read policy's uuid cast for this system job.
 */
async function loadConnector(
  pool: Pool,
  connectorInstanceId: string,
  provider: SupportedProvider,
  brandId: string,
): Promise<ShopifyConnectorRow | WooConnectorRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );
    if (provider === 'shopify') {
      const res = await client.query<ShopifyConnectorRow>(
        `SELECT brand_id, shop_domain, secret_ref
           FROM connector_instance WHERE id = $1 AND brand_id = $2`,
        [connectorInstanceId, brandId],
      );
      await client.query('COMMIT');
      return res.rows[0] ?? null;
    }
    const res = await client.query<WooConnectorRow>(
      `SELECT brand_id, secret_ref, woocommerce_site_url
         FROM connector_instance WHERE id = $1 AND brand_id = $2`,
      [connectorInstanceId, brandId],
    );
    await client.query('COMMIT');
    return res.rows[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Build the page-fetcher for one (provider, resource), resolving the connector secrets + salt.
 * Returns null if the connector/credentials cannot be resolved (RECONNECT_REQUIRED).
 */
async function buildFetcher(args: {
  pool: Pool;
  provider: SupportedProvider;
  connectorInstanceId: string;
  resource: string;
  brandId: string;
  saltHex: string;
}): Promise<IResourcePageFetcher | null> {
  const { pool, provider, connectorInstanceId, resource, brandId, saltHex } = args;

  if (provider === 'shopify') {
    const row = (await loadConnector(pool, connectorInstanceId, 'shopify', brandId)) as ShopifyConnectorRow | null;
    if (!row) return null;
    const token = await buildWorkerSecretsManager().getShopifyToken(row.secret_ref);
    if (!token) {
      recordConnectorAuthRejected('shopify');
      return null;
    }
    switch (resource) {
      case 'products':
        return new ShopifyProductsFetcher(row.shop_domain, token, brandId);
      case 'customers':
        return new ShopifyCustomersFetcher(row.shop_domain, token, brandId, saltHex, REGION_CODE);
      case 'refunds':
        return new ShopifyRefundsFetcher(row.shop_domain, token, brandId);
      case 'fulfillments':
        return new ShopifyFulfillmentsFetcher(row.shop_domain, token, brandId);
      default:
        throw new Error(`[ingestion-backfill] shopify resource "${resource}" has no fetcher here`);
    }
  }

  // woocommerce
  const row = (await loadConnector(pool, connectorInstanceId, 'woocommerce', brandId)) as WooConnectorRow | null;
  if (!row) return null;
  const creds = await resolveWooCredentialsForConnector(row.secret_ref, row.woocommerce_site_url ?? '');
  if (!creds) {
    recordConnectorAuthRejected('woocommerce');
    return null;
  }
  switch (resource) {
    case 'orders':
      return new WooOrdersFetcher(creds, brandId, saltHex, REGION_CODE);
    case 'refunds':
      // Refunds are nested under orders (no top-level list) → currency comes from each order.
      return new WooRefundsFetcher(creds, brandId);
    case 'products':
    case 'customers':
    case 'coupons': {
      // MONEY FIX: resolve the store currency ONCE (settings/general live; fixture-order currency in
      // dev) and pass it into the currency-aware mappers — never a hardcoded x100 / INR default. An
      // unresolvable currency degrades to '' → null minor amounts (the page fetch surfaces any real
      // auth error, which the driver handles by preserving the cursor).
      let currency = '';
      try {
        currency = (await new WooCommerceClient(creds).fetchStoreCurrency()) ?? '';
      } catch (err) {
        log.warn(`[ingestion-backfill] woo store-currency unresolved for ${resource} — degrading to null money`, { err });
      }
      if (resource === 'products') return new WooProductsFetcher(creds, brandId, currency);
      if (resource === 'customers') return new WooCustomersFetcher(creds, brandId, saltHex, REGION_CODE, currency);
      return new WooCouponsFetcher(creds, brandId, currency);
    }
    default:
      throw new Error(`[ingestion-backfill] woocommerce resource "${resource}" has no fetcher here`);
  }
}

export async function run(
  provider?: string,
  connectorInstanceId?: string,
  resourceName?: string,
  maxChunks?: number,
): Promise<void> {
  if (provider !== 'shopify' && provider !== 'woocommerce') {
    throw new Error(`[ingestion-backfill] provider must be 'shopify' | 'woocommerce' (got ${provider})`);
  }
  if (!connectorInstanceId) throw new Error('[ingestion-backfill] connector_instance_id required');
  if (!resourceName) throw new Error('[ingestion-backfill] resource required');

  const typedProvider = provider as SupportedProvider;
  const manifest = manifestFor(typedProvider);
  const resource = getResource(manifest, resourceName); // throws on a typo (fail loud)

  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  const kafka = new Kafka({ clientId: 'ingestion-backfill', brokers: BROKERS, retry: { retries: 5 } });
  const producer = createIdempotentProducer(kafka);
  const saltProvider = createSaltProvider(DB_URL);
  const stateRepo = new PgResourceBackfillStateRepository(pool);
  const dlqRepo = new DlqRecordRepository(pool);

  const brandId = cfg.INGEST_BACKFILL_BRAND_ID;
  if (!brandId) {
    await pool.end();
    throw new Error('[ingestion-backfill] INGEST_BACKFILL_BRAND_ID env required (the connector brand).');
  }

  try {
    await producer.connect();
    log.info(`[ingestion-backfill] provider=${provider} resource=${resourceName} topic=${BACKFILL_TOPIC}`);

    let saltHex: string;
    try {
      saltHex = await saltProvider.saltHexForBrand(brandId);
    } catch (e) {
      log.error(`[ingestion-backfill] salt fetch failed for brand=${brandId}`, { detail: e });
      return;
    }

    const fetcher = await buildFetcher({
      pool,
      provider: typedProvider,
      connectorInstanceId,
      resource: resourceName,
      brandId,
      saltHex,
    });
    if (!fetcher) {
      log.error(`[ingestion-backfill] connector/credentials not resolved (RECONNECT_REQUIRED) — exiting`);
      return;
    }

    const sink = new KafkaEventSink(producer, BACKFILL_TOPIC, `ingest:${provider}:${resourceName}:${connectorInstanceId}`);
    const dlq = new PgDeadLetterSink(dlqRepo, ENV);

    const result = await runResumableBackfill({
      brandId,
      connectorInstanceId,
      provider: typedProvider,
      resource,
      fetcher,
      sink,
      dlq,
      stateRepo,
      ...(maxChunks !== undefined ? { maxChunksThisRun: maxChunks } : {}),
    });

    log.info(
      `[ingestion-backfill] DONE provider=${provider} resource=${resourceName} ` +
        `stop=${result.stopReason} recordsThisRun=${result.recordsThisRun} ` +
        `dlqSpooled=${result.spooledToDlq} lifetime=${result.state.recordsProcessed} ` +
        `reachedAt=${result.state.reachedAt?.toISOString() ?? 'none'}`,
    );
  } finally {
    await producer.disconnect();
    await pool.end();
  }
}

/**
 * The non-order WooCommerce resources the scheduler drives onto the resumable framework every
 * connected tick. Orders are DELIBERATELY excluded — they flow on the live lane via the legacy
 * woocommerce-orders-repull (uuidV5FromOrderLive event_id); driving them here too would mint a
 * DIFFERENT deterministic event_id and double-count the order in Bronze.
 */
export const WOOCOMMERCE_SCHEDULED_BACKFILL_RESOURCES: readonly string[] = [
  'products',
  'customers',
  'coupons',
  'refunds',
];

/** Default per-resource page budget per scheduled tick (keeps a tick within the dispatch deadline;
 *  the resumable cursor carries the rest forward to the next tick). Override via
 *  WOOCOMMERCE_RESOURCE_BACKFILL_CHUNKS (clamped 1..50). */
function resolveResourceChunkBudget(): number {
  // intentional raw: optional per-tick page budget; not in the typed config schema.
  const raw = process.env['WOOCOMMERCE_RESOURCE_BACKFILL_CHUNKS'];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(parsed, 1), 50) : 5;
}

/**
 * driveResourceBackfillsForConnector — the SCHEDULING SEAM for the non-order WooCommerce resources.
 *
 * Called per-connector from the woocommerce-orders-repull run() (which the ingest-scheduler dispatches
 * every connected tick AND the sync-now claimer dispatches on demand). For each resource it composes
 * the SAME generic `runResumableBackfill` driver the CLI path uses — initial 2-year window (the
 * manifest's maxBackfillWindowMs = TWO_YEARS_MS), cursor-paginated, RESUMABLE/chunked (a bounded page
 * budget per tick), strictly DEDUPED + NO-LOSS, emitting to the BACKFILL lane (gate-off; Bronze
 * server-trusts the brand_id). A 'completed' resource is an instant no-op on later ticks.
 *
 * Fully FAIL-ISOLATED: a per-resource error (auth, fetch, salt) is logged and never propagates, so a
 * resource backfill failure can NEVER fail the order re-pull that hosts it. Reuses the caller's pool +
 * producer (no new Kafka/PG connections). brand_id is the connector row's (MT-1) — never a payload.
 */
export async function driveResourceBackfillsForConnector(args: {
  pool: Pool;
  producer: Producer;
  provider: SupportedProvider;
  connectorInstanceId: string;
  brandId: string;
  saltHex: string;
  resources?: readonly string[];
  maxChunksPerResource?: number;
}): Promise<{ resource: string; stopReason: string; recordsThisRun: number }[]> {
  const { pool, producer, provider, connectorInstanceId, brandId, saltHex } = args;
  const resources = args.resources ?? WOOCOMMERCE_SCHEDULED_BACKFILL_RESOURCES;
  const maxChunks = args.maxChunksPerResource ?? resolveResourceChunkBudget();
  const manifest = manifestFor(provider);
  const stateRepo = new PgResourceBackfillStateRepository(pool);
  const dlqRepo = new DlqRecordRepository(pool);
  const dlq = new PgDeadLetterSink(dlqRepo, ENV);
  const outcomes: { resource: string; stopReason: string; recordsThisRun: number }[] = [];

  for (const resourceName of resources) {
    try {
      const resource = getResource(manifest, resourceName); // throws on a typo (fail loud)
      const fetcher = await buildFetcher({ pool, provider, connectorInstanceId, resource: resourceName, brandId, saltHex });
      if (!fetcher) {
        log.warn(`[ingestion-backfill] resource=${resourceName} connector=${connectorInstanceId} — no fetcher (RECONNECT_REQUIRED), skipping`);
        continue;
      }
      const sink = new KafkaEventSink(producer, BACKFILL_TOPIC, `ingest:${provider}:${resourceName}:${connectorInstanceId}`);
      const result = await runResumableBackfill({
        brandId,
        connectorInstanceId,
        provider,
        resource,
        fetcher,
        sink,
        dlq,
        stateRepo,
        maxChunksThisRun: maxChunks,
      });
      outcomes.push({ resource: resourceName, stopReason: result.stopReason, recordsThisRun: result.recordsThisRun });
      log.info(
        `[ingestion-backfill] resource=${resourceName} connector=${connectorInstanceId} ` +
          `stop=${result.stopReason} recordsThisRun=${result.recordsThisRun} lifetime=${result.state.recordsProcessed}`,
      );
    } catch (err) {
      // Fail-isolated: never let a resource backfill fail the hosting order re-pull.
      log.error(`[ingestion-backfill] resource=${resourceName} connector=${connectorInstanceId} failed (isolated)`, { err });
      outcomes.push({ resource: resourceName, stopReason: 'failed', recordsThisRun: 0 });
    }
  }
  return outcomes;
}

// Path-specific entrypoint guard: this module is now ALSO imported by woocommerce-orders-repull/run
// (whose entry path also ends with "run.js"), so a bare endsWith('run.js') would fire BOTH CLI blocks
// when that job runs. Match the full directory-qualified module path so only a direct invocation of
// THIS file runs the CLI.
if (process.argv[1]?.endsWith('ingestion-backfill/run.ts') || process.argv[1]?.endsWith('ingestion-backfill/run.js')) {
  const [, , p, ci, res, chunksArg] = process.argv;
  const chunks = chunksArg ? parseInt(chunksArg, 10) : undefined;
  run(p, ci, res, Number.isFinite(chunks as number) ? chunks : undefined).catch((err) => {
    log.error('[ingestion-backfill] fatal', { err });
    process.exit(1);
  });
}
