/**
 * medallion-journey-logic.test.ts — unit tests for the pure derivations behind the "Data Journey"
 * (medallion observability) page.
 *
 * These exercise the SAME functions the JSX renders from (stageVerdict, humanizeCount,
 * humanizeLag, martTally, servingSummaryLabel), so they guard the actual render path. Kept as
 * pure-logic tests (no React render) to match the repo's node-env vitest setup — apps/web has no
 * jsdom / testing-library harness (see backfill-control-logic.test.ts for the same rationale).
 *
 * Honesty invariants under test:
 *   - 'never'/'no_data' are a calm "No data yet" waiting state, never a fake healthy/zero.
 *   - a null count renders "—", never a fabricated 0.
 *   - a mart is "fresh" ONLY when state === 'fresh'; stale never rounds up.
 */

import { describe, it, expect } from 'vitest';
import {
  stageVerdict,
  humanizeCount,
  humanizeLag,
  martTally,
  servingSummaryLabel,
  type StageState,
} from './medallion-journey-logic';

describe('stageVerdict — state → pill status + plain label', () => {
  it('fresh → healthy', () => {
    expect(stageVerdict('fresh')).toEqual({ status: 'healthy', label: 'Fresh' });
  });

  it('stale → waiting / falling behind', () => {
    expect(stageVerdict('stale')).toEqual({ status: 'waiting', label: 'Falling behind' });
  });

  it('failed is the ONLY error state', () => {
    expect(stageVerdict('failed')).toEqual({ status: 'error', label: 'Failed' });
  });

  it.each(['never', 'no_data', null, undefined] as Array<StageState | null | undefined>)(
    '%s reads "No data yet" as a calm waiting state (never a fabricated healthy/zero)',
    (state) => {
      expect(stageVerdict(state)).toEqual({ status: 'waiting', label: 'No data yet' });
    },
  );

  it('an unknown/forward-compatible state is surfaced verbatim as waiting (never hidden)', () => {
    expect(stageVerdict('rebuilding')).toEqual({ status: 'waiting', label: 'rebuilding' });
  });
});

describe('humanizeCount — compact big-number humaniser', () => {
  it('null/undefined → "—" (honest: no fabricated 0)', () => {
    expect(humanizeCount(null)).toBe('—');
    expect(humanizeCount(undefined)).toBe('—');
  });

  it('a real zero IS shown (0 rows is a fact, not a missing value)', () => {
    expect(humanizeCount(0)).toBe('0');
  });

  it('small counts stay exact with grouping', () => {
    expect(humanizeCount(947)).toBe('947');
  });

  it('thousands → K, one decimal, trailing .0 trimmed', () => {
    expect(humanizeCount(12_400)).toBe('12.4K');
    expect(humanizeCount(2000)).toBe('2K');
  });

  it('millions → M', () => {
    expect(humanizeCount(1_240_000)).toBe('1.2M');
    expect(humanizeCount(1_000_000)).toBe('1M');
  });

  it('billions → B', () => {
    expect(humanizeCount(3_500_000_000)).toBe('3.5B');
  });
});

describe('humanizeLag — watermark lag seconds → "behind" phrase', () => {
  it('null → "lag unknown" (never claims caught-up)', () => {
    expect(humanizeLag(null)).toBe('lag unknown');
    expect(humanizeLag(undefined)).toBe('lag unknown');
  });

  it('non-positive lag → "up to date"', () => {
    expect(humanizeLag(0)).toBe('up to date');
    expect(humanizeLag(-5)).toBe('up to date');
  });

  it('seconds / minutes / hours / days buckets', () => {
    expect(humanizeLag(42)).toBe('42s behind');
    expect(humanizeLag(480)).toBe('8m behind');
    expect(humanizeLag(3 * 3600)).toBe('3h behind');
    expect(humanizeLag(2 * 86400)).toBe('2d behind');
  });
});

describe('martTally + servingSummaryLabel — fresh-vs-stale view accounting', () => {
  it('counts ONLY state==="fresh" as fresh (stale never rounds up)', () => {
    const tally = martTally([
      { state: 'fresh' },
      { state: 'fresh' },
      { state: 'stale' },
      { state: 'failed' },
      { state: 'no_data' },
    ]);
    expect(tally).toEqual({ total: 5, fresh: 2, stale: 3 });
  });

  it('empty / null list → zeroed tally', () => {
    expect(martTally([])).toEqual({ total: 0, fresh: 0, stale: 0 });
    expect(martTally(null)).toEqual({ total: 0, fresh: 0, stale: 0 });
  });

  it('summary label: none / partial / all', () => {
    expect(servingSummaryLabel({ total: 0, fresh: 0, stale: 0 })).toBe('No serving views yet');
    expect(servingSummaryLabel({ total: 5, fresh: 3, stale: 2 })).toBe('3 of 5 views fresh');
    expect(servingSummaryLabel({ total: 5, fresh: 5, stale: 0 })).toBe('All 5 views fresh');
    expect(servingSummaryLabel({ total: 1, fresh: 1, stale: 0 })).toBe('All 1 view fresh');
  });
});
