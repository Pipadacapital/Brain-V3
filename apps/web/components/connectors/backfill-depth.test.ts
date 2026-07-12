/**
 * backfill-depth.test.ts — unit tests for the "Pull historical data" depth-picker helpers.
 *
 * Two jobs:
 *   1. PARITY GUARD (the load-bearing one). PROVIDER_MAX_BACKFILL_MONTHS is a client-side MIRROR of
 *      each provider's REAL ingestion-manifest maxBackfillWindowMs — the manifest barrels can't be
 *      imported into the web client bundle (they pull server-only modules), so this test imports the
 *      real manifests NODE-side and asserts the mirror equals floor(maxBackfillWindowMs / MONTH_MS)
 *      per provider. If a manifest window ever changes, this test fails and forces the mirror update
 *      (honesty invariant: never promise depth the platform cannot serve).
 *   2. Helper behaviour: option lists are clamped to the provider max, "Max" is always present and
 *      carries no window (undefined → provider max), and value→window resolution round-trips.
 */

import { describe, it, expect } from 'vitest';
import {
  META_INGESTION_MANIFEST,
  GOOGLE_ADS_INGESTION_MANIFEST,
  GA4_INGESTION_MANIFEST,
  RAZORPAY_INGESTION_MANIFEST,
  SHIPROCKET_INGESTION_MANIFEST,
  TWO_YEARS_MS,
} from '@brain/connector-core';
import type { IngestionManifest } from '@brain/connector-core';
import {
  MONTH_MS,
  PROVIDER_MAX_BACKFILL_MONTHS,
  providerMaxBackfillMonths,
  backfillDepthOptions,
  requestedWindowMsForValue,
} from './backfill-depth';

/** The provider max window the platform actually allows = the widest resource window it declares. */
function manifestMaxWindowMs(manifest: IngestionManifest): number {
  return Math.max(...manifest.resources.map((r) => r.maxBackfillWindowMs));
}

describe('PROVIDER_MAX_BACKFILL_MONTHS — manifest parity (the mirror MUST match the real windows)', () => {
  // The generic-framework providers whose manifests live in @brain/connector-core (a web dep). The
  // shopify manifest lives in @brain/shopify-mapper (NOT a web dep, so not importable here) — its
  // window is asserted separately below against the shared TWO_YEARS_MS constant it is built from.
  const cases: ReadonlyArray<readonly [string, IngestionManifest]> = [
    ['meta', META_INGESTION_MANIFEST],
    ['google_ads', GOOGLE_ADS_INGESTION_MANIFEST],
    ['ga4', GA4_INGESTION_MANIFEST],
    ['razorpay', RAZORPAY_INGESTION_MANIFEST],
    ['shiprocket', SHIPROCKET_INGESTION_MANIFEST],
  ];

  it.each(cases)('%s mirror equals floor(manifest maxBackfillWindowMs / MONTH_MS)', (provider, manifest) => {
    const expectedMonths = Math.floor(manifestMaxWindowMs(manifest) / MONTH_MS);
    expect(PROVIDER_MAX_BACKFILL_MONTHS[provider]).toBe(expectedMonths);
  });

  it('shopify mirror equals floor(TWO_YEARS_MS / MONTH_MS) — the window its backfillable resources use', () => {
    // Every backfillable Shopify resource declares maxBackfillWindowMs = TWO_YEARS_MS (see
    // packages/shopify-mapper/src/manifest.ts). Assert the mirror against that shared constant so a
    // change to TWO_YEARS_MS forces the mirror update without needing the shopify-mapper dep here.
    expect(PROVIDER_MAX_BACKFILL_MONTHS['shopify']).toBe(Math.floor(TWO_YEARS_MS / MONTH_MS));
  });

  it('every mirrored provider corresponds to a real manifest (no stale/typo keys)', () => {
    const mirrored = Object.keys(PROVIDER_MAX_BACKFILL_MONTHS).sort();
    expect(mirrored).toEqual(['ga4', 'google_ads', 'meta', 'razorpay', 'shiprocket', 'shopify']);
  });
});

describe('providerMaxBackfillMonths', () => {
  it('returns the mirrored max for a known provider', () => {
    expect(providerMaxBackfillMonths('shopify')).toBe(24);
    expect(providerMaxBackfillMonths('ga4')).toBe(14);
  });

  it('falls back to the 24-month default for an unknown provider', () => {
    expect(providerMaxBackfillMonths('totally-unknown')).toBe(24);
  });
});

describe('backfillDepthOptions', () => {
  it('offers the fixed steps below the max plus a "Max (N months)" option (24-month provider)', () => {
    const opts = backfillDepthOptions('shopify');
    // 3/6/12 are STRICTLY below 24; 24 is redundant with "Max", so only 3 fixed + max.
    expect(opts.map((o) => o.value)).toEqual(['3mo', '6mo', '12mo', 'max']);
    expect(opts.at(-1)).toMatchObject({ value: 'max', label: 'Max (24 months)' });
    // "Max" carries NO window (undefined → body-less POST → provider max, pre-picker behaviour).
    expect(opts.at(-1)!.requestedWindowMs).toBeUndefined();
    // Each fixed step carries its window in ms (30-day months).
    expect(opts[0]).toMatchObject({ value: '3mo', requestedWindowMs: 3 * MONTH_MS });
  });

  it('clamps the fixed steps to a sub-24-month provider max, and labels Max honestly (ga4 = 14mo)', () => {
    const opts = backfillDepthOptions('ga4');
    // 3/6/12 are below 14; 24 is above 14 → dropped. Max is labeled 14, never 24 (honesty).
    expect(opts.map((o) => o.value)).toEqual(['3mo', '6mo', '12mo', 'max']);
    expect(opts.at(-1)).toMatchObject({ value: 'max', label: 'Max (14 months)' });
    expect(opts.some((o) => o.requestedWindowMs !== undefined && o.requestedWindowMs > 14 * MONTH_MS)).toBe(false);
  });

  it('never promises a step at or beyond the provider max (only "Max" reaches the ceiling)', () => {
    for (const provider of ['shopify', 'meta', 'google_ads', 'ga4', 'razorpay', 'shiprocket']) {
      const maxMs = providerMaxBackfillMonths(provider) * MONTH_MS;
      for (const o of backfillDepthOptions(provider)) {
        if (o.requestedWindowMs !== undefined) expect(o.requestedWindowMs).toBeLessThan(maxMs);
      }
    }
  });
});

describe('requestedWindowMsForValue', () => {
  it('resolves a fixed step to its window and "max" to undefined (provider max)', () => {
    expect(requestedWindowMsForValue('shopify', '6mo')).toBe(6 * MONTH_MS);
    expect(requestedWindowMsForValue('shopify', 'max')).toBeUndefined();
  });

  it('returns undefined for an unknown value (fail-safe → provider max, never a bogus window)', () => {
    expect(requestedWindowMsForValue('shopify', 'nonsense')).toBeUndefined();
  });
});
