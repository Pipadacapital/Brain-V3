/**
 * @brain/money — currency-exponent + wire-boundary conversion tests.
 *
 * Guards the latent "hardcoded /100" bug class: minor→major must use the per-currency exponent,
 * not a fixed divisor, so a future 0-/3-decimal currency is never sent off by 100×/10×.
 */
import { describe, it, expect } from 'vitest';
import { currencyExponent, minorToMajorNumber, formatMoney, money } from './index.js';

describe('currencyExponent', () => {
  it('is 2 for the in-scope 2-decimal currencies', () => {
    expect(currencyExponent('INR')).toBe(2);
    expect(currencyExponent('AED')).toBe(2);
    expect(currencyExponent('SAR')).toBe(2);
  });
});

describe('minorToMajorNumber (wire boundary — e.g. Meta CAPI value)', () => {
  it('converts minor units to a major-unit float by the currency exponent', () => {
    expect(minorToMajorNumber(99900n, 'INR')).toBe(999); // 99900 paise → 999.00
    expect(minorToMajorNumber(150n, 'AED')).toBe(1.5);
    expect(minorToMajorNumber(0n, 'SAR')).toBe(0);
  });

  it('handles a sub-major and a negative (clawback) amount', () => {
    expect(minorToMajorNumber(5n, 'INR')).toBe(0.05);
    expect(minorToMajorNumber(-2500n, 'INR')).toBe(-25);
  });
});

describe('formatMoney', () => {
  it('pads the minor part to the currency exponent', () => {
    expect(formatMoney(money(99905n, 'INR'))).toBe('INR 999.05');
    expect(formatMoney(money(100n, 'INR'))).toBe('INR 1.00');
  });
});
