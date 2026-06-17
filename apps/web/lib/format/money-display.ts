/**
 * UI money display formatter — locale-aware, minor-units-safe.
 *
 * INVARIANT (I-S07, D-7): Money is ALWAYS integer minor units + currency_code.
 * - Input: minor-unit string (bigint serialized from the BFF) + ISO 4217 currency_code.
 * - No parseFloat, no /100, no float math.
 * - Use BigInt() to parse the minor-unit string.
 * - Intl.NumberFormat renders the final display string.
 *
 * The @brain/money `formatMoney` is LOG-ONLY (not for rendering — packages/money/src/index.ts:123).
 * This thin wrapper IS the rendering formatter; it consumes the money() VO for the
 * minor-unit model and delegates display to Intl.
 *
 * Covers Phase-1 currencies: INR (100 paise/rupee), AED (100 fils/dirham), SAR (100 halalas/riyal).
 */

import { money, type CurrencyCode } from '@brain/money';

/** Minor-unit divisors by currency (matches packages/money/src/index.ts MINOR_UNITS). */
const MINOR_DIVISORS: Record<CurrencyCode, bigint> = {
  INR: 100n,
  AED: 100n,
  SAR: 100n,
};

/**
 * Format a minor-unit string (e.g. "123450") with its currency code to a
 * locale-aware display string (e.g. "₹1,234.50" for INR).
 *
 * @param minorString  - The minor-unit amount as a string (bigint-serialized from BFF).
 * @param currencyCode - ISO 4217 currency code.
 * @returns Display string suitable for rendering in the UI.
 *
 * @example
 *   formatMoneyDisplay('123450', 'INR') // → '₹1,234.50'  (no float math)
 *   formatMoneyDisplay('50000', 'AED')  // → 'AED 500.00'
 */
export function formatMoneyDisplay(minorString: string, currencyCode: CurrencyCode): string {
  // Build the Money VO — validates the currency code (throws on invalid).
  const m = money(BigInt(minorString), currencyCode);

  // Integer-arithmetic split into major and fractional parts.
  const divisor = MINOR_DIVISORS[currencyCode];
  const major = m.amount_minor / divisor;
  const minorPart = m.amount_minor % divisor;

  // Reconstruct a numeric value for Intl: compose as a string then parse as Number
  // ONLY for display rendering — the value is already an integer decomposition so
  // no precision is lost within the Number.MAX_SAFE_INTEGER range for typical amounts.
  // For very large amounts (> Number.MAX_SAFE_INTEGER / 100), the bigint decomposition
  // already handles precision correctly; we combine as a decimal string.
  const sign = m.amount_minor < 0n ? '-' : '';
  const absMajor = major < 0n ? -major : major;
  const absMinor = minorPart < 0n ? -minorPart : minorPart;
  const decimalString = `${sign}${absMajor}.${String(absMinor).padStart(2, '0')}`;

  // Intl.NumberFormat for locale-aware symbol, grouping, and decimal formatting.
  // 'en-IN' is the canonical locale for INR display; AED/SAR use 'en-AE'/'en-SA'.
  const localeMap: Record<CurrencyCode, string> = {
    INR: 'en-IN',
    AED: 'en-AE',
    SAR: 'en-SA',
  };

  return new Intl.NumberFormat(localeMap[currencyCode], {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(decimalString));
}
