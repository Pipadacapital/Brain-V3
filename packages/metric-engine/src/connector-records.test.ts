/**
 * connector-records.test.ts — the paginated canonical-records reader.
 *
 * Mocks the withSilverBrand seam (no DB) and captures the SQL/params each runScoped call receives, so we
 * lock down: the entity allowlist (fail-closed), newest-first ordering, Trino OFFSET-before-LIMIT paging
 * math, parameterized search across the entity's search columns, and bigint-minor stringification.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return { ...actual, withSilverBrand: vi.fn() };
});

import { withSilverBrand } from './silver-deps.js';
import {
  queryConnectorRecords,
  CONNECTOR_RECORD_ENTITIES,
  CONNECTOR_RECORDS_PAGE_SIZE,
} from './connector-records.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const deps = { srPool: {} as never };

/** Seam mock: 1st runScoped = the COUNT (returns {n}), 2nd = the ROWS page. Captures every SQL + params. */
function mockSeam(countN: number, rows: Array<Record<string, unknown>>) {
  const sqls: string[] = [];
  const paramsSeen: unknown[][] = [];
  let call = 0;
  withSilverBrandMock.mockImplementation(async (_p, _b, fn) =>
    (fn as (s: unknown) => unknown)({
      runScoped: async (sql: string, params: unknown[]) => {
        sqls.push(sql);
        paramsSeen.push(params);
        call += 1;
        return (call === 1 ? [{ n: countN }] : rows) as never[];
      },
    }),
  );
  return { sqls, paramsSeen };
}

beforeEach(() => vi.clearAllMocks());

describe('queryConnectorRecords', () => {
  it('exposes exactly the three allowlisted entities + a 20 page size', () => {
    expect([...CONNECTOR_RECORD_ENTITIES].sort()).toEqual(['ad_spend', 'orders', 'shipments']);
    expect(CONNECTOR_RECORDS_PAGE_SIZE).toBe(20);
  });

  it('throws on an unknown entity (fail-closed — no query issued)', async () => {
    await expect(
      queryConnectorRecords('brand', deps, { entity: 'customers', fromStr: '2026-01-01', toStr: '2026-02-01' }),
    ).rejects.toThrow(/unknown entity/);
  });

  it('orders: newest-first over the order-state view; page 2 → OFFSET 20 LIMIT 20; money stringified', async () => {
    const { sqls } = mockSeam(788, [
      { order_id: 'A1', lifecycle_state: 'placed', order_value_minor: 12300n, currency_code: 'INR', first_event_at: '2026-07-01' },
    ]);

    const r = await queryConnectorRecords('brand', deps, {
      entity: 'orders', fromStr: '2024-06-01', toStr: '2026-07-01', page: 2,
    });

    expect(r.total).toBe(788);
    expect(r.page).toBe(2);
    expect(r.limit).toBe(20);
    const rowsSql = sqls[1]!; // 2nd call = the page query
    expect(rowsSql).toContain('brain_serving.mv_silver_order_state');
    expect(rowsSql).toContain('ORDER BY first_event_at DESC');
    expect(rowsSql).toContain('OFFSET 20 LIMIT 20'); // Trino: OFFSET before LIMIT
    // Every value stringified; money = the bigint minor string (no float).
    expect(r.rows[0]!.order_value_minor).toBe('12300');
    expect(r.rows[0]!.currency_code).toBe('INR');
    // Column metadata declares the money column + its currency sibling for the UI.
    const moneyCol = r.columns.find((c) => c.key === 'order_value_minor');
    expect(moneyCol?.type).toBe('money');
    expect(moneyCol?.currencyKey).toBe('currency_code');
  });

  it('search adds a parameterized LIKE across the entity search columns (one ? each)', async () => {
    const { sqls, paramsSeen } = mockSeam(0, []);

    await queryConnectorRecords('brand', deps, {
      entity: 'shipments', fromStr: '2024-06-01', toStr: '2026-07-01', search: 'SLW123',
    });

    const countSql = sqls[0]!;
    expect(countSql).toMatch(/LOWER\(CAST\(order_id AS VARCHAR\)\) LIKE \?/);
    expect(countSql).toContain('courier'); // one of the shipment search columns
    // shipments search cols = order_id, courier, current_status, pincode → 4 lowercased LIKE params.
    expect(paramsSeen[0]).toEqual(['%slw123%', '%slw123%', '%slw123%', '%slw123%']);
  });

  it('total=0 → skips the rows query entirely (only the count runs)', async () => {
    const { sqls } = mockSeam(0, []);

    const r = await queryConnectorRecords('brand', deps, {
      entity: 'ad_spend', fromStr: '2024-06-01', toStr: '2026-07-01',
    });

    expect(r.rows).toEqual([]);
    expect(r.total).toBe(0);
    expect(sqls).toHaveLength(1); // count only — no wasted page query
  });
});
