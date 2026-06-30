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
  backfillableResources,
  type IResourcePageFetcher,
  type IngestionManifest,
  // Phase 2 will add these manifest files (packages/connector-core/src/manifests/<provider>.manifest.ts)
  // and re-export them from the connector-core index per the naming contract. Until then this module
  // intentionally does not typecheck (the manifest consts are unresolved) — that is expected.
  META_INGESTION_MANIFEST,
  GOOGLE_ADS_INGESTION_MANIFEST,
  RAZORPAY_INGESTION_MANIFEST,
  SHIPROCKET_INGESTION_MANIFEST,
  GA4_INGESTION_MANIFEST,
  // Cross-lane id-parity seam: a passthrough deriver that stamps the fetcher's PRECOMPUTED live
  // event_id (FetchedRecord.providerId) verbatim, so generic-ingestion backfill ids == live ids
  // by construction (no DeterministicDedup namespace divergence → Bronze dedups → no double-count).
  precomputedEventIdDeriver,
} from '@brain/connector-core';
import { SHOPIFY_MANIFEST } from '@brain/shopify-mapper';
import { WOOCOMMERCE_MANIFEST } from '@brain/woocommerce-mapper';
import { ORDER_BACKFILL_V1_TOPIC_SUFFIX } from '@brain/contracts';
import { loadStreamWorkerConfig } from '@brain/config';
import { createIdempotentProducer } from '../../infrastructure/kafka/idempotent-producer.js';
import { createSaltProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { DlqRecordRepository } from '../../infrastructure/pg/DlqRecordRepository.js';
import { PgBackfillJobRepository } from '../../infrastructure/pg/BackfillJobRepository.js';
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
// Per-connector credential resolvers — REUSE each connector's existing repull resolver (prod AWS
// Secrets Manager / dev secret bundle), so the backfill lane resolves secrets IDENTICALLY to the
// live re-pull. Tokens are NEVER logged (I-S09); a null resolution ⇒ RECONNECT_REQUIRED.
import { resolveMetaCredentials } from '../meta-spend-repull/run.js';
import { resolveGoogleCredentials } from '../google-ads-spend-repull/run.js';
import { resolveRazorpayCredentials } from '../razorpay-settlement-repull/run.js';
import { resolveShiprocketCredentials } from '../shiprocket-shipment-repull/run.js';
import { resolveGa4Credentials } from '../ga4-repull/run.js';
// Phase 2 will add these per-connector fetcher-builder files following the NAMING CONTRACT
// (build<ProviderPascal>ResourceFetcher). Until then this module intentionally does not typecheck.
import { buildMetaResourceFetcher } from './meta-resource-fetchers.js';
import { buildGoogleAdsResourceFetcher } from './google-ads-resource-fetchers.js';
import { buildRazorpayResourceFetcher } from './razorpay-resource-fetchers.js';
import { buildShiprocketResourceFetcher } from './shiprocket-resource-fetchers.js';
import { buildGa4ResourceFetcher } from './ga4-resource-fetchers.js';
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

export type SupportedProvider =
  | 'shopify'
  | 'woocommerce'
  | 'meta'
  | 'google_ads'
  | 'razorpay'
  | 'shiprocket'
  | 'ga4';

const MANIFESTS: Readonly<Record<SupportedProvider, IngestionManifest>> = {
  shopify: SHOPIFY_MANIFEST,
  woocommerce: WOOCOMMERCE_MANIFEST,
  meta: META_INGESTION_MANIFEST,
  google_ads: GOOGLE_ADS_INGESTION_MANIFEST,
  razorpay: RAZORPAY_INGESTION_MANIFEST,
  shiprocket: SHIPROCKET_INGESTION_MANIFEST,
  ga4: GA4_INGESTION_MANIFEST,
};

function manifestFor(provider: SupportedProvider): IngestionManifest {
  return MANIFESTS[provider];
}

/** True for the providers drained by the GENERIC ingestion framework (not the bespoke shopify queue). */
function isIngestionProvider(
  provider: SupportedProvider,
): provider is 'meta' | 'google_ads' | 'razorpay' | 'shiprocket' | 'ga4' {
  return (
    provider === 'meta' ||
    provider === 'google_ads' ||
    provider === 'razorpay' ||
    provider === 'shiprocket' ||
    provider === 'ga4'
  );
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
 * Generic connector row for the ingestion-framework providers (meta / google_ads / razorpay /
 * shiprocket / ga4). The optional discriminator columns:
 *   - ad_account_id          — meta/google_ads ad account; for ga4 this column stores the property id
 *                              (generic repull contract — see ga4-repull/run.ts).
 *   - shiprocket_channel_id  — shiprocket channel scope.
 */
interface IngestionConnectorRow {
  brand_id: string;
  secret_ref: string;
  ad_account_id: string | null;
  shiprocket_channel_id: string | null;
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
): Promise<ShopifyConnectorRow | WooConnectorRow | IngestionConnectorRow | null> {
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
    if (provider === 'woocommerce') {
      const res = await client.query<WooConnectorRow>(
        `SELECT brand_id, secret_ref, woocommerce_site_url
           FROM connector_instance WHERE id = $1 AND brand_id = $2`,
        [connectorInstanceId, brandId],
      );
      await client.query('COMMIT');
      return res.rows[0] ?? null;
    }
    // Generic ingestion-framework providers (meta/google_ads/razorpay/shiprocket/ga4): the secret_ref
    // + the per-provider discriminator columns the credential resolvers need (ad_account_id /
    // shiprocket_channel_id). brand_id is the caller's (MT-1) — never inferred from an API response.
    const res = await client.query<IngestionConnectorRow>(
      `SELECT brand_id, secret_ref, ad_account_id, shiprocket_channel_id
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

  // ── Generic ingestion-framework providers ───────────────────────────────────────────────────────
  // Each resolves its connector row + secrets via the SAME resolver its live re-pull uses (prod AWS
  // Secrets Manager / dev bundle), then hands a typed `secrets` bundle to the Phase-2 fetcher builder.
  // The builder args mirror the shopify/woo shape: { pool, connectorInstanceId, resource, brandId,
  // saltHex, secrets }. A null credential resolution ⇒ RECONNECT_REQUIRED (auth-rejected, null return
  // → the driver preserves the cursor). brand_id is the connector row's (MT-1) — never an API payload.
  if (isIngestionProvider(provider)) {
    const row = (await loadConnector(pool, connectorInstanceId, provider, brandId)) as IngestionConnectorRow | null;
    if (!row) return null;

    if (provider === 'meta') {
      const secrets = await resolveMetaCredentials(row.secret_ref, row.ad_account_id);
      if (!secrets) {
        recordConnectorAuthRejected('meta');
        return null;
      }
      return buildMetaResourceFetcher({ pool, connectorInstanceId, resource, brandId, saltHex, secrets });
    }
    if (provider === 'google_ads') {
      const secrets = await resolveGoogleCredentials(row.secret_ref, row.ad_account_id);
      if (!secrets) {
        recordConnectorAuthRejected('google_ads');
        return null;
      }
      return buildGoogleAdsResourceFetcher({ pool, connectorInstanceId, resource, brandId, saltHex, secrets });
    }
    if (provider === 'razorpay') {
      const secrets = await resolveRazorpayCredentials(row.secret_ref);
      if (!secrets) {
        recordConnectorAuthRejected('razorpay');
        return null;
      }
      return buildRazorpayResourceFetcher({ pool, connectorInstanceId, resource, brandId, saltHex, secrets });
    }
    if (provider === 'shiprocket') {
      const secrets = await resolveShiprocketCredentials(row.secret_ref);
      if (!secrets) {
        recordConnectorAuthRejected('shiprocket');
        return null;
      }
      return buildShiprocketResourceFetcher({ pool, connectorInstanceId, resource, brandId, saltHex, secrets });
    }
    // ga4
    const secrets = await resolveGa4Credentials(row.secret_ref, row.ad_account_id);
    if (!secrets) {
      recordConnectorAuthRejected('ga4');
      return null;
    }
    return buildGa4ResourceFetcher({ pool, connectorInstanceId, resource, brandId, saltHex, secrets });
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
  if (!provider || !(provider in MANIFESTS)) {
    throw new Error(
      `[ingestion-backfill] provider must be one of ${Object.keys(MANIFESTS).join(' | ')} (got ${provider})`,
    );
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
      // Generic-ingestion providers (meta/google_ads/razorpay/shiprocket/ga4) carry a precomputed
      // live event_id on each FetchedRecord.providerId → stamp it through unchanged so backfill ids
      // match the live/repull lane. Shopify/woocommerce KEEP the default DeterministicDedup deriver.
      ...(isIngestionProvider(typedProvider) ? { dedup: precomputedEventIdDeriver } : {}),
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
        // Generic-ingestion providers (meta/google_ads/razorpay/shiprocket/ga4) carry a precomputed
        // live event_id on each FetchedRecord.providerId → stamp it through unchanged so backfill ids
        // match the live/repull lane. Shopify/woocommerce KEEP the default DeterministicDedup deriver.
        ...(isIngestionProvider(provider) ? { dedup: precomputedEventIdDeriver } : {}),
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

/** Per-run page budget per resource for a CLAIMED `jobs.backfill_job` (the "Import history" button).
 *  Keeps a single claim bounded; the resumable cursor in jobs.resource_backfill_state carries the
 *  rest forward to the next claimer tick (the stale-running requeue re-drains until completed).
 *  Override via INGESTION_BACKFILL_CHUNKS_PER_RUN (clamped 1..50). */
function resolveIngestionBackfillChunkBudget(): number {
  // intentional raw: optional per-run page budget; not in the typed config schema.
  const raw = process.env['INGESTION_BACKFILL_CHUNKS_PER_RUN'];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(parsed, 1), 50) : 5;
}

/**
 * runIngestionBackfillFromQueue — the CLAIMER seam that connects the `jobs.backfill_job` queue (the
 * "Import history" button → RequestConnectorBackfillCommand → a queued row) to the GENERIC resumable
 * framework, for the INGESTION_BACKFILL_PROVIDERS (meta/google_ads/razorpay/shiprocket/ga4).
 *
 * Mirrors the shopify-backfill claim lifecycle but drives the generic driver instead of the bespoke
 * order loop:
 *   1. claimQueued(connectorInstanceId, brandId) — queued → running, FOR UPDATE SKIP LOCKED (D-9),
 *      idempotent so it is safe alongside a prod cron + a second claimer tick.
 *   2. resolve the per-brand salt (PII hashing); a salt failure finalizes the job 'failed' + preserves
 *      the cursor for resume.
 *   3. driveResourceBackfillsForConnector over EVERY backfill-supported resource the provider's
 *      manifest declares, BOUNDED to a per-run page budget (INGESTION_BACKFILL_CHUNKS_PER_RUN);
 *      fail-isolated per resource; resumable/chunked/dedup/no-loss; BACKFILL lane.
 *   4. terminal disposition of the backfill_job:
 *        - any resource errored        → finalize 'failed' (RESOURCE_BACKFILL_FAILED).
 *        - every resource completed     → finalize 'completed'.
 *        - otherwise (some PAUSED)      → requeueForResume → next claimer tick continues from the
 *          persisted per-resource cursors (jobs.resource_backfill_state) until every resource's floor
 *          is reached. This mirrors the bounded-per-tick + resume-across-ticks woo scheduled lane.
 *
 * brand_id is the caller's (from the connector enumeration / job row) — NEVER an API payload (MT-1).
 * Tokens/secrets are NEVER logged (I-S09). Self-contained pool + producer (own connections), released
 * in finally. A no-queued-job is a clean no-op (returns without side effects).
 */
export async function runIngestionBackfillFromQueue(
  connectorInstanceId: string,
  provider: SupportedProvider,
  brandId: string,
): Promise<void> {
  if (!isIngestionProvider(provider)) {
    throw new Error(`[ingestion-backfill] runIngestionBackfillFromQueue: provider "${provider}" is not an ingestion-framework provider`);
  }
  const jobRepo = new PgBackfillJobRepository(DB_URL);
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  const kafka = new Kafka({ clientId: 'ingestion-backfill-claimer', brokers: BROKERS, retry: { retries: 5 } });
  const producer = createIdempotentProducer(kafka);
  const saltProvider = createSaltProvider(DB_URL);

  try {
    // Claim a queued job for this connector (idempotent; null ⇒ nothing queued / already claimed).
    const claimed = await jobRepo.claimQueued(connectorInstanceId, brandId);
    if (!claimed) return;

    await producer.connect();

    let saltHex: string;
    try {
      saltHex = await saltProvider.saltHexForBrand(brandId);
    } catch (e) {
      await jobRepo.finalize({
        jobId: claimed.id,
        brandId,
        status: 'failed',
        achievedDepthLabel: null,
        failureReason: `SALT_FETCH_FAILED: ${String(e).slice(0, 200)}`,
        recordsProcessed: 0n,
        cursorValue: claimed.cursor_value,
      });
      log.error(`[ingestion-backfill] salt fetch failed for brand=${brandId} job=${claimed.id}`, { detail: e });
      return;
    }

    // Drive every backfill-supported (rest) resource the manifest declares.
    const manifest = manifestFor(provider);
    const resources = backfillableResources(manifest).map((r) => r.name);
    if (resources.length === 0) {
      // Misconfiguration guard: a provider with NO backfill-supported resources would otherwise
      // requeue forever. Finalize 'completed' (nothing to do) so the job terminates loudly.
      await jobRepo.finalize({
        jobId: claimed.id,
        brandId,
        status: 'completed',
        achievedDepthLabel: null,
        failureReason: null,
        recordsProcessed: BigInt(claimed.records_processed ?? '0'),
        cursorValue: claimed.cursor_value,
      });
      log.warn(`[ingestion-backfill] queue job=${claimed.id} provider=${provider} has NO backfill-supported resources — finalized completed (no-op)`);
      return;
    }
    const outcomes = await driveResourceBackfillsForConnector({
      pool,
      producer,
      provider,
      connectorInstanceId,
      brandId,
      saltHex,
      resources,
      maxChunksPerResource: resolveIngestionBackfillChunkBudget(),
    });

    const anyFailed = outcomes.some((o) => o.stopReason === 'failed');
    const allCompleted = outcomes.length > 0 && outcomes.every((o) => o.stopReason === 'completed');
    const recordsThisRun = outcomes.reduce((n, o) => n + o.recordsThisRun, 0);
    // Records accumulated across ticks (this run's delta + what prior ticks already recorded). The
    // backfill_job.records_processed is the UI's running total; per-resource lifetime totals live in
    // jobs.resource_backfill_state.
    const priorRecords = BigInt(claimed.records_processed ?? '0');
    const cumulativeRecords = priorRecords + BigInt(recordsThisRun);

    if (anyFailed) {
      await jobRepo.finalize({
        jobId: claimed.id,
        brandId,
        status: 'failed',
        achievedDepthLabel: null,
        failureReason: 'RESOURCE_BACKFILL_FAILED',
        recordsProcessed: cumulativeRecords,
        // Per-resource cursors live in jobs.resource_backfill_state; the backfill_job cursor_value is
        // the bespoke-shopify since_id, unused for the generic lane.
        cursorValue: claimed.cursor_value,
      });
      log.warn(
        `[ingestion-backfill] queue job=${claimed.id} provider=${provider} connector=${connectorInstanceId} ` +
          `status=failed resources=${outcomes.length} recordsThisRun=${recordsThisRun}`,
      );
      return;
    }

    if (allCompleted) {
      await jobRepo.finalize({
        jobId: claimed.id,
        brandId,
        status: 'completed',
        achievedDepthLabel: null,
        failureReason: null,
        recordsProcessed: cumulativeRecords,
        cursorValue: claimed.cursor_value,
      });
      log.info(
        `[ingestion-backfill] queue job=${claimed.id} provider=${provider} connector=${connectorInstanceId} ` +
          `status=completed resources=${outcomes.length} recordsTotal=${cumulativeRecords}`,
      );
      return;
    }

    // Some resources merely PAUSED (more pages remain) — requeue so the next claimer tick resumes
    // from the persisted per-resource cursors until every resource reaches its floor.
    await jobRepo.requeueForResume(claimed.id, brandId, cumulativeRecords);
    log.info(
      `[ingestion-backfill] queue job=${claimed.id} provider=${provider} connector=${connectorInstanceId} ` +
        `status=paused→requeued resources=${outcomes.length} recordsThisRun=${recordsThisRun} recordsTotal=${cumulativeRecords}`,
    );
  } finally {
    await producer.disconnect().catch(() => undefined);
    await pool.end();
    await jobRepo.end();
  }
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
