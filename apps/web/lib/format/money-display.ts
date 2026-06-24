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

import { money, minorUnitDigits, minorUnitsDivisor, type CurrencyCode } from '@brain/money';

/** Locales that render nicest per currency; anything else falls back to the runtime default. */
const CURRENCY_LOCALE: Record<string, string> = {
  INR: 'en-IN',
  AED: 'en-AE',
  SAR: 'en-SA',
  KWD: 'en-KW',
  BHD: 'en-BH',
  OMR: 'en-OM',
  QAR: 'en-QA',
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
/**
 * Coerce a minor-unit amount string to an integer-minor bigint.
 *
 * Most BFF money fields are already integer minor-unit strings ("123450"). But the
 * derived headline ratios (CAC/LTV/AOV) are emitted by the metric engine as EXACT
 * fractional minor-unit strings ("0.0000", "12345.6789") so the consumer can re-derive
 * the ratio precisely. The smallest unit the UI can render is one whole minor unit
 * (two fraction digits of the major unit), so we round half-away-from-zero to integer
 * minor units here — a fractional paisa/fil/halala is not displayable. Without this,
 * BigInt("0.0000") throws a SyntaxError and crashes the render.
 */
function toIntegerMinor(minorString: string): bigint {
  const s = (minorString ?? '').trim();
  const dot = s.indexOf('.');
  if (dot === -1) return BigInt(s || '0'); // integer fast path

  const negative = s.startsWith('-');
  const intPart = s.slice(0, dot).replace('-', '') || '0';
  const fracPart = s.slice(dot + 1);
  let whole = BigInt(intPart);
  // Round half-away-from-zero on the first fractional digit.
  if (fracPart.length > 0 && Number(fracPart[0]) >= 5) {
    whole += 1n;
  }
  return negative ? -whole : whole;
}

export function formatMoneyDisplay(minorString: string, currencyCode: CurrencyCode): string {
  // Build the Money VO — validates the code FORMAT only (no allowlist; any ISO currency renders).
  // Accepts integer ("123450") or exact-fractional ("0.0000") minor-unit strings.
  const m = money(toIntegerMinor(minorString), currencyCode);
  const code = m.currency_code; // normalised upper-case

  // Per-currency exponent — KWD/BHD/OMR = 3, JPY = 0, default 2. Integer-only decomposition.
  const exponent = minorUnitDigits(code);
  const divisor = BigInt(minorUnitsDivisor(code));
  const major = m.amount_minor / divisor;
  const minorPart = m.amount_minor % divisor;

  // Reconstruct a numeric value for Intl: compose as a string then parse as Number ONLY for display
  // rendering — the value is already an integer decomposition so no precision is lost for typical
  // amounts. The fractional pad width is the CURRENCY exponent (so KWD shows 3 dp, not 2).
  const sign = m.amount_minor < 0n ? '-' : '';
  const absMajor = major < 0n ? -major : major;
  const absMinor = minorPart < 0n ? -minorPart : minorPart;
  const decimalString =
    exponent === 0
      ? `${sign}${absMajor}`
      : `${sign}${absMajor}.${String(absMinor).padStart(exponent, '0')}`;

  // Intl.NumberFormat for locale-aware symbol, grouping, and decimals. Any ISO code works; for an
  // unknown-to-Intl code it renders the code as the symbol (e.g. "KWD 12.500"). Wrapped in try/catch
  // so a render NEVER crashes on a currency the runtime ICU doesn't know — the prod symptom.
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALE[code], {
      style: 'currency',
      currency: code,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(Number(decimalString));
  } catch {
    // Fail-soft fallback — show the code + the exact decimal string rather than throwing.
    return `${code} ${decimalString}`;
  }
}
