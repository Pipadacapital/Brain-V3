/**
 * withBrandTxn unit test — locks in the RLS-enforcement transaction sequence (audit R-01).
 *
 * Callers mock withBrandTxn, so this is the only place the actual BEGIN → SET LOCAL ROLE →
 * set_config → fn → COMMIT ordering is asserted. The SET LOCAL ROLE must precede the GUC and
 * the business call, otherwise a superuser/owner connection bypasses row-level security.
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
    expect(calls[2]).toBe("SELECT set_config('app.current_brand_id', $1, true)");
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
    const gucIdx = calls.findIndex((c) => c.includes('set_config'));
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
});
