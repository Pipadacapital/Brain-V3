/**
 * storefront-exclusivity.test.ts — unit tests for the UI "1 brand = 1 storefront" rule.
 *
 * Mirrors the backend exclusivity (apps/core .../storefront/storefront-exclusivity.ts): once a
 * brand has a connected storefront, the OTHER storefront tiles must be locked in the marketplace
 * so the user never hits a 409 STOREFRONT_ALREADY_CONNECTED dead-end. These prove the pure helpers:
 *   - findConnectedStorefront only matches a CONNECTED storefront tile.
 *   - storefrontLockReason locks a DIFFERENT, not-yet-connected storefront, but NEVER the
 *     connected storefront itself, and NEVER a non-storefront (payments/ads/logistics) tile.
 */

import { describe, it, expect } from 'vitest';
import type { MarketplaceTile, MarketplaceTileInstance } from '@/lib/api/types';
import {
  STOREFRONT_PROVIDERS,
  isStorefrontTile,
  isTileConnected,
  findConnectedStorefront,
  storefrontLockReason,
} from './storefront-exclusivity';

const instance = (id: string): MarketplaceTileInstance => ({
  id,
  status: 'connected',
  health_state: 'Healthy',
  safety_rating: 'safe',
  shop_domain: null,
  connected_at: null,
  account_key: '__default__',
  is_active: true,
});

const tile = (over: Partial<MarketplaceTile> & Pick<MarketplaceTile, 'id'>): MarketplaceTile => ({
  category: 'storefront',
  display_name: over.id.charAt(0).toUpperCase() + over.id.slice(1),
  description: '',
  connect_method: 'oauth',
  available: true,
  instance: null,
  instances: [],
  ...over,
});

const shopifyConnected = tile({ id: 'shopify', display_name: 'Shopify', instances: [instance('i-shopify')] });
const wooDisconnected = tile({ id: 'woocommerce', display_name: 'WooCommerce', connect_method: 'credential' });
const razorpay = tile({ id: 'razorpay', category: 'payments', connect_method: 'credential' });

describe('STOREFRONT_PROVIDERS mirrors the backend exclusivity set', () => {
  it('is exactly shopify + woocommerce', () => {
    expect([...STOREFRONT_PROVIDERS]).toEqual(['shopify', 'woocommerce']);
  });
});

describe('isStorefrontTile / isTileConnected', () => {
  it('classifies storefront tiles by category and by provider id', () => {
    expect(isStorefrontTile(shopifyConnected)).toBe(true);
    expect(isStorefrontTile(wooDisconnected)).toBe(true);
    expect(isStorefrontTile(razorpay)).toBe(false);
    // provider-id fallback even if category were mislabeled
    expect(isStorefrontTile({ id: 'woocommerce', category: 'payments' })).toBe(true);
  });

  it('detects a connected tile from instances or the legacy single instance', () => {
    expect(isTileConnected(shopifyConnected)).toBe(true);
    expect(isTileConnected(tile({ id: 'x', instance: instance('i-x') }))).toBe(true);
    expect(isTileConnected(wooDisconnected)).toBe(false);
  });
});

describe('findConnectedStorefront', () => {
  it('returns the connected storefront tile', () => {
    expect(findConnectedStorefront([shopifyConnected, wooDisconnected, razorpay])?.id).toBe('shopify');
  });

  it('returns null when no storefront is connected', () => {
    expect(findConnectedStorefront([wooDisconnected, razorpay])).toBeNull();
  });

  it('ignores a connected NON-storefront (payments) connector', () => {
    const razorpayConnected = tile({ id: 'razorpay', category: 'payments', instances: [instance('i-rzp')] });
    expect(findConnectedStorefront([wooDisconnected, razorpayConnected])).toBeNull();
  });
});

describe('storefrontLockReason', () => {
  it('locks a different, not-yet-connected storefront and names the connected provider', () => {
    const reason = storefrontLockReason(wooDisconnected, shopifyConnected);
    expect(reason).toBe('A brand can have only one storefront — disconnect Shopify to switch.');
  });

  it('NEVER locks the already-connected storefront (reconnect/manage stays allowed)', () => {
    expect(storefrontLockReason(shopifyConnected, shopifyConnected)).toBeNull();
  });

  it('NEVER locks a non-storefront tile (payments/ads/logistics)', () => {
    expect(storefrontLockReason(razorpay, shopifyConnected)).toBeNull();
  });

  it('does not lock anything when the brand has no connected storefront', () => {
    expect(storefrontLockReason(wooDisconnected, null)).toBeNull();
  });
});

// ── supportsHistoricalBackfill (the "Pull historical data" control gate) ───────

// Imported separately (appended with the woocommerce onboarding) to keep the diff append-style.
import { supportsHistoricalBackfill } from './storefront-exclusivity';

describe('supportsHistoricalBackfill', () => {
  it.each(['shopify', 'meta', 'google_ads', 'razorpay', 'shiprocket', 'ga4', 'woocommerce'])(
    'renders the backfill control for %s (a provider with a queue runner)',
    (id) => {
      expect(supportsHistoricalBackfill({ id })).toBe(true);
    },
  );

  it('does NOT render the control for gokwik (webhook-first, no REST backfill surface)', () => {
    expect(supportsHistoricalBackfill({ id: 'gokwik' })).toBe(false);
  });
});
