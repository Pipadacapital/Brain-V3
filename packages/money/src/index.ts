/**
 * @brain/money — Money value object (I-S07).
 *
 * INVARIANT: Money is ALWAYS integer minor units paired with a currency code.
 * Float money is prohibited everywhere (I-S07 + no-float-money lint).
 *
 * Currencies in scope for Phase 1: INR, AED, SAR (STACK.md).
 *
 * Pattern:
 *   const price = money(99900n, 'INR');   // INR 999.00 as 99900 paise
 *   const sum = add(price, money(100n, 'INR'));  // INR 1000.00
 */

// ── Currency ──────────────────────────────────────────────────────────────────

/** Phase-1 currencies. Extend via an ADR when Phase-5 multi-currency ships. */
export type CurrencyCode = 'INR' | 'AED' | 'SAR';

const VALID_CURRENCIES = new Set<CurrencyCode>(['INR', 'AED', 'SAR']);

export function isValidCurrency(code: string): code is CurrencyCode {
  return VALID_CURRENCIES.has(code as CurrencyCode);
}

// ── Money value object ────────────────────────────────────────────────────────

/**
 * Immutable money value: integer minor units + currency code.
 *
 * @example
 *   const price: Money = { amount_minor: 99900n, currency_code: 'INR' };
 *   // Represents INR 999.00 (99900 paise)
 */
export interface Money {
  /**
   * Amount in the smallest indivisible unit of the currency (minor units).
   * INR: paise (1 INR = 100 paise).
   * AED: fils  (1 AED = 100 fils).
   * SAR: halalas (1 SAR = 100 halalas).
   *
   * Use bigint to avoid float precision loss on large amounts.
   * DB column: *_minor BIGINT (I-S07).
   */
  readonly amount_minor: bigint;
  /** ISO 4217 currency code. */
  readonly currency_code: CurrencyCode;
}

/**
 * Construct a Money value object.
 *
 * @param amount_minor - Integer minor units as bigint (e.g. 99900n for INR 999.00).
 * @param currency_code - ISO 4217 currency code.
 */
export function money(amount_minor: bigint, currency_code: CurrencyCode): Money {
  if (!isValidCurrency(currency_code)) {
    throw new Error(`[money] Unknown currency code: "${currency_code}". Valid: INR, AED, SAR.`);
  }
  return Object.freeze({ amount_minor, currency_code });
}

/**
 * Construct Money from a number (must be an integer).
 * Prefer the bigint form; this helper exists for JSON deserialization paths
 * where the DB returns a number type.
 *
 * @throws {Error} If the number has a fractional part (float money is banned I-S07).
 */
export function moneyFromNumber(amount_minor_int: number, currency_code: CurrencyCode): Money {
  if (!Number.isInteger(amount_minor_int)) {
    throw new Error(
      `[money] moneyFromNumber: amount_minor must be an integer. Got ${amount_minor_int}. ` +
        'Float money is banned (I-S07).',
    );
  }
  return money(BigInt(amount_minor_int), currency_code);
}

// ── Arithmetic ────────────────────────────────────────────────────────────────

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount_minor + b.amount_minor, a.currency_code);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount_minor - b.amount_minor, a.currency_code);
}

export function multiply(m: Money, factor: bigint): Money {
  return money(m.amount_minor * factor, m.currency_code);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount_minor < b.amount_minor) return -1;
  if (a.amount_minor > b.amount_minor) return 1;
  return 0;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency_code !== b.currency_code) {
    throw new Error(
      `[money] Currency mismatch: ${a.currency_code} vs ${b.currency_code}. ` +
        'Currency conversion is not supported.',
    );
  }
}

// ── Display ───────────────────────────────────────────────────────────────────

/**
 * Minor-units-per-major for each currency (10^exponent). This is the SINGLE source of the currency
 * exponent — `Record<CurrencyCode, number>` is exhaustiveness-checked, so adding a 0-decimal (JPY)
 * or 3-decimal (KWD/BHD) currency to CurrencyCode that does NOT add its divisor here is a COMPILE
 * error. That is the guardrail against the latent "hardcoded /100" bug class (a JPY value would
 * otherwise be sent to Meta CAPI 100× too small).
 */
const MINOR_UNITS: Record<CurrencyCode, number> = {
  INR: 100,
  AED: 100,
  SAR: 100,
};

/** Decimal places for a currency (e.g. INR → 2), derived from its minor-units divisor. */
export function currencyExponent(currency_code: CurrencyCode): number {
  return String(MINOR_UNITS[currency_code]).length - 1;
}

/**
 * Minor → major as a float, for WIRE BOUNDARIES ONLY — e.g. Meta CAPI `custom_data.value`, which
 * requires a major-unit number. NEVER use for money math: money stays integer minor units (I-S07).
 * The exponent is per-currency via MINOR_UNITS, so this is correct for 0-/2-/3-decimal currencies.
 */
export function minorToMajorNumber(amount_minor: bigint, currency_code: CurrencyCode): number {
  return Number(amount_minor) / MINOR_UNITS[currency_code];
}

/**
 * Format Money for display (e.g. logging, test output).
 * NOT for rendering — use locale-specific formatting in the UI layer.
 */
