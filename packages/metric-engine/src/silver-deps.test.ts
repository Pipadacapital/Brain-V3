/**
 * silver-deps.test.ts — withSilverBrand graceful degradation when the Silver tier is unavailable.
 *
 * A missing brain_silver schema/table (fresh/dev env not yet provisioned, or a transient StarRocks
 * outage) must degrade a Silver read to an EMPTY result so the dashboard renders an honest no_data
 * state — never a 500. Only the "unknown table/database" class is swallowed; any other query error
 * still propagates.
 */
import { describe, it, expect } from 'vitest';
import { withSilverBrand, BRAND_PREDICATE, type SilverPool, type SilverConnection } from './silver-deps.js';

const BRAND = '11111111-1111-4111-8111-111111111111';

/** A fake StarRocks connection: SET statements succeed; the SELECT runs `onSelect`. */
function fakePool(onSelect: () => Promise<[unknown, unknown]>): SilverPool {
  const conn: SilverConnection = {
    async query(sql: string): Promise<[unknown, unknown]> {
      if (/^\s*SET\b/i.test(sql)) return [[], []];
      return onSelect();
    },
    release() {},
  };
  return {
    async query() {
      return [[], []];
    },
    async getConnection() {
      return conn;
    },
  };
}

describe('withSilverBrand — Silver-unavailable degradation', () => {
  it('returns [] when the silver table is unknown (degrade to no_data, not throw)', async () => {
    const pool = fakePool(() =>
      Promise.reject(new Error("Unknown table 'brain_silver.silver_order_state'.")),
    );
    const rows = await withSilverBrand(pool, BRAND, (scope) =>
      scope.runScoped(`SELECT * FROM silver_order_state WHERE ${BRAND_PREDICATE}`),
    );
    expect(rows).toEqual([]);
  });

  it('returns [] when the silver database is unknown', async () => {
    const pool = fakePool(() => Promise.reject(new Error('Unknown database brain_silver')));
    const rows = await withSilverBrand(pool, BRAND, (scope) =>
      scope.runScoped(`SELECT * FROM silver_touchpoint WHERE ${BRAND_PREDICATE}`),
    );
    expect(rows).toEqual([]);
  });

  it('RETHROWS a non-availability error (real query bug is not masked)', async () => {
    const pool = fakePool(() => Promise.reject(new Error('Syntax error near FROMM')));
    await expect(
      withSilverBrand(pool, BRAND, (scope) =>
        scope.runScoped(`SELECT * FROM silver_order_state WHERE ${BRAND_PREDICATE}`),
      ),
    ).rejects.toThrow('Syntax error');
  });

  it('returns rows unchanged on the happy path', async () => {
    const pool = fakePool(() => Promise.resolve([[{ order_state: 'delivered', n: 3 }], []]));
    const rows = await withSilverBrand(pool, BRAND, (scope) =>
      scope.runScoped(`SELECT order_state, count(*) n FROM silver_order_state WHERE ${BRAND_PREDICATE}`),
    );
    expect(rows).toEqual([{ order_state: 'delivered', n: 3 }]);
  });

  // DB-AUDIT M1 — fail-closed brand predicate.
  it('THROWS when the query is missing the ${BRAND_PREDICATE} sentinel (never runs un-scoped)', async () => {
    const pool = fakePool(() => Promise.resolve([[{ leaked: 'all brands' }], []]));
    await expect(
      withSilverBrand(pool, BRAND, (scope) =>
        // No ${BRAND_PREDICATE} → would otherwise run cross-brand. Must throw, not leak.
        scope.runScoped('SELECT * FROM silver_order_state'),
      ),
    ).rejects.toThrow(/BRAND_PREDICATE/);
  });
});
