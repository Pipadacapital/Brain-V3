/**
 * get-serving-freshness.test.ts — pure derivation unit tests for the V4 serving-tier freshness read.
 *
 * Brain V4 (StarRocks REMOVED): the read now runs over TRINO (Iceberg). It is a two-step probe:
 *   1. enumerate the freshness-bearing brain_serving.mv_* views from information_schema.columns;
 *   2. UNION-ALL probe each for max(updated_at) + count(*).
 * These tests script a fake Trino pool that answers each step, and exercise the verdict derivation
 * (fresh/stale/never), the worst-of surface rollup, the row-count passthrough, and the fail-soft paths
 * (no srPool / Trino error / empty schema → honest no_data). No live DB.
 */

import { describe, it, expect } from 'vitest';
import type { SilverPool } from '@brain/metric-engine';
import { getServingFreshness } from '../internal/application/queries/get-serving-freshness.js';

interface ScriptedAgg {
  mv: string;
  last_refresh_at: string | null;
  row_count: string | number | null;
}

/**
 * A fake Trino SilverPool. The FIRST .query (information_schema.columns) returns the view list; every
 * subsequent .query (the UNION-ALL probe) returns the scripted per-mart aggregates. `'error'` makes the
 * step throw (fail-soft probe). `views: 'error'` throws on the enumerate step.
 */
function fakeSr(
  views: string[] | 'error',
  aggs: ScriptedAgg[] | 'error' = [],
): SilverPool {
  let call = 0;
  return {
    async query(sql: string): Promise<unknown[]> {
      call += 1;
      if (sql.includes('information_schema.columns')) {
        if (views === 'error') throw new Error('Trino unavailable');
        return views.map((table_name) => ({ table_name }));
      }
      // The UNION-ALL probe.
      if (aggs === 'error') throw new Error("Table 'iceberg.brain_serving.mv_x' does not exist");
      return aggs;
    },
    async getConnection() {
      throw new Error('not used — getServingFreshness reads metadata via .query');
    },
  } as unknown as SilverPool;
}

const minutesAgoIso = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

describe('getServingFreshness', () => {
  it('returns no_data when srPool is absent', async () => {
    expect(await getServingFreshness({})).toEqual({ state: 'no_data' });
  });

  it('returns no_data when Trino errors on enumerate (fail-soft, never a 500)', async () => {
    expect(await getServingFreshness({ srPool: fakeSr('error') })).toEqual({ state: 'no_data' });
  });

  it('returns no_data when the probe errors (missing serving view, fail-soft)', async () => {
    expect(
      await getServingFreshness({ srPool: fakeSr(['mv_gold_funnel'], 'error') }),
    ).toEqual({ state: 'no_data' });
  });

  it('returns no_data when brain_serving has no freshness-bearing views', async () => {
    expect(await getServingFreshness({ srPool: fakeSr([]) })).toEqual({ state: 'no_data' });
  });

  it('derives fresh for a recent updated_at and passes the row count through', async () => {
    const res = await getServingFreshness({
      srPool: fakeSr(
        ['mv_gold_funnel'],
        [{ mv: 'mv_gold_funnel', last_refresh_at: minutesAgoIso(5), row_count: '42' }],
      ),
    });
    expect(res.state).toBe('has_data');
    if (res.state !== 'has_data') return;
    expect(res.marts[0]).toMatchObject({
      mv: 'mv_gold_funnel',
      rows: '42',
      freshness: 'fresh',
      refreshState: null,
    });
    expect(res.status).toBe('fresh');
    expect(res.freshCount).toBe(1);
    expect(res.total).toBe(1);
  });

  it('derives stale for an old updated_at (> SLA window)', async () => {
    const res = await getServingFreshness({
      srPool: fakeSr(
        ['mv_gold_cac'],
        [{ mv: 'mv_gold_cac', last_refresh_at: minutesAgoIso(120), row_count: 2 }],
      ),
    });
    if (res.state !== 'has_data') throw new Error('expected has_data');
    expect(res.marts[0]?.freshness).toBe('stale');
    expect(res.status).toBe('stale');
  });

  it('derives never when a mart is empty (no updated_at), worst-of wins the rollup', async () => {
    const res = await getServingFreshness({
      srPool: fakeSr(
        ['mv_gold_funnel', 'mv_gold_cohorts'],
        [
          { mv: 'mv_gold_funnel', last_refresh_at: minutesAgoIso(5), row_count: '42' },
          { mv: 'mv_gold_cohorts', last_refresh_at: null, row_count: 0 },
        ],
      ),
    });
    if (res.state !== 'has_data') throw new Error('expected has_data');
    expect(res.marts.find((m) => m.mv === 'mv_gold_cohorts')).toMatchObject({
      freshness: 'never',
      lastRefreshAt: null,
      ageMinutes: null,
    });
    // Worst-of: one never mart pushes the whole surface to 'never'.
    expect(res.status).toBe('never');
    expect(res.freshCount).toBe(1);
    // Sorted by mv name.
    expect(res.marts.map((m) => m.mv)).toEqual(['mv_gold_cohorts', 'mv_gold_funnel']);
  });
});
