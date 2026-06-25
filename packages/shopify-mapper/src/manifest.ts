/**
 * @brain/shopify-mapper/manifest — the Shopify IngestionManifest (ingestion-framework onboarding).
 *
 * WHY (slice: ingestion onboarding): the foundation slice shipped a connector-agnostic ingestion
 * framework (`@brain/connector-core`: IngestionManifest + resumable backfill driver + dedup +
 * no-loss). Today Shopify only ingests ONE resource (orders). This manifest DECLARES the full
 * Shopify surface area we onboard — orders, products, customers, refunds, fulfillments — as data
 * the generic `runResumableBackfill` driver reads, rather than bespoke per-resource job code.
 *
 * Each ResourceDescriptor is the single source of truth for: how far back the platform lets us
 * backfill, how the resource is paged (cursorStrategy), and how a raw record reduces to a stable
 * dedup identity (dedupKeyStrategy → deterministic event_id → Bronze drops replays). The matching
 * page-fetchers live in apps/stream-worker (they know the HTTP/REST detail); the mappers that
 * project raw → CanonicalEventDraft live in THIS package (PII hashed at the boundary, money in
 * minor units).
 *
 * INVARIANT: the `name` of each descriptor is durable — it is the `resource` column on
 * connector_cursor AND jobs.resource_backfill_state. Renaming it orphans cursors. The orders
 * descriptor name is intentionally 'orders' to line up with the existing order backfill cursor.
 */

import {
  TWO_YEARS_MS,
  type IngestionManifest,
  type ResourceDescriptor,
} from '@brain/connector-core';

// Event names come from the LEAF module (cycle-safe) — manifest.ts uses several at
// module-evaluation top-level (ResourceDescriptor `emits` arrays), so it must NOT
// import them from index.ts/resources.ts (both are in an import cycle with manifest.ts).
import {
  ORDER_BACKFILL_V1_EVENT_NAME,
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
  FULFILLMENT_RECORDED_V1_EVENT_NAME,
} from './event-names.js';

/** Provider id — matches CONNECTOR_CATALOG + IConnector.provider + the ConnectorFactory key. */
export const SHOPIFY_PROVIDER = 'shopify' as const;

/**
 * Orders — the reference resource the foundation generalises. Paged by since_id (id-ascending
 * walk, the existing 24-month behaviour). One Shopify order id → one dedup identity per event kind
 * (backfill emits order.backfill.v1; the live lane emits order.live.v1 keyed on updated_at).
 */
export const SHOPIFY_ORDERS_RESOURCE: ResourceDescriptor = {
  name: 'orders',
  kind: 'rest',
  emits: [ORDER_BACKFILL_V1_EVENT_NAME, 'order.live.v1'],
  backfillSupported: true,
  // Shopify retains full order history; Brain targets 2 years (the driver clamps to this).
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'since_id',
  dedupKeyStrategy: 'provider_id+kind',
  pageSize: 250,
  description: 'Shopify Admin REST /orders — economic order facts (revenue truth).',
};

/**
 * Products — catalogue. A product's identity is its product id; it fans out into one
 * product.upsert.v1 per (product, updated_at) so a catalogue edit lands as a new Bronze row
 * rather than being deduped away (mirrors the order live-state model).
 */
export const SHOPIFY_PRODUCTS_RESOURCE: ResourceDescriptor = {
  name: 'products',
  kind: 'rest',
  emits: [PRODUCT_UPSERT_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'since_id',
  dedupKeyStrategy: 'provider_id+kind',
  pageSize: 250,
  description: 'Shopify Admin REST /products — catalogue (variants, sku, price).',
};

/**
 * Customers — the customer directory (hashed PII only — D-10 / I-S02). Identity is the customer
 * id; per-state via updated_at so a profile change restates idempotently.
 */
export const SHOPIFY_CUSTOMERS_RESOURCE: ResourceDescriptor = {
  name: 'customers',
  kind: 'rest',
  emits: [CUSTOMER_UPSERT_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'since_id',
  dedupKeyStrategy: 'provider_id+kind',
  pageSize: 250,
  description: 'Shopify Admin REST /customers — hashed customer directory (no raw PII).',
};

/**
 * Refunds — refund facts. A refund has its own immutable id, but a single refund id is unique on
 * its own (one refund → one refund.recorded.v1), so plain provider_id dedup is sufficient.
 */
export const SHOPIFY_REFUNDS_RESOURCE: ResourceDescriptor = {
  name: 'refunds',
  kind: 'rest',
  emits: [REFUND_RECORDED_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'since_id',
  dedupKeyStrategy: 'provider_id',
  pageSize: 250,
  description: 'Shopify refunds (read via /orders refunds[]) — revenue reversals.',
};

/**
 * Fulfillments — shipment/fulfillment facts. Each fulfillment has its own immutable id; one
 * fulfillment → one fulfillment.recorded.v1, so provider_id dedup is sufficient.
 */
export const SHOPIFY_FULFILLMENTS_RESOURCE: ResourceDescriptor = {
  name: 'fulfillments',
  kind: 'rest',
  emits: [FULFILLMENT_RECORDED_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'since_id',
  dedupKeyStrategy: 'provider_id',
  pageSize: 250,
  description: 'Shopify fulfillments (read via /orders fulfillments[]) — logistics facts.',
};

/**
 * The complete Shopify ingestion manifest. Declared once; consumed by the generic backfill driver,
 * the repull scheduler, and the dedup layer. Validate with assertManifestValid() at startup.
 */
export const SHOPIFY_MANIFEST: IngestionManifest = {
  provider: SHOPIFY_PROVIDER,
  resources: [
    SHOPIFY_ORDERS_RESOURCE,
    SHOPIFY_PRODUCTS_RESOURCE,
    SHOPIFY_CUSTOMERS_RESOURCE,
    SHOPIFY_REFUNDS_RESOURCE,
    SHOPIFY_FULFILLMENTS_RESOURCE,
  ],
};
