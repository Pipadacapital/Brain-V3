import { describe, it, expect } from 'vitest';
import { computeJourneyEventsCurrent } from './journey-events.js';
import type { SilverPool } from './silver-deps.js';

const BRAND = '33333333-3333-4333-8333-333333333333';
const BRAIN = '44444444-4444-4444-8444-444444444444';

/** Fake Trino serving pool: every query returns `rows`; captures the last SQL + params. */
function fakePool(rows: Array<Record<string, unknown>>): SilverPool & {
  lastSql: string;
  lastParams: unknown[];
} {
  const pool = {
    lastSql: '',
    lastParams: [] as unknown[],
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      pool.lastSql = sql;
      pool.lastParams = params;
      return rows as T[];
    },
  };
  return pool;
}

function row(seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    touchpoint_id: `tp-${seq}`,
    sequence_number: String(seq),
    occurred_at: '2026-07-01 21:10:00.725 UTC',
    event_category: 'behaviour',
    event_type: 'page.viewed',
    channel: 'referral',
    campaign: null,
    revenue_minor: null,
    currency_code: null,
    is_composite: false,
    identity_confidence: null,
    data_version: 1,
    ...extra,
  };
}

describe('computeJourneyEventsCurrent — versioned journey-ledger current page', () => {
  it('maps a page (newest-first) with the look-ahead row trimmed and a next keyset', async () => {
    // limit=2 → the seam asks for 3; a 3rd row means a further page exists.
    const pool = fakePool([row(9), row(8), row(7)]);
    const page = await computeJourneyEventsCurrent(BRAND, { srPool: pool }, { brainId: BRAIN, limit: 2 });
    expect(page.hasData).toBe(true);
    expect(page.events).toHaveLength(2);
    expect(page.events.map((e) => e.sequenceNumber)).toEqual(['9', '8']);
    expect(page.nextAfterSequence).toBe('8'); // last RETURNED row, not the look-ahead
    expect(pool.lastSql).toContain('LIMIT 3');
    expect(pool.lastSql).toContain('ORDER BY occurred_at DESC, sequence_number DESC');
    // Brand predicate injected by the seam; brainId binds first, brandId LAST.
    expect(pool.lastSql).toContain('brand_id = ?');
    expect(pool.lastParams).toEqual([BRAIN, BRAND]);
  });

  it('last page: no look-ahead row → nextAfterSequence is null', async () => {
    const page = await computeJourneyEventsCurrent(
      BRAND,
      { srPool: fakePool([row(2), row(1)]) },
      { brainId: BRAIN, limit: 2 },
    );
    expect(page.events).toHaveLength(2);
    expect(page.nextAfterSequence).toBeNull();
  });

  it('binds a valid afterSequence keyset as a strict bigint bound', async () => {
    const pool = fakePool([row(7)]);
    await computeJourneyEventsCurrent(BRAND, { srPool: pool }, { brainId: BRAIN, afterSequence: '8', limit: 2 });
    expect(pool.lastSql).toContain('sequence_number < ?');
    expect(pool.lastParams).toEqual([BRAIN, 8n, BRAND]);
  });

  it('treats an invalid afterSequence as absent (first page — never a hard-fail)', async () => {
    const pool = fakePool([row(9)]);
    await computeJourneyEventsCurrent(
      BRAND,
      { srPool: pool },
      { brainId: BRAIN, afterSequence: 'DROP TABLE; --', limit: 2 },
    );
    expect(pool.lastSql).not.toContain('sequence_number < ?');
    expect(pool.lastParams).toEqual([BRAIN, BRAND]);
  });

  it('money: composite row carries revenue_minor verbatim as a bigint string + sibling currency', async () => {
    const page = await computeJourneyEventsCurrent(
      BRAND,
      {
        srPool: fakePool([
          row(5, { is_composite: true, revenue_minor: '123450', currency_code: 'INR', event_type: 'order.placed' }),
        ]),
      },
      { brainId: BRAIN },
    );
    expect(page.events[0]).toMatchObject({
      isComposite: true,
      revenueMinor: '123450',
      currencyCode: 'INR',
    });
  });

  it('honest-empty: no rows → hasData=false (and an empty brainId never queries)', async () => {
    expect(await computeJourneyEventsCurrent(BRAND, { srPool: fakePool([]) }, { brainId: BRAIN })).toEqual({
      hasData: false,
      events: [],
      nextAfterSequence: null,
    });
    expect(await computeJourneyEventsCurrent(BRAND, { srPool: fakePool([row(1)]) }, { brainId: '' })).toEqual({
      hasData: false,
      events: [],
      nextAfterSequence: null,
    });
  });
});
