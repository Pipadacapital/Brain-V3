/**
 * recommendation-detectors.test.ts — thin-data resilience of the detector cron.
 *
 * Prod evidence (2026-07-18): the recommendation-detectors Argo cron failed INTERMITTENTLY with
 * `err: invalid input syntax for type uuid: ""` ("detector run failed for brand"). Root cause: the
 * brand enumeration (`list_active_brand_ids()`) can surface a degenerate id (empty string) under
 * thin/empty data; binding `""` into the detectors' first uuid read (`WHERE id = $1::uuid`) makes
 * Postgres raise, which used to crash that brand's whole run (→ errors>0 → exit 1).
 *
 * An unusable brand id is a DATA-QUALITY skip, not a detector failure. These tests pin:
 *   • an empty/invalid brand id is SKIPPED (counted in `skipped`), never an error, and never bound
 *     into a serving/PG query (the pool is never even touched for it);
 *   • a valid brand id still runs normally alongside a skipped one (no throw, run completes).
 *
 * Runs against a FAKE pg pool + a FAKE serving pool (mirrors attribution-reconcile.test.ts) — no DB.
 */
import { describe, it, expect } from 'vitest';
import type { DbPool, DbClient } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { runRecommendationDetectors } from './recommendation-detectors.js';

const VALID_BRAND = '5a0f3ac6-1111-4222-8333-444455556666';

/**
 * Minimal DbPool stand-in. `list_active_brand_ids()` returns the scripted rows; every other query
 * (the per-brand detector reads/writes) returns empty — so a VALID brand completes with raised=0
 * and no throw, exactly like a thin-data brand. If an empty/invalid brand id ever reaches a per-brand
 * query, `sawBrandParam` records it so the test can assert it was NEVER bound.
 */
function fakePool(brandIds: string[], sink: { params: unknown[] }): DbPool {
  const client: DbClient = {
    async query<T>(_ctx: unknown, sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
      sink.params.push(...params);
      if (sql.includes('list_active_brand_ids')) {
        return { rows: brandIds.map((id) => ({ id })) as T[], rowCount: brandIds.length };
      }
      // Any per-brand read/write (brand lookup, cost inputs, upserts, measure select) → empty.
      return { rows: [] as T[], rowCount: 0 };
    },
    release() {},
  };
  return {
    connect: async () => client,
    end: async () => {},
  };
}

/** Serving pool that always degrades to empty — thin-data brands have no gold/silver yet. */
const emptySrPool: SilverPool = {
  async query<T>(): Promise<T[]> {
    return [] as T[];
  },
};

describe('runRecommendationDetectors — empty/invalid brand id resilience', () => {
  it('skips an empty-string brand id instead of crashing the brand (no `""::uuid`)', async () => {
    const sink = { params: [] as unknown[] };
    const res = await runRecommendationDetectors({ pool: fakePool([''], sink), srPool: emptySrPool });

    expect(res.skipped).toBe(1);
    expect(res.brands).toBe(0); // the empty brand was never run
    expect(res.errors).toBe(0); // a data-quality skip is NOT an error (→ exit 0)
    expect(res.raised).toBe(0);
    // The empty id was never bound into any downstream query param.
    expect(sink.params).not.toContain('');
  });

  it('skips a malformed (non-uuid) brand id the same way', async () => {
    const sink = { params: [] as unknown[] };
    const res = await runRecommendationDetectors({ pool: fakePool(['not-a-uuid'], sink), srPool: emptySrPool });

    expect(res.skipped).toBe(1);
    expect(res.brands).toBe(0);
    expect(res.errors).toBe(0);
    expect(sink.params).not.toContain('not-a-uuid');
  });

  it('a skipped brand does not abort the run — a valid brand still runs', async () => {
    const sink = { params: [] as unknown[] };
    const res = await runRecommendationDetectors({
      pool: fakePool(['', VALID_BRAND], sink),
      srPool: emptySrPool,
    });

    expect(res.skipped).toBe(1);
    expect(res.brands).toBe(1); // the valid brand was processed
    expect(res.errors).toBe(0); // completes cleanly (raised=0 for thin data)
    expect(res.raised).toBe(0);
    // The valid brand id WAS used; the empty one never was.
    expect(sink.params).toContain(VALID_BRAND);
    expect(sink.params).not.toContain('');
  });
});
