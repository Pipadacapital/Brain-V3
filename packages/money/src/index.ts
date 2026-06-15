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

const MINOR_UNITS: Record<CurrencyCode, number> = {
  INR: 100,
  AED: 100,
  SAR: 100,
};

/**
 * Format Money for display (e.g. logging, test output).
 * NOT for rendering — use locale-specific formatting in the UI layer.
 */
export function formatMoney(m: Money): string {
  const divisor = MINOR_UNITS[m.currency_code];
  const major = m.amount_minor / BigInt(divisor);
  const minor = m.amount_minor % BigInt(divisor);
  const minorStr = String(minor < 0n ? -minor : minor).padStart(2, '0');
  return `${m.currency_code} ${major}.${minorStr}`;
}

// ── Zero helpers ──────────────────────────────────────────────────────────────

export const ZERO_INR: Money = money(0n, 'INR');
export const ZERO_AED: Money = money(0n, 'AED');
export const ZERO_SAR: Money = money(0n, 'SAR');

export function zero(currency_code: CurrencyCode): Money {
  return money(0n, currency_code);
}
