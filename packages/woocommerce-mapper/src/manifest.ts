/**
 * @brain/woocommerce-mapper/manifest — the WooCommerce IngestionManifest (ingestion-framework
 * onboarding, second connector).
 *
 * WHY: proves the connector-agnostic framework generalises beyond Shopify. WooCommerce declares its
 * full backfillable surface (orders + products) as data the generic `runResumableBackfill` driver
 * reads. Orders already flow through the SHARED order.live.v1 contract; this manifest brings orders
 * onto the resumable framework backfill path AND adds a second resource (products) — the "pull more
 * than one resource" proof.
 *
 * INVARIANT: descriptor `name` is the durable `resource` column on connector_cursor and
 * jobs.resource_backfill_state. 'orders' lines up with the existing 'orders.repull' family; the new
 * 'products' resource gets its own cursor namespace.
 */

import {
  TWO_YEARS_MS,
  type IngestionManifest,
  type ResourceDescriptor,
} from '@brain/connector-core';

// Event names from the LEAF module (cycle-safe) — used at module-evaluation top-level
// in ResourceDescriptor `emits` arrays, so must NOT come from index.ts/resources.ts.
import {
  ORDER_LIVE_V1_EVENT_NAME,
  PRODUCT_UPSERT_V1_EVENT_NAME,
  CUSTOMER_UPSERT_V1_EVENT_NAME,
  COUPON_UPSERT_V1_EVENT_NAME,
  REFUND_RECORDED_V1_EVENT_NAME,
} from './event-names.js';

/** Provider id — matches CONNECTOR_CATALOG + IConnector.provider + the ConnectorFactory key. */
export const WOOCOMMERCE_PROVIDER = 'woocommerce' as const;

/**
 * Orders — WooCommerce wc/v3 /orders, paged by page_number (Woo's classic offset paging, ordered by
 * modified asc). One order → one order.live.v1 per state (date_modified folded into the dedup
 * identity), the SAME canonical contract Shopify emits — so orders flow through the existing
 * order→ledger pipeline with zero new downstream code.
 */
export const WOOCOMMERCE_ORDERS_RESOURCE: ResourceDescriptor = {
  name: 'orders',
  kind: 'rest',
  emits: [ORDER_LIVE_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'page_number',
  dedupKeyStrategy: 'provider_id+kind',
  pageSize: 100, // WooCommerce REST per_page max
  description: 'WooCommerce wc/v3 /orders — economic order facts (shared order.live.v1).',
};

/**
 * Products — WooCommerce wc/v3 /products, paged by page_number. A product's identity is its id;
 * per-state via date_modified so a catalogue edit lands as a new Bronze row.
 */
export const WOOCOMMERCE_PRODUCTS_RESOURCE: ResourceDescriptor = {
  name: 'products',
  kind: 'rest',
  emits: [PRODUCT_UPSERT_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'page_number',
  dedupKeyStrategy: 'provider_id+kind',
  pageSize: 100,
  description: 'WooCommerce wc/v3 /products — catalogue (variations, sku, price).',
};

/**
 * Customers — WooCommerce wc/v3 /customers (hashed PII only — D-10 / I-S02). Identity is the
 * customer id; per-state via date_modified so a profile change restates idempotently. Closes the
 * customer-DIRECTORY gap (customers who never ordered were invisible — the order-derived projection
 * only ever sees buyers).
 */
export const WOOCOMMERCE_CUSTOMERS_RESOURCE: ResourceDescriptor = {
  name: 'customers',
  kind: 'rest',
  emits: [CUSTOMER_UPSERT_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'page_number',
  dedupKeyStrategy: 'provider_id+kind',
  pageSize: 100,
  description: 'WooCommerce wc/v3 /customers — hashed customer directory (no raw PII).',
};

/**
 * Coupons — WooCommerce wc/v3 /coupons (NEW canonical grain coupon.upsert.v1). Identity is the
 * coupon id; per-state via date_modified. Coupons previously survived ONLY as order-nested
 * discount_codes[] — they now have a first-class resource.
 */
export const WOOCOMMERCE_COUPONS_RESOURCE: ResourceDescriptor = {
  name: 'coupons',
  kind: 'rest',
  emits: [COUPON_UPSERT_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'page_number',
  dedupKeyStrategy: 'provider_id+kind',
  pageSize: 100,
  description: 'WooCommerce wc/v3 /coupons — discount catalogue (code, type, amount).',
};

/**
 * Refunds — read via /orders/<id>/refunds (and the order.refunded webhook). A Woo refund id is
 * globally unique → plain provider_id dedup (one refund → one refund.recorded.v1). Makes refunds a
 * first-class revenue-reversal grain instead of an order-payload fold.
 */
export const WOOCOMMERCE_REFUNDS_RESOURCE: ResourceDescriptor = {
  name: 'refunds',
  kind: 'rest',
  emits: [REFUND_RECORDED_V1_EVENT_NAME],
  backfillSupported: true,
  maxBackfillWindowMs: TWO_YEARS_MS,
  cursorStrategy: 'page_number',
  dedupKeyStrategy: 'provider_id',
  pageSize: 100,
  description: 'WooCommerce refunds (read via /orders refunds[]) — revenue reversals.',
};

/** The complete WooCommerce ingestion manifest. Validate with assertManifestValid() at startup. */
export const WOOCOMMERCE_MANIFEST: IngestionManifest = {
  provider: WOOCOMMERCE_PROVIDER,
  resources: [
    WOOCOMMERCE_ORDERS_RESOURCE,
    WOOCOMMERCE_PRODUCTS_RESOURCE,
    WOOCOMMERCE_CUSTOMERS_RESOURCE,
    WOOCOMMERCE_COUPONS_RESOURCE,
    WOOCOMMERCE_REFUNDS_RESOURCE,
  ],
};
