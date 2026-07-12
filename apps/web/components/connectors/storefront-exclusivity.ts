/**
 * storefront-exclusivity.ts — UI mirror of the backend "1 brand = 1 storefront" rule.
 *
 * The server already rejects a SECOND storefront with a 409 STOREFRONT_ALREADY_CONNECTED
 * (apps/core .../sources/storefront/storefront-exclusivity.ts, STOREFRONT_PROVIDERS =
 * ['shopify','woocommerce']). These pure helpers let the marketplace UI prevent the dead-end:
 * once a brand has one storefront connected, the OTHER storefront tiles render disabled.
 *
 * Pure (no React) so they are unit-testable in isolation. Reconnecting the SAME provider or
 * connecting after a disconnect stays allowed — those tiles never get a lock reason.
 */

import type { MarketplaceTile } from '@/lib/api/types';
// DE-DUPED (was a hand-copied provider list that had to be kept in lock-step by comment): the
// SINGLE source of truth for "which providers have a backfill runner" is
// @brain/connector-core/domain/backfill-providers — the SAME module the stream-worker claimer and
// the server reject (RequestConnectorBackfillCommand) read. Imported via the LEAF module path (it
// imports nothing) so the client bundle never pulls the connector-core barrel (node:crypto etc.).
import { supportsHistoricalBackfill as providerSupportsHistoricalBackfill } from '@brain/connector-core/src/domain/backfill-providers';

/** Storefront providers that are mutually exclusive per brand (mirrors apps/core STOREFRONT_PROVIDERS). */
export const STOREFRONT_PROVIDERS = ['shopify', 'woocommerce'] as const;

/**
 * A tile whose provider has a historical-backfill runner (the "Import history" control). This is a
 * pure UI mirror of @brain/connector-core supportsHistoricalBackfill (imported above) — the union of
 * BACKFILL_QUEUE_PROVIDERS (the bespoke shopify queue runner) + INGESTION_BACKFILL_PROVIDERS (the
 * generic ingestion framework: meta/google_ads/razorpay/shiprocket/ga4/woocommerce). It delegates to
 * that single source of truth (no hand-copied list), so it stays in lock-step by construction with
 * the stream-worker claimer + the server reject in RequestConnectorBackfillCommand.
 *
 * WooCommerce's queue runner drives its NON-ORDER resources (products/customers/coupons/refunds);
 * historical ORDERS pull through the sync lane at full manifest depth — together the button delivers
 * the same uniform "Pull historical data" UX. GoKwik is webhook-first (no REST backfill surface) and
 * therefore returns false. Showing the button for an unsupported provider would enqueue an orphan job
 * that sits `queued` forever and looks broken.
 */
export function supportsHistoricalBackfill(tile: Pick<MarketplaceTile, 'id'>): boolean {
  return providerSupportsHistoricalBackfill(tile.id);
}

type StorefrontTile = Pick<MarketplaceTile, 'id' | 'category' | 'display_name' | 'instance' | 'instances'>;

/** A tile belongs to the storefront category (or is a known storefront provider). */
export function isStorefrontTile(tile: Pick<MarketplaceTile, 'id' | 'category'>): boolean {
  return tile.category === 'storefront' || (STOREFRONT_PROVIDERS as readonly string[]).includes(tile.id);
}

/** A tile has at least one active connector_instance for this brand. */
export function isTileConnected(tile: Pick<MarketplaceTile, 'instance' | 'instances'>): boolean {
  return (tile.instances?.length ?? 0) > 0 || tile.instance != null;
}

/** The storefront tile this brand already has connected, if any (1 brand = 1 storefront). */
export function findConnectedStorefront<T extends StorefrontTile>(tiles: readonly T[]): T | null {
  return tiles.find((t) => isStorefrontTile(t) && isTileConnected(t)) ?? null;
}

/**
 * Helper copy explaining why a storefront tile is locked, or null when it is connectable.
 * A DIFFERENT, not-yet-connected storefront is locked out once the brand already has one
 * connected (the backend would 409). The connected storefront itself (reconnect/manage) and
 * every non-storefront tile (payments/ads/logistics) always return null.
 */
export function storefrontLockReason(
  tile: StorefrontTile,
  connectedStorefront: StorefrontTile | null,
): string | null {
  if (!connectedStorefront) return null;
  if (!isStorefrontTile(tile)) return null;
  if (tile.id === connectedStorefront.id) return null;
  if (isTileConnected(tile)) return null;
  return `A brand can have only one storefront — disconnect ${connectedStorefront.display_name} to switch.`;
}
