// SPEC:C.4
/**
 * measurement-migration.test.ts — CAC/ROAS/executive marts-migration parity (flag: measurement.marts_migration).
 *
 * PROVES (the C.4 parity gate, in-tree, no Trino needed):
 *   1. RESOLVER: spendView(false|undefined) → legacy view; spendView(true) → measurement view.
 *   2. BYTE-IDENTICAL PARITY: given the SAME spend rows (the measurement view is an AMD-16 alias over
 *      the SAME silver fact), computeChannelRoas / computeAdSpendTimeseries return DEEPLY-EQUAL output
 *      with the flag OFF vs ON — no spend delta, no revenue delta.
 *   3. ONLY THE SOURCE CHANGES: the emitted spend SQL for OFF vs ON is identical after swapping the
 *      view token — the migration is a pure source-swap, never a logic/revenue change.
 *
 * The only program-wide non-zero deltas C.4 permits are newly-captured fees/costs folding into
 * gold_order_economics (C.3) — never into these spend-denominated marts. See the parity note:
 * knowledge-base/gates/wave-c-c4-parity-note.md.
 */
import { describe, it, expect } from 'vitest';
import {
  spendView,
  LEGACY_SPEND_VIEW,
  MEASUREMENT_SPEND_VIEW,
} from './measurement-migration.js';
import { computeChannelRoas } from './attribution-channel-roas.js';
import { computeAdSpendTimeseries } from './ad-spend-timeseries.js';
import type { SilverPool } from './silver-deps.js';

// A capturing mock TrinoPool: returns the SAME fixture rows regardless of WHICH spend view the SQL
// names (that is the whole point — the measurement view is an alias over the same silver fact).
function makeMockPool(): { pool: SilverPool; spendSql: string[] } {
  const spendSql: string[] = [];
  const pool: SilverPool = {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      if (sql.includes('mv_gold_marketing_attribution')) {
        return [
          { channel: 'paid_meta', currency_code: 'INR', contribution_minor: '500000' },
          { channel: 'paid_google', currency_code: 'INR', contribution_minor: '250000' },
        ] as T[];
      }
      if (sql.includes(LEGACY_SPEND_VIEW) || sql.includes(MEASUREMENT_SPEND_VIEW)) {
        // Timeseries query carries a date_format bucket; return the bucketed shape when present.
        if (sql.includes('AS bucket')) {
          spendSql.push(sql);
          return [
            { bucket: '2026-01-01', platform: 'meta', currency_code: 'INR', spend_minor: '100000' },
            { bucket: '2026-01-01', platform: 'google_ads', currency_code: 'INR', spend_minor: '50000' },
          ] as T[];
        }
        spendSql.push(sql);
        return [
          { platform: 'meta', currency_code: 'INR', spend_minor: '100000' },
          { platform: 'google_ads', currency_code: 'INR', spend_minor: '50000' },
        ] as T[];
      }
      return [] as T[];
    },
  };
  return { pool, spendSql };
}

const BRAND = '00000000-0000-0000-0000-0000000000c4';
const WINDOW = { fromDate: new Date('2026-01-01T00:00:00Z'), toDate: new Date('2026-01-31T00:00:00Z') };

describe('C.4 spendView resolver', () => {
  it('resolves legacy by default and measurement when the flag is on', () => {
    expect(spendView(undefined)).toBe(LEGACY_SPEND_VIEW);
    expect(spendView(false)).toBe(LEGACY_SPEND_VIEW);
    expect(spendView(true)).toBe(MEASUREMENT_SPEND_VIEW);
    expect(LEGACY_SPEND_VIEW).not.toBe(MEASUREMENT_SPEND_VIEW);
  });
});

describe('C.4 marts-migration parity — channel ROAS', () => {
  it('flag OFF vs ON: byte-identical rows; only the spend view token differs', async () => {
    const off = makeMockPool();
    const on = makeMockPool();
    const params = { model: 'position_based' as const, ...WINDOW };

    const roasOff = await computeChannelRoas(BRAND, params, { srPool: off.pool });
    const roasOn = await computeChannelRoas(BRAND, params, { srPool: on.pool, measurementMartsMigration: true });

    // Same attributed/spend/ratio for every channel — no revenue delta, no spend delta.
    expect(roasOn).toEqual(roasOff);

    // The spend SQL is identical after normalising the view token → pure source-swap.
    expect(off.spendSql[0]).toContain(LEGACY_SPEND_VIEW);
    expect(on.spendSql[0]).toContain(MEASUREMENT_SPEND_VIEW);
    const norm = (s: string) => s.replace(MEASUREMENT_SPEND_VIEW, LEGACY_SPEND_VIEW);
    expect(norm(on.spendSql[0]!)).toBe(off.spendSql[0]);
  });
});

describe('C.4 marts-migration parity — ad-spend timeseries', () => {
  it('flag OFF vs ON: byte-identical buckets; only the spend view token differs', async () => {
    const off = makeMockPool();
    const on = makeMockPool();
    const params = { ...WINDOW, grain: 'day' as const };

    const tsOff = await computeAdSpendTimeseries(BRAND, params, { srPool: off.pool });
    const tsOn = await computeAdSpendTimeseries(BRAND, params, { srPool: on.pool, measurementMartsMigration: true });

    expect(tsOn).toEqual(tsOff);
    expect(off.spendSql[0]).toContain(LEGACY_SPEND_VIEW);
    expect(on.spendSql[0]).toContain(MEASUREMENT_SPEND_VIEW);
    const norm = (s: string) => s.replace(MEASUREMENT_SPEND_VIEW, LEGACY_SPEND_VIEW);
    expect(norm(on.spendSql[0]!)).toBe(off.spendSql[0]);
  });
});
