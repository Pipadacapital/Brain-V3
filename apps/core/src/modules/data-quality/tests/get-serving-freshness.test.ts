/**
 * get-serving-freshness.test.ts — pure derivation unit tests for the V4 serving-tier freshness read.
 *
 * Exercises the freshness verdict derivation (fresh/stale/failed/never), the worst-of surface rollup,
 * the row-count passthrough, and the fail-soft paths (no srPool / StarRocks error / empty schema →
 * honest no_data), using a fake SilverPool that scripts the information_schema response. No live DB.
 */

import { describe, it, expect } from 'vitest';
import type { SilverPool } from '@brain/metric-engine';
import { getServingFreshness } from '../internal/application/queries/get-serving-freshness.js';

interface ScriptedMvRow {
  TABLE_NAME: string;
  TABLE_ROWS: number | string | null;
  LAST_REFRESH_FINISHED_TIME: Date | string | null;
  LAST_REFRESH_STATE: string | null;
}

/** A fake SilverPool whose .query returns the scripted information_schema rows (or throws). */
function fakeSr(rows: ScriptedMvRow[] | 'error'): SilverPool {
  return {
    async query(): Promise<[unknown, unknown]> {
      if (rows === 'error') throw new Error('StarRocks unavailable');
      return [rows, undefined];
    },
    async getConnection() {
      throw new Error('not used — getServingFreshness reads metadata via .query');
    },
  } as unknown as SilverPool;
}

const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);

describe('getServingFreshness', () => {
  it('returns no_data when srPool is absent', async () => {
    expect(await getServingFreshness({})).toEqual({ state: 'no_data' });
  });

  it('returns no_data when StarRocks errors (fail-soft, never a 500)', async () => {
    expect(await getServingFreshness({ srPool: fakeSr('error') })).toEqual({ state: 'no_data' });
  });

  it('returns no_data when brain_serving has no MVs', async () => {
    expect(await getServingFreshness({ srPool: fakeSr([]) })).toEqual({ state: 'no_data' });
  });

  it('derives fresh for a recent SUCCESS refresh and passes the row count through', async () => {
    const res = await getServingFreshness({
      srPool: fakeSr([
        { TABLE_NAME: 'mv_gold_funnel', TABLE_ROWS: 42, LAST_REFRESH_FINISHED_TIME: minutesAgo(5), LAST_REFRESH_STATE: 'SUCCESS' },
      ]),
    });
    expect(res.state).toBe('has_data');
    if (res.state !== 'has_data') return;
    expect(res.marts[0]).toMatchObject({ mv: 'mv_gold_funnel', rows: '42', freshness: 'fresh', refreshState: 'SUCCESS' });
    expect(res.status).toBe('fresh');
    expect(res.freshCount).toBe(1);
    expect(res.total).toBe(1);
  });

  it('derives stale for an old SUCCESS refresh (> SLA window)', async () => {
    const res = await getServingFreshness({
      srPool: fakeSr([
        { TABLE_NAME: 'mv_gold_cac', TABLE_ROWS: 2, LAST_REFRESH_FINISHED_TIME: minutesAgo(120), LAST_REFRESH_STATE: 'SUCCESS' },
      ]),
    });
    if (res.state !== 'has_data') throw new Error('expected has_data');
    expect(res.marts[0]?.freshness).toBe('stale');
    expect(res.status).toBe('stale');
  });

  it('derives failed when the last refresh state is not SUCCESS (worst-of wins the rollup)', async () => {
    const res = await getServingFreshness({
      srPool: fakeSr([
        { TABLE_NAME: 'mv_gold_funnel', TABLE_ROWS: 42, LAST_REFRESH_FINISHED_TIME: minutesAgo(5), LAST_REFRESH_STATE: 'SUCCESS' },
        { TABLE_NAME: 'mv_gold_revenue_ledger', TABLE_ROWS: 0, LAST_REFRESH_FINISHED_TIME: minutesAgo(5), LAST_REFRESH_STATE: 'FAILED' },
      ]),
    });
    if (res.state !== 'has_data') throw new Error('expected has_data');
    expect(res.marts.find((m) => m.mv === 'mv_gold_revenue_ledger')?.freshness).toBe('failed');
    // Worst-of: one failed mart pushes the whole surface to 'failed'.
    expect(res.status).toBe('failed');
    expect(res.freshCount).toBe(1);
  });

  it('derives never when an MV has no finished-refresh timestamp', async () => {
    const res = await getServingFreshness({
      srPool: fakeSr([
        { TABLE_NAME: 'mv_gold_cohorts', TABLE_ROWS: 0, LAST_REFRESH_FINISHED_TIME: null, LAST_REFRESH_STATE: null },
      ]),
    });
    if (res.state !== 'has_data') throw new Error('expected has_data');
    expect(res.marts[0]).toMatchObject({ freshness: 'never', lastRefreshAt: null, ageMinutes: null });
    expect(res.marts).toHaveLength(1);
    expect(res.status).toBe('never');
  });
});
