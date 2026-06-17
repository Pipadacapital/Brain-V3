/**
 * RevenueSnapshot — domain value-object for the analytics bounded context.
 *
 * Represents a point-in-time revenue reading for a brand.
 * All money values are bigint minor units serialized to string for JSON safety
 * (JSON has no bigint; the engine's pg-string convention is preserved end-to-end).
 *
 * INVARIANTS (enforced at the use-case level):
 *   - state='no_data' => realized=null, provisional=null (honest-empty-state, D-2).
 *   - realized and provisional are NEVER summed or blended (D-4).
 *   - values are bigint minor units as STRING (D-1), never floats.
 *
 * @see D-1, D-2, D-4 (03-architecture-plan.md §4)
 */

import type { CurrencyCode } from '@brain/money';

/**
 * Per-currency map of bigint minor units serialized to string.
 * e.g. { INR: "123450" } — represents INR 1234.50 (minor units = paise).
 * NEVER a number or float — bigint-to-string preserves full precision (I-S07).
 */
export type MoneyRecord = Record<string, string>;

/**
 * RevenueSnapshot — the shape returned by getRevenueMetrics.
 *
 * state='no_data':  brand has zero finalized ledger rows → realized=null, provisional=null.
 * state='has_data': at least one finalized row exists → realized and provisional are maps.
 *
 * D-2: state is driven by EXISTS(finalized), NOT by the numeric value.
 * A real net-zero brand (sale + refund = 0) returns state='has_data' + { INR: '0' }.
 * Only absence of finalized rows returns state='no_data'.
 */
export type RevenueSnapshot =
  | {
      state: 'no_data';
      as_of: string; // YYYY-MM-DD
      realized: null;
      provisional: null;
    }
  | {
      state: 'has_data';
      as_of: string; // YYYY-MM-DD
      realized: MoneyRecord;
      provisional: MoneyRecord; // empty {} when no provisional rows
    };

/**
 * serializeMoneyMap — converts Map<CurrencyCode, bigint> to Record<string, string>.
 *
 * bigint → String(v): preserves full precision without float coercion.
 * Each currency entry maps to its minor-unit value as a decimal string.
 *
 * @param m - The engine's output map (Map<CurrencyCode, bigint>).
 * @returns  Record<currency_code, string> — JSON-safe serialization.
 */
export function serializeMoneyMap(m: Map<CurrencyCode, bigint>): MoneyRecord {
  const record: MoneyRecord = {};
  for (const [ccy, value] of m) {
    record[ccy] = String(value);
  }
  return record;
}
