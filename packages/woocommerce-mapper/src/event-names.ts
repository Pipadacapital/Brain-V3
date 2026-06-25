/**
 * Canonical WooCommerce event-name constants — a LEAF module (imports nothing local).
 *
 * Mirrors packages/shopify-mapper/src/event-names.ts. index.ts, resources.ts, and
 * manifest.ts form an import cycle; an event-name `const` defined in index.ts but
 * used at manifest.ts module-evaluation top-level (ResourceDescriptor `emits` arrays)
 * throws "Cannot access '<NAME>' before initialization" under ESM evaluation order
 * (tsc cannot see this). Defining them in this dependency-free leaf guarantees they
 * are initialised before any cyclic module body runs.
 *
 * NOTE: these MUST equal @brain/shopify-mapper's names — one shared canonical grain.
 */

/** Live order event name — MUST equal shopify-mapper's. */
export const ORDER_LIVE_V1_EVENT_NAME = 'order.live.v1' as const;

/** Product upsert event name — SHARED with @brain/shopify-mapper. */
export const PRODUCT_UPSERT_V1_EVENT_NAME = 'product.upsert.v1' as const;
