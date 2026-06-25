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
import { ORDER_LIVE_V1_EVENT_NAME, PRODUCT_UPSERT_V1_EVENT_NAME } from './event-names.js';

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

/** The complete WooCommerce ingestion manifest. Validate with assertManifestValid() at startup. */
export const WOOCOMMERCE_MANIFEST: IngestionManifest = {
  provider: WOOCOMMERCE_PROVIDER,
  resources: [WOOCOMMERCE_ORDERS_RESOURCE, WOOCOMMERCE_PRODUCTS_RESOURCE],
};