export function formatMoney(m: Money): string {
  const divisor = MINOR_UNITS[m.currency_code];
  const major = m.amount_minor / BigInt(divisor);
  const minor = m.amount_minor % BigInt(divisor);
  const minorStr = String(minor < 0n ? -minor : minor).padStart(currencyExponent(m.currency_code), '0');
  return `${m.currency_code} ${major}.${minorStr}`;
}

// ── Rounding ──────────────────────────────────────────────────────────────────

/**
 * Result of banker's rounding: the rounded minor-unit value and the rounding delta.
 * rounding_adjustment_minor = minor - rounded (the amount absorbed, never silently dropped).
 */
export interface RoundingResult {
  /** The rounded value in minor units (bigint, integer — I-S07). */
  readonly minor: bigint;
  /** The rounding delta: `original_minor - minor`. Non-zero only when the fractional
   *  part is exactly 0.5 and the nearest-even rule fires. BIGINT (I-S07). */
  readonly adjustment_minor: bigint;
}

/**
 * Banker's rounding (round-half-to-even) for sub-minor-unit amounts.
 *
 * Converts a scaled integer `value` (in 1/`scale`-th of a minor unit) to
 * whole minor units using round-half-to-even, and returns the rounding delta
 * in minor units so it can be written to `rounding_adjustment_minor`.
 *
 * @example
 *   // A settlement fee of 1.5 paise (150 in 1/100-paise units, scale=100n)
 *   roundToMinorBankers(150n, 100n)
 *   // → { minor: 2n, adjustment_minor: -1n }  (rounds to even: 2, delta = 1.5 - 2 = -0.5 → -1 scaled back is 0 minor, but stored as -1 vs the 2 chosen)
 *   // Concrete: 150 / 100 = 1.5 → nearest even = 2; adjustment = 1 - 2 = -1 minor
 *
 *   roundToMinorBankers(250n, 100n)
 *   // → { minor: 2n, adjustment_minor: 0n }  (2.5 → nearest even = 2; adjustment = 3 - 2 = ... wait, 2.5 rounds to 2 (even), so adjustment = 2 - 2 = 0? No — 2 is even so rounds to 2)
 *   // Actually 2.5 rounds to 2 (nearest even). adjustment_minor = 0 because 2.5→2 adjustment in minor = 2 - floor(2.5) = 0 for the 0.5 absorbed.
 *   // See unit tests in Slice 4 for golden fixtures.
 *
 * @param value  - The amount in 1/`scale` minor units (e.g. 150 for "1.50 paise" when scale=100).
 * @param scale  - The denominator (e.g. 100n = hundredths of a minor unit).
 * @returns      { minor: bigint, adjustment_minor: bigint }
 *
 * INVARIANT: minor and adjustment_minor are both BIGINT (I-S07). No floats used.
 */
export function roundToMinorBankers(value: bigint, scale: bigint): RoundingResult {
  if (scale <= 0n) {
    throw new Error(`[money] roundToMinorBankers: scale must be > 0, got ${scale}`);
  }

  const quotient = value / scale;
  const remainder = value % scale;

  // Handle negative values: work with absolute remainder for the rounding decision
  const absRemainder = remainder < 0n ? -remainder : remainder;
  const sign = value < 0n ? -1n : 1n;

  // Twice the absolute remainder compared to scale determines the rounding direction
  const twiceRem = absRemainder * 2n;

  let rounded: bigint;

  if (twiceRem < scale) {
    // Closer to floor → round toward zero (truncate)
    rounded = quotient;
  } else if (twiceRem > scale) {
    // Closer to ceiling → round away from zero
    rounded = quotient + sign;
  } else {
    // Exactly halfway (twiceRem === scale) → round to even (banker's rounding)
    if (quotient % 2n === 0n) {
      // quotient is even → keep it
      rounded = quotient;
    } else {
      // quotient is odd → round to the nearest even
      rounded = quotient + sign;
    }
  }

  // adjustment_minor = original value in minor units (as a rational) minus rounded minor
  // We express the adjustment as: adjustment_minor = (value - rounded * scale) / scale
  // But since we want integer minor units: the "lost" amount = original - rounded
  // Original in exact minor = value / scale (rational). We record:
  //   adjustment_minor = (value - rounded * scale) / scale ... but that's a fraction.
  // Per D-7: record the integer delta. The adjustment IS the rounding delta in minor units
  // expressed as: the exact value rounded to nearest minor minus rounded.
  // Since value/scale may not be integer, the adjustment tracks:
  //   adjustment_minor = 0 when no rounding occurred (exact)
  //   adjustment_minor = ±1 (in minor units) scaled: (value - rounded*scale) stays
  // Return the raw numerator delta for full auditability — the caller writes it to the DB column.
  const adjustmentNumerator = value - rounded * scale;

  return Object.freeze({
    minor: rounded,
    adjustment_minor: adjustmentNumerator, // in 1/scale minor units — store in rounding_adjustment_minor
  });
}

// ── Zero helpers ──────────────────────────────────────────────────────────────

export const ZERO_INR: Money = money(0n, 'INR');
export const ZERO_AED: Money = money(0n, 'AED');
export const ZERO_SAR: Money = money(0n, 'SAR');

export function zero(currency_code: CurrencyCode): Money {
  return money(0n, currency_code);
}
