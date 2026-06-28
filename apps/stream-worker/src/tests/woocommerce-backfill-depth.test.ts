/**
 * woocommerce-backfill-depth.test.ts — unit tests for configurable backfill depth.
 *
 * Verifies resolveBackfillDepthMs() honours WOOCOMMERCE_BACKFILL_DAYS env var, falls back to a
 * 2-YEAR (730-day) INITIAL window when unset (the order audit's 90-day default could not reach
 * storefront history), and clamps to [1, 730] days.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveBackfillDepthMs } from '../jobs/woocommerce-orders-repull/run.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TWO_YEARS_DAYS = 730;

afterEach(() => {
  delete process.env['WOOCOMMERCE_BACKFILL_DAYS'];
});

describe('resolveBackfillDepthMs', () => {
  it('defaults to a 2-year (730-day) window when WOOCOMMERCE_BACKFILL_DAYS is unset', () => {
    delete process.env['WOOCOMMERCE_BACKFILL_DAYS'];
    expect(resolveBackfillDepthMs()).toBe(TWO_YEARS_DAYS * DAY_MS);
  });

  it('uses the configured value when WOOCOMMERCE_BACKFILL_DAYS is a valid integer', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '180';
    expect(resolveBackfillDepthMs()).toBe(180 * DAY_MS);
  });

  it('clamps to the 2-year default when WOOCOMMERCE_BACKFILL_DAYS=0', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '0';
    expect(resolveBackfillDepthMs()).toBe(TWO_YEARS_DAYS * DAY_MS); // 0 is not > 0 so default kicks in
  });

  it('clamps to 730 days when WOOCOMMERCE_BACKFILL_DAYS exceeds maximum', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '9999';
    expect(resolveBackfillDepthMs()).toBe(TWO_YEARS_DAYS * DAY_MS);
  });

  it('falls back to the 2-year default for non-numeric WOOCOMMERCE_BACKFILL_DAYS', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = 'not-a-number';
    expect(resolveBackfillDepthMs()).toBe(TWO_YEARS_DAYS * DAY_MS);
  });

  it('accepts 1 day as the minimum valid depth', () => {
    process.env['WOOCOMMERCE_BACKFILL_DAYS'] = '1';
    expect(resolveBackfillDepthMs()).toBe(1 * DAY_MS);
  });
});
