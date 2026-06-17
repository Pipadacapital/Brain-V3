/**
 * money-utils.ts — Integer arithmetic conversion for Shopify price strings (D-13 / I-S07).
 *
 * Shopify returns prices as decimal strings: "1250.00", "999.00", "15.5" etc.
 * These represent the major-currency unit (e.g. INR rupees, USD dollars).
 *
 * DO NOT use Math.round(parseFloat(str) * 100): floating-point errors at large
 * amounts (e.g. "99999.99" → 9999998 instead of 9999999) violate I-S07.
 *
 * Correct approach: split on '.', assert ≤2 decimal places, use BigInt arithmetic.
 *
 * Output: BigInt representing the amount in minor units (e.g. paisa for INR).
 */

/**
 * Convert a Shopify decimal-string price to minor units (BigInt).
 *
 * @param str  Shopify price string (e.g. "1250.00", "999", "15.5")
 * @returns    Amount in minor units as BigInt (e.g. 125000n, 99900n, 1550n)
 * @throws     Error if the input is not a valid non-negative decimal with ≤2 decimal places
 */
export function decimalStringToMinor(str: string): bigint {
  const trimmed = str.trim();

  // Validate: only digits and an optional single decimal point
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(
      `[money-utils] decimalStringToMinor: invalid price string "${trimmed}" — ` +
      `expected non-negative decimal with at most 2 decimal places (I-S07)`,
    );
  }

  const dotIdx = trimmed.indexOf('.');
  if (dotIdx === -1) {
    // Integer amount (no decimal point): multiply by 100
    return BigInt(trimmed) * 100n;
  }

  const wholePart = trimmed.slice(0, dotIdx);
  const fracPart = trimmed.slice(dotIdx + 1);

  // Pad fractional part to exactly 2 digits ('5' → '50')
  const fracPadded = fracPart.padEnd(2, '0');

  return BigInt(wholePart) * 100n + BigInt(fracPadded);
}
