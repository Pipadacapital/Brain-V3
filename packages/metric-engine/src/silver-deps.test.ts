/**
 * silver-deps.test.ts — withSilverBrand over TRINO: graceful degradation + fail-closed brand predicate.
 *
 * Brain V4: the Silver/Gold seam runs over Trino (Iceberg), not StarRocks. withSilverBrand delegates to
 * withServingBrand but keeps the StarRocks-era contract the ~49 callers depend on:
 *   • a missing brain_serving view / Iceberg table (fresh/dev env not yet provisioned, or a transient
 *     outage surfaced as "does not exist") degrades a read to an EMPTY result so the dashboard renders an
 *     honest no_data state — never a 500. Only the table/schema-not-found class is swallowed; any other
 *     query error still propagates.
 *   • a query missing the ${BRAND_PREDICATE} sentinel THROWS (fail-closed — never runs cross-brand).
 */
import { describe, it, expect } from 'vitest';
import { withSilverBrand, BRAND_PREDICATE, type SilverPool } from './silver-deps.js';

const BRAND = '11111111-1111-4111-8111-111111111111';

/** A fake Trino pool: every query runs `onQuery` (returns rows or rejects). */
function fakePool(onQuery: () => Promise<unknown[]>): SilverPool {
  return {
    async query<T = Record<string, unknown>>(): Promise<T[]> {
      return (await onQuery()) as T[];
    },
  };
}

describe('withSilverBrand (Trino) — serving-unavailable degradation', () => {
  it('returns [] when the Trino table does not exist (degrade to no_data, not throw)', async () => {
    const pool = fakePool(() =>
      Promise.reject(new Error("line 1:15: Table 'iceberg.brain_serving.mv_silver_order_state' does not exist")),
    );
    const rows = await withSilverBrand(pool, BRAND, (scope) =>
      scope.runScoped(`SELECT * FROM brain_serving.mv_silver_order_state WHERE ${BRAND_PREDICATE}`),
    );
    expect(rows).toEqual([]);
  });

  it('returns [] when the Trino schema does not exist', async () => {
    const pool = fakePool(() => Promise.reject(new Error("Schema 'brain_serving' does not exist")));
    const rows = await withSilverBrand(pool, BRAND, (scope) =>
      scope.runScoped(`SELECT * FROM brain_serving.mv_silver_touchpoint WHERE ${BRAND_PREDICATE}`),
    );
    expect(rows).toEqual([]);
  });

  it('still degrades on the legacy StarRocks "unknown table" phrasing (transition window)', async () => {
    const pool = fakePool(() => Promise.reject(new Error("Unknown table 'brain_silver.silver_order_state'.")));
    const rows = await withSilverBrand(pool, BRAND, (scope) =>
      scope.runScoped(`SELECT * FROM brain_serving.mv_silver_order_state WHERE ${BRAND_PREDICATE}`),
    );
    expect(rows).toEqual([]);
  });

  it('RETHROWS a non-availability error (real query bug is not masked)', async () => {
    const pool = fakePool(() => Promise.reject(new Error('Syntax error near FROMM')));
    await expect(
      withSilverBrand(pool, BRAND, (scope) =>
        scope.runScoped(`SELECT * FROM brain_serving.mv_silver_order_state WHERE ${BRAND_PREDICATE}`),
      ),
    ).rejects.toThrow('Syntax error');
  });

  it('returns rows unchanged on the happy path', async () => {
    const pool = fakePool(() => Promise.resolve([{ order_state: 'delivered', n: 3 }]));
    const rows = await withSilverBrand(pool, BRAND, (scope) =>
      scope.runScoped(
        `SELECT order_state, count(*) n FROM brain_serving.mv_silver_order_state WHERE ${BRAND_PREDICATE}`,
      ),
    );
    expect(rows).toEqual([{ order_state: 'delivered', n: 3 }]);
  });

  // DB-AUDIT M1 — fail-closed brand predicate (preserved across the Trino swap).
  it('THROWS when the query is missing the ${BRAND_PREDICATE} sentinel (never runs un-scoped)', async () => {
    const pool = fakePool(() => Promise.resolve([{ leaked: 'all brands' }]));
    await expect(
      withSilverBrand(pool, BRAND, (scope) =>
        // No ${BRAND_PREDICATE} → would otherwise run cross-brand. Must throw, not leak.
        scope.runScoped('SELECT * FROM brain_serving.mv_silver_order_state'),
      ),
    ).rejects.toThrow(/BRAND_PREDICATE/);
  });
});
