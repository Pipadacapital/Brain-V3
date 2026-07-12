/**
 * withBrandTxn unit test — locks in the RLS-enforcement transaction sequence (audit R-01).
 *
 * Callers mock withBrandTxn, so this is the only place the actual BEGIN → SET LOCAL ROLE →
 * SET LOCAL app.current_brand_id → fn → COMMIT ordering is asserted. The SET LOCAL ROLE must
 * precede the GUC and the business call, otherwise a superuser/owner connection bypasses
 * row-level security. The brand GUC is a UUID-validated literal (not parameterized set_config) so
 * the RLS cast never sees the empty string — see the 22P02 fail-closed cases below.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { withBrandTxn } from './deps.js';

const BRAND = '11111111-1111-4111-8111-111111111111';

/** A recording pg client + pool whose query() logs every SQL string it receives. */
function recordingPool() {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, client, calls };
}

describe('withBrandTxn — RLS transaction (audit R-01 hardening)', () => {
  it('runs BEGIN → SET LOCAL ROLE brain_app → set_config → fn → COMMIT in order', async () => {
    const { pool, client, calls } = recordingPool();
    let sawClientInFn: PoolClient | null = null;

    await withBrandTxn(pool, BRAND, async (c) => {
      sawClientInFn = c;
      await c.query('SELECT 1 AS probe');
      return 'ok';
    });

    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toBe('SET LOCAL ROLE brain_app');
    expect(calls[2]).toBe(`SET LOCAL app.current_brand_id = '${BRAND}'`);
    expect(calls[3]).toBe('SELECT 1 AS probe');
    expect(calls[4]).toBe('COMMIT');
    expect(sawClientInFn).toBe(client);
  });

  it('drops to the app role BEFORE the GUC and the business query (closes superuser bypass)', async () => {
    const { pool, calls } = recordingPool();
    await withBrandTxn(pool, BRAND, async (c) => {
      await c.query('SELECT 1');
    });
    const roleIdx = calls.indexOf('SET LOCAL ROLE brain_app');
    const gucIdx = calls.findIndex((c) => c.includes('app.current_brand_id'));
    const queryIdx = calls.indexOf('SELECT 1');
    expect(roleIdx).toBeGreaterThanOrEqual(0);
    expect(roleIdx).toBeLessThan(gucIdx);
    expect(roleIdx).toBeLessThan(queryIdx);
  });

  it('honours a custom appRole', async () => {
    const { pool, calls } = recordingPool();
    await withBrandTxn(pool, BRAND, async () => undefined, 'brain_readonly');
    expect(calls).toContain('SET LOCAL ROLE brain_readonly');
  });

  it('ROLLBACKs and rethrows when fn throws', async () => {
    const { pool, calls } = recordingPool();
    await expect(
      withBrandTxn(pool, BRAND, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('rejects an invalid appRole without acquiring a connection', async () => {
    const { pool } = recordingPool();
    await expect(
      withBrandTxn(pool, BRAND, async () => undefined, 'brain_app; DROP TABLE brand'),
    ).rejects.toThrow('not a valid SQL identifier');
    expect((pool.connect as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('writes NIL_UUID (not "") for an empty brandId — fail-closed, no 22P02', async () => {
    // Regression: an empty GUC value would make the brand RLS cast `''::uuid` raise 22P02 and 500
    // the endpoint. Empty → the all-zero uuid keeps the cast valid and matches zero rows.
    const { pool, calls } = recordingPool();
    await withBrandTxn(pool, '', async (c) => {
      await c.query('SELECT 1');
    });
    expect(calls).toContain(`SET LOCAL app.current_brand_id = '00000000-0000-0000-0000-000000000000'`);
    expect(calls.some((c) => c === `SET LOCAL app.current_brand_id = ''`)).toBe(false);
  });

  it('rejects a brandId with SQL-literal breakout characters (injection guard)', async () => {
    const { pool } = recordingPool();
    await expect(
      withBrandTxn(pool, "11111111-1111-4111-8111-111111111111'; DROP TABLE brand--", async () => undefined),
    ).rejects.toThrow('injection-safe bare token');
    expect((pool.connect as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('allows a non-UUID bare-token brandId (unit-test fixtures like "brand-a", DB mocked)', async () => {
    // The DQ/summary unit tests pass readable non-UUID brand ids with a mocked pool; a bare token
    // is injection-safe, so it is interpolated verbatim rather than rejected.
    const { pool, calls } = recordingPool();
    await withBrandTxn(pool, 'brand-a', async (c) => {
      await c.query('SELECT 1');
    });
    expect(calls).toContain(`SET LOCAL app.current_brand_id = 'brand-a'`);
  });
});
