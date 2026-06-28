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

/** Customer upsert event name — SHARED with @brain/shopify-mapper (one customer.upsert.v1 grain).
 *  Already admitted on BOTH SERVER_TRUSTED sets (silver_collector_event.py / bronze_materialize.py). */
export const CUSTOMER_UPSERT_V1_EVENT_NAME = 'customer.upsert.v1' as const;

/** Refund recorded event name — SHARED with @brain/shopify-mapper (one refund.recorded.v1 grain).
 *  Already admitted on BOTH SERVER_TRUSTED sets + consumed by silver_refund.py. */
export const REFUND_RECORDED_V1_EVENT_NAME = 'refund.recorded.v1' as const;

/** Coupon upsert event name — NEW canonical grain (no Shopify equivalent yet).
 *  NOTE: coupon.upsert.v1 is NOT yet admitted on the SERVER_TRUSTED gate sets nor consumed by a
 *  silver coupon mart — those are downstream (gate + mart) slices. This constant + the mapper only
 *  EMIT the canonical event; admission/consumption is wired separately. */
export const COUPON_UPSERT_V1_EVENT_NAME = 'coupon.upsert.v1' as const;
