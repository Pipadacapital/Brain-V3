/**
 * @brain/metric-engine — computeRealizedRevenue (D-5)
 *
 * The SOLE emitter of realized_revenue values.
 * Reads via the named DB seam realized_gmv_as_of() (migration 0018) through
 * GetRealizedGmvAsOfQuery — no ad-hoc SUM(amount_minor) anywhere in app code.
 *
 * Returns Map<CurrencyCode, bigint>: per-currency map (M1: 1 entry per brand,
 * since the single-currency-per-brand trigger enforces one currency code in the
 * ledger). Multi-currency is additive from this interface.
 *
 * F-SEC-02: all DB reads happen inside withBrandTxn (explicit BEGIN/COMMIT)
 * so the GUC is genuinely transaction-scoped and cannot leak across pool reuse.
 *
 * @see D-5 (03-architecture-plan.md)
 * @see GetRealizedGmvAsOf.ts — the CQRS query this calls
 * @see 0018_realized_revenue_ledger.sql:176 — realized_gmv_as_of() definition
 */

import type { CurrencyCode } from '@brain/money';
import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

/**
 * computeRealizedRevenue — returns realized revenue as of a date, per currency.
 *
 * Reads the ledger via realized_gmv_as_of() (SECURITY INVOKER, RLS-enforced).
 * The function returns a single BIGINT (legacy scalar from 0018); the engine
 * wraps it into a per-currency Map using the brand's currency_code.
 *
 * In M1, each brand has exactly one currency (enforced by the 0018 trigger),
 * so the returned Map has exactly one entry.
 *
 * @param brandId - The brand UUID.
 * @param asOf    - The as-of date (inclusive). economic_effective_at::date <= asOf.
 * @param deps    - Engine dependencies (pg.Pool).
 * @returns       Map<CurrencyCode, bigint> — realized revenue per currency.
 *                bigint minor units (I-S07). Never floats.
 */
export async function computeRealizedRevenue(
  brandId: string,
  asOf: Date,
  deps: EngineDeps,
): Promise<Map<CurrencyCode, bigint>> {
  const asOfStr = asOf.toISOString().split('T')[0]; // 'YYYY-MM-DD'

  return withBrandTxn(deps.pool, brandId, async (client) => {
    // Step 1: get the brand's currency_code (to key the per-currency map)
    // The brand table holds the authoritative currency_code; the 0018 trigger
    // enforces all ledger rows for this brand use this same currency.
    const brandRow = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM brand WHERE id = $1`,
      [brandId],
    );

    if (!brandRow.rows[0]) {
      // Brand not found → empty map (RLS or missing brand; fail-closed)
      return new Map<CurrencyCode, bigint>();
    }

    const currencyCode = brandRow.rows[0].currency_code as CurrencyCode;

    // Step 2: call the named seam (SOLE as-of path — no ad-hoc SUM)
    // realized_gmv_as_of() is SECURITY INVOKER; the GUC is already set by
    // withBrandTxn so RLS filters to this brand only.
    const result = await client.query<{ realized_gmv_as_of: string }>(
      `SELECT realized_gmv_as_of($1::uuid, $2::date) AS realized_gmv_as_of`,
      [brandId, asOfStr],
    );

    const raw = result.rows[0]?.realized_gmv_as_of ?? '0';
    // pg returns bigint columns as string to avoid JS precision loss
    const valueMinor = BigInt(raw);

    const map = new Map<CurrencyCode, bigint>();
    map.set(currencyCode, valueMinor);
    return map;
  });
}
