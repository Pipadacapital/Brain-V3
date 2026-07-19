/**
 * Canonical Shopify event-name constants — a LEAF module.
 *
 * WHY this exists: index.ts, resources.ts, and manifest.ts form an import cycle
 * (index -> manifest -> resources -> index). When an event-name constant is
 * defined in index.ts but USED at module-evaluation top-level by manifest.ts
 * (e.g. a ResourceDescriptor `emits: [...]` array), ESM's depth-first evaluation
 * can run manifest's body before index.ts initialises the `const`, throwing
 * "Cannot access '<NAME>' before initialization" at runtime (tsc cannot see this —
 * the types resolve fine; only ESM evaluation order trips).
 *
 * This module imports NOTHING local, so it is fully evaluated before any module in
 * the cycle runs its body. Every other module imports its event names from here.
 */

/** Backfill order event name. */
export const ORDER_BACKFILL_V1_EVENT_NAME = 'order.backfill.v1' as const;

/** Live order event name (D-6). */
export const ORDER_LIVE_V1_EVENT_NAME = 'order.live.v1' as const;

/** New-resource canonical event names (ingestion framework: pull-everything). */
export const PRODUCT_UPSERT_V1_EVENT_NAME = 'product.upsert.v1' as const;
export const CUSTOMER_UPSERT_V1_EVENT_NAME = 'customer.upsert.v1' as const;
export const REFUND_RECORDED_V1_EVENT_NAME = 'refund.recorded.v1' as const;
export const FULFILLMENT_RECORDED_V1_EVENT_NAME = 'fulfillment.recorded.v1' as const;
/**
 * Point-in-time stock observation from Shopify's inventory_levels/update webhook (P1 webhook
 * expansion). A DISTINCT grain from product.upsert.v1: the webhook payload carries ONLY
 * (inventory_item_id, location_id, available) — no product_id — so it cannot honestly restate the
 * product/variant grain (properties.product_id) — Bronze-retained; Silver materialization deferred (DR-002).
 * The variant → inventory_item_id join key is emitted on product.upsert.v1 variants[] so a Silver
 * widening can lift this lane later. Bronze lands it now (Bronze is source of truth).
 */
export const INVENTORY_LEVEL_V1_EVENT_NAME = 'inventory.level.v1' as const;
