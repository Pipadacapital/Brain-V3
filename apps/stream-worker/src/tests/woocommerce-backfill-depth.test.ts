/**
 * woocommerce-backfill-depth.test.ts — unit tests for configurable backfill depth.
 *
 * Verifies resolveBackfillDepthMs() honours WOOCOMMERCE_BACKFILL_DAYS env var, falls back to the
 * MANIFEST window when unset (wooMaxBackfillWindowMs() — 5-year policy default, WooCommerce REST has
 * no history limit; the former hard 730-day clamp is LIFTED), and clamps to [1, manifest-days].
 * The manifest window itself honours WOOCOMMERCE_MAX_HISTORY_YEARS (clamped 1..10, default 5).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveBackfillDepthMs } from '../jobs/woocommerce-orders-repull/run.js';
import {
  resolveWooMaxHistoryYears,
  wooMaxBackfillWindowMs,
  WOOCOMMERCE_DEFAULT_MAX_HISTORY_YEARS,
} from '@brain/woocommerce-mapper';

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_DAYS = 365;
const DEFAULT_WINDOW_DAYS = WOOCOMMERCE_DEFAULT_MAX_HISTORY_YEARS * YEAR_DAYS; // 1825

afterEach(() => {
  delete process.env['WOOCOMMERCE_BACKFILL_DAYS'];
  delete process.env['WOOCOMMERCE_MAX_HISTORY_YEARS'];
});

describe('resolveBackfillDepthMs', () => {
  it('defaults to the FULL manifest window (5 years) when WOOCOMMERCE_BACKFILL_DAYS is unset', () => {
    delete process.env['WOOCOMMERCE_BACKFILL_DAYS'];
    expect(resolveBackfillDepthMs()).toBe(DEFAULT_WINDOW_DAYS * DAY_MS);
  });

  it('uses the configured value when WOOCOMMERCE_BACKFILL_DAYS is a valid integer', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '180';
    expect(resolveBackfillDepthMs()).toBe(180 * DAY_MS);
  });

  it('no longer clamps a >730-day request to 2 years (the storefront-history clamp is lifted)', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '1460'; // 4 years — was clamped to 730 before
    expect(resolveBackfillDepthMs()).toBe(1460 * DAY_MS);
  });

  it('falls back to the manifest window when WOOCOMMERCE_BACKFILL_DAYS=0', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '0';
    expect(resolveBackfillDepthMs()).toBe(DEFAULT_WINDOW_DAYS * DAY_MS); // 0 is not > 0 so default kicks in
  });

  it('clamps to the manifest window when WOOCOMMERCE_BACKFILL_DAYS exceeds it', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '99999';
    expect(resolveBackfillDepthMs()).toBe(DEFAULT_WINDOW_DAYS * DAY_MS);
  });

  it('falls back to the manifest window for non-numeric WOOCOMMERCE_BACKFILL_DAYS', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = 'not-a-number';
    expect(resolveBackfillDepthMs()).toBe(DEFAULT_WINDOW_DAYS * DAY_MS);
  });

  it('accepts 1 day as the minimum valid depth', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '1';
    expect(resolveBackfillDepthMs()).toBe(1 * DAY_MS);
  });

  it('honours a WOOCOMMERCE_MAX_HISTORY_YEARS override as the depth ceiling', () => {
    process.env['WOOCOMMERCE_MAX_HISTORY_YEARS'] = '3';
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '99999';
    expect(resolveBackfillDepthMs()).toBe(3 * YEAR_DAYS * DAY_MS);
  });
});

describe('resolveWooMaxHistoryYears / wooMaxBackfillWindowMs (manifest policy cap)', () => {
  it('defaults to 5 years', () => {
    expect(resolveWooMaxHistoryYears()).toBe(5);
    expect(wooMaxBackfillWindowMs()).toBe(5 * YEAR_DAYS * DAY_MS);
  });

  it('honours WOOCOMMERCE_MAX_HISTORY_YEARS within [1, 10]', () => {
    process.env['WOOCOMMERCE_MAX_HISTORY_YEARS'] = '7';
    expect(resolveWooMaxHistoryYears()).toBe(7);
  });

  it('clamps WOOCOMMERCE_MAX_HISTORY_YEARS to 10', () => {
    process.env['WOOCOMMERCE_MAX_HISTORY_YEARS'] = '50';
    expect(resolveWooMaxHistoryYears()).toBe(10);
  });

  it('ignores invalid overrides (non-numeric / zero)', () => {
    process.env['WOOCOMMERCE_MAX_HISTORY_YEARS'] = 'lots';
    expect(resolveWooMaxHistoryYears()).toBe(5);
    process.env['WOOCOMMERCE_MAX_HISTORY_YEARS'] = '0';
    expect(resolveWooMaxHistoryYears()).toBe(5);
  });
});
