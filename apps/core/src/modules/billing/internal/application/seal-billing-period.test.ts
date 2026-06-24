/**
 * seal-billing-period.test.ts — focused unit tests for periodEndDate() (T-2).
 *
 * periodEndDate() is the billing meter's as-of date: the LAST calendar day of a 'YYYY-MM'
 * period (UTC), via Date.UTC(y, m, 0) ("day 0 of the next month" = last day of this month).
 * It is load-bearing for billing correctness — an off-by-one at the month boundary would meter
 * the wrong window. These cases pin the month-length table, the Feb leap/non-leap split, and the
 * single-digit-day zero-pad. No DB / I-O (the function is pure).
 */
import { describe, it, expect } from 'vitest';
import { periodEndDate } from './seal-billing-period.js';

describe('periodEndDate', () => {
  it('returns the 31st for 31-day months', () => {
    expect(periodEndDate('2025-01')).toBe('2025-01-31');
    expect(periodEndDate('2025-03')).toBe('2025-03-31');
    expect(periodEndDate('2025-05')).toBe('2025-05-31');
    expect(periodEndDate('2025-07')).toBe('2025-07-31');
    expect(periodEndDate('2025-08')).toBe('2025-08-31');
    expect(periodEndDate('2025-10')).toBe('2025-10-31');
    expect(periodEndDate('2025-12')).toBe('2025-12-31');
  });

  it('returns the 30th for 30-day months', () => {
    expect(periodEndDate('2025-04')).toBe('2025-04-30');
    expect(periodEndDate('2025-06')).toBe('2025-06-30');
    expect(periodEndDate('2025-09')).toBe('2025-09-30');
    expect(periodEndDate('2025-11')).toBe('2025-11-30');
  });

  it('returns Feb 28 in a common (non-leap) year', () => {
    expect(periodEndDate('2025-02')).toBe('2025-02-28');
    expect(periodEndDate('2023-02')).toBe('2023-02-28');
  });

  it('returns Feb 29 in a leap year (divisible by 4)', () => {
    expect(periodEndDate('2024-02')).toBe('2024-02-29');
    expect(periodEndDate('2028-02')).toBe('2028-02-29');
  });

  it('returns Feb 29 in a leap year divisible by 400', () => {
    expect(periodEndDate('2000-02')).toBe('2000-02-29');
  });

  it('returns Feb 28 in a century non-leap year (divisible by 100, not 400)', () => {
    expect(periodEndDate('1900-02')).toBe('1900-02-28');
    expect(periodEndDate('2100-02')).toBe('2100-02-28');
  });

  it('zero-pads the day for single-digit-day months (always 2-digit DD)', () => {
    // Every last-day here is 2-digit already, but assert the YYYY-MM-DD shape holds.
    expect(periodEndDate('2025-02')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(periodEndDate('2025-12')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('handles December (month 12 → day 0 of "month 12" = Dec 31, no year overflow)', () => {
    expect(periodEndDate('2025-12')).toBe('2025-12-31');
    expect(periodEndDate('2024-12')).toBe('2024-12-31');
  });
});
