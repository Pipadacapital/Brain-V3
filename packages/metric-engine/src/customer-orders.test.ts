/**
 * customer-orders.test.ts — the per-customer order list + its AUD-SL-11 keyset-paginated variant.
 *
 * Mocks the withSilverBrand seam (no DB) and captures the SQL/params each runScoped call receives,
 * so we lock down: LIMIT clamping, the look-ahead (lim+1) page probe, the opaque-cursor round-trip
 * (base64url of the (sort_ts, order_id) tuple), the strictly-older keyset predicate with
 * ${BRAND_PREDICATE} LAST (positional brand binding — isolation invariant), malformed-cursor
 * degradation to the first page, and bigint-minor stringification (I-S07: money is never a float).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return { ...actual, withSilverBrand: vi.fn() };
});

import { withSilverBrand } from './silver-deps.js';
import { getCustomerOrders, getCustomerOrdersPage } from './customer-orders.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const deps = { srPool: {} as never };

function dbRow(orderId: string, sortTs: string, over: Record<string, unknown> = {}) {
  return {
    order_id: orderId,
    lifecycle_state: 'delivered',
    is_terminal: true,
    order_value_minor: '129900',
    currency_code: 'INR',
    first_event_at: '2026-07-01 09:00:00 UTC',
    state_effective_at: sortTs,
    sort_ts: sortTs,
    ...over,
  };
}

/** Seam mock returning `rows` from the single runScoped call; captures SQL + params. */
function mockSeam(rows: Array<Record<string, unknown>>) {
  const sqls: string[] = [];
  const paramsSeen: unknown[][] = [];
  withSilverBrandMock.mockImplementation(async (_p, _b, fn) =>
    (fn as (s: unknown) => unknown)({
      runScoped: async (sql: string, params: unknown[]) => {
        sqls.push(sql);
        paramsSeen.push(params);
        return rows as never[];
      },
    }),
  );
  return { sqls, paramsSeen };
}

beforeEach(() => vi.clearAllMocks());

describe('getCustomerOrders (unpaged — Customer-360 first page, unchanged contract)', () => {
  it('empty brainId → [] without a query', async () => {
    mockSeam([]);
    expect(await getCustomerOrders('brand', '', deps)).toEqual([]);
    expect(withSilverBrandMock).not.toHaveBeenCalled();
  });

  it('clamps limit to 200, binds brain_id first, money stays a bigint minor string', async () => {
    const { sqls, paramsSeen } = mockSeam([dbRow('O1', '2026-07-02 10:00:00 UTC')]);
    const rows = await getCustomerOrders('brand', 'b-1', deps, 9999);
    expect(sqls[0]).toContain('LIMIT 200');
    expect(sqls[0]).toContain('brain_serving.mv_silver_order_state');
    expect(paramsSeen[0]).toEqual(['b-1']);
    expect(rows[0]!.orderValueMinor).toBe('129900');
    expect(rows[0]!.isTerminal).toBe(true);
  });
});

describe('getCustomerOrdersPage (AUD-SL-11 keyset)', () => {
  it('first page: no cursor predicate, look-ahead LIMIT lim+1, nextCursor=null when page not full', async () => {
    const { sqls, paramsSeen } = mockSeam([dbRow('O1', '2026-07-02 10:00:00 UTC')]);
    const page = await getCustomerOrdersPage('brand', 'b-1', deps, { limit: 2 });
    expect(sqls[0]).toContain('LIMIT 3'); // lim+1 look-ahead
    expect(sqls[0]).not.toContain('order_id >'); // no keyset predicate on page 1
    expect(paramsSeen[0]).toEqual(['b-1']);
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('full page + look-ahead row → nextCursor encodes the last RETURNED row (not the probe row)', async () => {
    mockSeam([
      dbRow('O1', '2026-07-03 10:00:00 UTC'),
      dbRow('O2', '2026-07-02 10:00:00 UTC'),
      dbRow('O3', '2026-07-01 10:00:00 UTC'), // the lim+1 probe — must NOT be returned
    ]);
    const page = await getCustomerOrdersPage('brand', 'b-1', deps, { limit: 2 });
    expect(page.rows.map((r) => r.orderId)).toEqual(['O1', 'O2']);
    expect(page.nextCursor).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ t: '2026-07-02 10:00:00 UTC', o: 'O2' });
  });

  it('cursor page: strictly-older keyset predicate with BRAND_PREDICATE bound LAST', async () => {
    const cursor = Buffer.from(JSON.stringify({ t: '2026-07-02 10:00:00 UTC', o: 'O2' }), 'utf8').toString(
      'base64url',
    );
    const { sqls, paramsSeen } = mockSeam([dbRow('O3', '2026-07-01 10:00:00 UTC')]);
    const page = await getCustomerOrdersPage('brand', 'b-1', deps, { limit: 2, cursor });
    // (sort < t OR (sort = t AND order_id > o)) — the tuple-successor slice, order_id ASC tiebreak.
    expect(sqls[0]).toMatch(/< \?\s+OR \(/);
    expect(sqls[0]).toContain('order_id > ?');
    // brain_id first, then the 3 cursor params — the seam appends brand_id LAST (isolation invariant).
    expect(paramsSeen[0]).toEqual(['b-1', '2026-07-02 10:00:00 UTC', '2026-07-02 10:00:00 UTC', 'O2']);
    expect(page.rows.map((r) => r.orderId)).toEqual(['O3']);
    expect(page.nextCursor).toBeNull();
  });

  it('malformed / partial cursors degrade to the first page (honest, never a throw)', async () => {
    for (const bad of ['not-base64url-json', Buffer.from('{"t":""}').toString('base64url'), '']) {
      const { sqls } = mockSeam([dbRow('O1', '2026-07-02 10:00:00 UTC')]);
      const page = await getCustomerOrdersPage('brand', 'b-1', deps, { cursor: bad });
      expect(sqls[0]).not.toContain('order_id > ?');
      expect(page.rows).toHaveLength(1);
      vi.clearAllMocks();
    }
  });

  it('sorts on the second-truncated NULL-safe key (matches the adapter timestamp normalization)', async () => {
    const { sqls } = mockSeam([]);
    await getCustomerOrdersPage('brand', 'b-1', deps);
    expect(sqls[0]).toContain("date_trunc('second', COALESCE(state_effective_at, TIMESTAMP '9999-12-31 23:59:59 UTC'))");
    expect(sqls[0]).toContain('ORDER BY sort_ts DESC, order_id ASC');
  });

  it('empty brainId → empty page without a query', async () => {
    mockSeam([]);
    expect(await getCustomerOrdersPage('brand', '', deps)).toEqual({ rows: [], nextCursor: null });
    expect(withSilverBrandMock).not.toHaveBeenCalled();
  });
});
