/**
 * order-mapper.ts — Backfill-specific re-exports from @brain/shopify-mapper (A0 move, D-12).
 *
 * The mapper, money, and uuid utils have been MOVED to packages/shopify-mapper
 * (@brain/shopify-mapper) so they can be imported by both stream-worker (re-pull)
 * and apps/core (webhook receiver) without a cross-rootDir deep-import.
 *
 * This file provides backward-compatible shims for existing imports inside
 * shopify-backfill/run.ts:
 *   - mapOrderToBackfillEvent(order, saltHex, regionCode) — wraps mapOrderToEvent with event_name='order.backfill.v1'
 *   - computeAchievedDepthLabel — re-exported unchanged
 */

import {
  mapOrderToEvent,
  ORDER_BACKFILL_V1_EVENT_NAME,
  type ShopifyOrderShape,
  type MappedOrderEvent,
} from '@brain/shopify-mapper';

export { computeAchievedDepthLabel } from '@brain/shopify-mapper';

export type { MappedOrderEvent as MappedBackfillEvent, ShopifyOrderShape, OrderProperties } from '@brain/shopify-mapper';

/**
 * Backward-compatible wrapper: maps a Shopify order to a backfill event.
 * Calls mapOrderToEvent with event_name='order.backfill.v1'.
 */
export function mapOrderToBackfillEvent(
  order: ShopifyOrderShape,
  saltHex: string,
  regionCode: string,
): MappedOrderEvent {
  return mapOrderToEvent(order, saltHex, regionCode, ORDER_BACKFILL_V1_EVENT_NAME);
}
