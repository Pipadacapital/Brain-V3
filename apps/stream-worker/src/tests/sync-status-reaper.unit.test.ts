/**
 * sync-status-reaper.unit.test.ts — stale-'syncing' self-heal (meta-spend-repull fix, defect #3).
 *
 * Tests resetStaleSyncing (meta-spend-repull/run.ts) with a mocked PG pool: the SQL-builder / rowCount
 * contract + the brand-GUC-BEFORE-UPDATE ordering that keeps it RLS-safe (MT-1). A repull killed by a
 * pod termination or the ingest-scheduler dispatch deadline leaves connector_sync_status wedged at
 * 'syncing'; the periodic reaper calls this to auto-recover it.
 *
 * Pure in-memory mock pool: no DB required (mirrors connector-instance-health.unit.test.ts).
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { resetStaleSyncing } from '../jobs/meta-spend-repull/run.js';

// Brand ids MUST be real UUIDs — buildContextGucSql validates every id with assertUuid before
// inlining it into `SET LOCAL app.current_brand_id = '<uuid>'` (injection guard).
const BRAND_1 = 'bbbb0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONNECTOR_1 = 'cccc0001-cccc-4ccc-8ccc-cccccccccccc';

/** True when `sql` is the txn-local brand-GUC write for `brandId` (SET LOCAL — value inlined). */
function isBrandGucSql(sql: string, brandId: string): boolean {
  return sql.includes('SET LOCAL') && sql.includes('app.current_brand_id') && sql.includes(brandId);
}

type MockQuery = Mock<(sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>>;

function makeMockPool(queryFn?: (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const query: MockQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (queryFn) return queryFn(sql, params);
    return { rowCount: 1, rows: [] };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), _queries: queries, _client: client };
  return pool;
}

describe('resetStaleSyncing', () => {
  it('sets the brand GUC BEFORE the UPDATE, targets only stale syncing rows, and returns the rowCount', async () => {
    const pool = makeMockPool(async (sql) =>
      sql.includes('UPDATE connector_sync_status')
        ? { rowCount: 1, rows: [] }
        : { rowCount: 0, rows: [] },
    );

    const reset = await resetStaleSyncing(
      pool as unknown as import('pg').Pool,
      CONNECTOR_1, BRAND_1, 900_000,
    );

    expect(reset).toBe(1);

    const calls = pool._queries;
    // Ordering: BEGIN → SET LOCAL GUC → UPDATE → COMMIT.
    expect(calls[0]!.sql).toBe('BEGIN');
    const gucIdx = calls.findIndex((c) => isBrandGucSql(c.sql, BRAND_1));
    const updateIdx = calls.findIndex((c) => c.sql.includes('UPDATE connector_sync_status'));
    expect(gucIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(gucIdx); // GUC MUST precede the brand-scoped write (MT-1 / RLS)
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);

    // The UPDATE only touches state='syncing' rows older than the threshold, keyed on both ids.
    const update = calls[updateIdx]!;
    expect(update.sql).toContain("SET state = 'error'");
    expect(update.sql).toContain("state = 'syncing'");
    expect(update.sql).toContain('make_interval(secs =>');
    expect(update.params).toEqual([CONNECTOR_1, BRAND_1, 900_000]);
    expect(pool._client.release).toHaveBeenCalled();
  });

  it('returns 0 when no row was stale (nothing wedged)', async () => {
    const pool = makeMockPool(async (sql) =>
      sql.includes('UPDATE connector_sync_status')
        ? { rowCount: 0, rows: [] }
        : { rowCount: 0, rows: [] },
    );

    const reset = await resetStaleSyncing(
      pool as unknown as import('pg').Pool,
      CONNECTOR_1, BRAND_1, 900_000,
    );

    expect(reset).toBe(0);
    expect(pool._client.release).toHaveBeenCalled();
  });

  it('is fail-soft — a DB error ROLLs BACK, releases the client, and returns 0 (never throws)', async () => {
    const pool = makeMockPool(async (sql) => {
      if (sql.includes('UPDATE connector_sync_status')) throw new Error('simulated DB failure');
      return { rowCount: 0, rows: [] };
    });

    const reset = await resetStaleSyncing(
      pool as unknown as import('pg').Pool,
      CONNECTOR_1, BRAND_1, 900_000,
    );

    expect(reset).toBe(0);
    expect(pool._queries.some((c) => c.sql === 'ROLLBACK')).toBe(true);
    expect(pool._client.release).toHaveBeenCalled();
  });
});
