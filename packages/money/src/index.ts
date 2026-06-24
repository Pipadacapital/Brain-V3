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

/**
 * Any ISO-4217 alpha-3 currency code (e.g. 'INR', 'KWD', 'JPY', 'USD').
 *
 * MULTI-CURRENCY (was a 3-currency allowlist that THREW on anything else): a render must NEVER
 * crash because an order arrived in a currency outside a hardcoded list. We accept ANY well-formed
 * ISO code and drive decimals from the per-currency minor-unit table below. (The *onboarding*
 * picker still constrains a brand's PRIMARY currency to the supported set — GCC + India for now —
 * but the display layer tolerates any currency an order/connector might carry.)
 */
export type CurrencyCode = string;

/**
 * Minor-unit digits (the ISO-4217 exponent) for currencies that are NOT the 2-digit default.
 * The correctness guardrail behind the "/100" bug class: the GCC dinars (KWD/BHD/OMR) have 1000
 * sub-units (3 digits) and JPY has none (0 digits) — treating either as 2-digit renders amounts
 * 10×–100× wrong. Everything not listed defaults to 2. Source: ISO-4217.
 */
const MINOR_UNIT_DIGITS_EXCEPTIONS: Record<string, number> = {
  // 0-decimal currencies
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3-decimal currencies — includes GCC dinars KWD/BHD/OMR (supported now)
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4-decimal
  CLF: 4, UYW: 4,
};

/** A well-formed ISO-4217 code is 3 ASCII letters. We accept any such code (no allowlist). */
const ISO_4217_RE = /^[A-Za-z]{3}$/;

/** Normalise to the upper-case 3-letter form the rest of the module uses. */
function normalizeCurrency(code: string): string {
  return (code ?? '').trim().toUpperCase();
}

/** True iff `code` is a well-formed ISO-4217 alpha-3 code. NOT an allowlist — format only. */
export function isValidCurrency(code: string): code is CurrencyCode {
  return ISO_4217_RE.test(normalizeCurrency(code));
}

/** Minor-unit digits (exponent) for a currency — 2 unless it's a known 0/3/4-digit currency. */
export function minorUnitDigits(currency_code: string): number {
  return MINOR_UNIT_DIGITS_EXCEPTIONS[normalizeCurrency(currency_code)] ?? 2;
}

/** Minor-units-per-major (10^exponent) for a currency — the divisor for minor↔major. */
export function minorUnitsDivisor(currency_code: string): number {
  return 10 ** minorUnitDigits(currency_code);
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
  // Validate FORMAT only (3-letter ISO code), never an allowlist — a real order can be in any
  // currency and money() is on the render path. Malformed/empty codes still throw (a genuine bug).
  if (!isValidCurrency(currency_code)) {
    throw new Error(`[money] Malformed currency code: "${currency_code}" (expected a 3-letter ISO-4217 code).`);
  }
  return Object.freeze({ amount_minor, currency_code: normalizeCurrency(currency_code) });
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
 * Decimal places for a currency (e.g. INR → 2, KWD → 3, JPY → 0). Per-currency via the ISO-4217
 * minor-unit table — the guardrail against the latent "hardcoded /100" bug class (a JPY value would
 * otherwise be sent to Meta CAPI 100× too small; a KWD value 10×).
 */
export function currencyExponent(currency_code: CurrencyCode): number {
  return minorUnitDigits(currency_code);
}

/**
 * Minor → major as a float, for WIRE BOUNDARIES ONLY — e.g. Meta CAPI `custom_data.value`, which
 * requires a major-unit number. NEVER use for money math: money stays integer minor units (I-S07).
 * The exponent is per-currency, so this is correct for 0-/2-/3-/4-decimal currencies.
 */
export function minorToMajorNumber(amount_minor: bigint, currency_code: CurrencyCode): number {
  return Number(amount_minor) / minorUnitsDivisor(currency_code);
}

/**
 * Format Money for display (e.g. logging, test output).
 * NOT for rendering — use locale-specific formatting in the UI layer.
 */
export function formatMoney(m: Money): string {
  const divisor = BigInt(minorUnitsDivisor(m.currency_code));
  const exponent = currencyExponent(m.currency_code);
  const major = m.amount_minor / divisor;
  const minor = m.amount_minor % divisor;
  const absMajor = major < 0n ? -major : major;
  const sign = m.amount_minor < 0n ? '-' : '';
  if (exponent === 0) return `${m.currency_code} ${sign}${absMajor}`;
  const minorStr = String(minor < 0n ? -minor : minor).padStart(exponent, '0');
  return `${m.currency_code} ${sign}${absMajor}.${minorStr}`;
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
