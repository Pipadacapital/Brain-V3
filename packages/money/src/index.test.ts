/**
 * @brain/money — currency-exponent + wire-boundary conversion tests.
 *
 * Guards the latent "hardcoded /100" bug class: minor→major must use the per-currency exponent,
 * not a fixed divisor, so a future 0-/3-decimal currency is never sent off by 100×/10×.
 */
import { describe, it, expect } from 'vitest';
import {
  currencyExponent, minorToMajorNumber, formatMoney, money,
  minorUnitDigits, minorUnitsDivisor, isValidCurrency,
} from './index.js';

describe('currencyExponent', () => {
  it('is 2 for the 2-decimal currencies (INR/AED/SAR/QAR)', () => {
    expect(currencyExponent('INR')).toBe(2);
    expect(currencyExponent('AED')).toBe(2);
    expect(currencyExponent('SAR')).toBe(2);
    expect(currencyExponent('QAR')).toBe(2);
  });
  it('is 3 for the GCC dinars (KWD/BHD/OMR) and 0 for JPY', () => {
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
    expect(currencyExponent('OMR')).toBe(3);
    expect(currencyExponent('JPY')).toBe(0);
  });
  it('defaults unknown-but-well-formed codes to 2 (never throws)', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(minorUnitDigits('xyz')).toBe(2);
    expect(minorUnitsDivisor('KWD')).toBe(1000);
  });
});

describe('money() — accepts any ISO code, no allowlist throw', () => {
  it('builds Money for any well-formed 3-letter code (the crash fix)', () => {
    expect(money(12500n, 'KWD').currency_code).toBe('KWD');
    expect(money(8900n, 'usd').currency_code).toBe('USD'); // normalised upper-case
  });
  it('still throws on a MALFORMED code (genuine bug)', () => {
    expect(() => money(1n, '')).toThrow(/Malformed currency code/);
    expect(() => money(1n, 'RUPEE')).toThrow(/Malformed currency code/);
  });
  it('isValidCurrency is a format check, not an allowlist', () => {
    expect(isValidCurrency('KWD')).toBe(true);
    expect(isValidCurrency('JPY')).toBe(true);
    expect(isValidCurrency('US')).toBe(false);
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
  it('uses 3 decimals for KWD and 0 for JPY', () => {
    expect(formatMoney(money(12500n, 'KWD'))).toBe('KWD 12.500'); // 12500 fils = 12.500 KWD
    expect(formatMoney(money(8900n, 'JPY'))).toBe('JPY 8900');    // no minor unit
  });
});
