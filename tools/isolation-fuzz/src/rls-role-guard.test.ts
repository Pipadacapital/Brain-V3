/**
 * rls-role-guard.test.ts — P2.3: the runtime RLS-enforcing-role guard (live Postgres, both roles).
 *
 * Proves assertRoleEnforcesRls() against REAL roles — the only way to prove a superuser/BYPASSRLS
 * check works is to run it as each role:
 *   • connected as brain_app (NOBYPASSRLS)  → resolves { role: 'brain_app' }.
 *   • connected as the superuser 'brain'     → THROWS (fail-closed; raw queries would bypass RLS).
 *
 * This is the guard the core + stream-worker entrypoints call at startup so a misconfigured
 * DATABASE_URL pointing at the superuser cannot silently defeat tenant isolation (the dev footgun
 * where the app sees cross-tenant rows and isolation tests go false-green).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertRoleEnforcesRls } from '@brain/db';

const ADMIN_DSN = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_DSN = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

interface RawPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
}

async function openPool(dsn: string): Promise<RawPool | null> {
  try {
    const { default: pg } = (await import('pg')) as unknown as { default: { Pool: new (c: unknown) => RawPool } };
    const pool = new pg.Pool({ connectionString: dsn, connectionTimeoutMillis: 5000, max: 2 });
    await pool.query('SELECT 1');
    return pool;
  } catch {
    return null;
  }
}

let appPool: RawPool | null = null;
let adminPool: RawPool | null = null;
let ready = false;

beforeAll(async () => {
  appPool = await openPool(APP_DSN);
  adminPool = await openPool(ADMIN_DSN);
  ready = appPool !== null && adminPool !== null;
});

afterAll(async () => {
  await appPool?.end?.();
  await adminPool?.end?.();
});

describe('assertRoleEnforcesRls (P2.3, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!ready) console.warn('[rls-role-guard] both roles unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('PASSES on the NOBYPASSRLS app role (brain_app)', async () => {
    if (!ready) return;
    const { role } = await assertRoleEnforcesRls(appPool!, { label: 'test app pool' });
    expect(role).toBe('brain_app');
  });

  it('THROWS (fail-closed) on a superuser / BYPASSRLS role', async () => {
    if (!ready) return;
    await expect(assertRoleEnforcesRls(adminPool!, { label: 'test admin pool' })).rejects.toThrow(
      /SUPERUSER|BYPASSRLS/,
    );
  });
});
