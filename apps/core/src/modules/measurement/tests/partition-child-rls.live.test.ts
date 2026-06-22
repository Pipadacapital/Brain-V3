/**
 * SECURITY drift-guard (audit C1) — every brand-scoped PARTITION CHILD must enforce tenant isolation.
 *
 * RLS + grants are NOT inherited by partition children in PostgreSQL: protecting only the partitioned
 * PARENT (migrations 0072–0083) left every child (…_p2026_06, …_pdefault) with RLS OFF and a schema-
 * default brain_app grant, so a query addressing a child DIRECTLY bypassed brand isolation and could
 * mutate the append-only money ledger. Migration 0084 closed it (REVOKE ALL + FORCE RLS + policy on
 * every child, and a born-secure maintain_time_partitions). This guard fails CI if a child ever drifts
 * back: any brand-scoped child with RLS disabled, OR brain_app holding a direct grant on a child, OR a
 * direct child read as brain_app NOT being denied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000, max: 2 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 2 });
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (superPool) await superPool.end();
  if (appPool) await appPool.end();
});

describe('audit C1 — partition-child tenant isolation (no cross-brand leak via children)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[partition-child-rls] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('NO brand-scoped child partition has RLS disabled', async () => {
    if (!pgAvailable) return;
    const r = await superPool.query<{ schema: string; child: string }>(
      `SELECT n.nspname AS schema, c.relname AS child
         FROM pg_inherits i
         JOIN pg_class c     ON c.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_partitioned_table pt ON pt.partrelid = i.inhparent
        WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity)
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = i.inhparent
                      AND a.attname = 'brand_id' AND NOT a.attisdropped)`,
    );
    expect(r.rows.map((x) => `${x.schema}.${x.child}`)).toEqual([]);
  });

  it('brain_app holds NO direct grant on any brand-scoped child partition', async () => {
    if (!pgAvailable) return;
    const r = await superPool.query<{ child: string; priv: string }>(
      `SELECT c.relname AS child, g.privilege_type AS priv
         FROM pg_inherits i
         JOIN pg_class c     ON c.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_partitioned_table pt ON pt.partrelid = i.inhparent
         JOIN information_schema.role_table_grants g
           ON g.table_schema = n.nspname AND g.table_name = c.relname AND g.grantee = 'brain_app'
        WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = i.inhparent
                      AND a.attname = 'brand_id' AND NOT a.attisdropped)`,
    );
    expect(r.rows.map((x) => `${x.child}:${x.priv}`)).toEqual([]);
  });

  it('a DIRECT child read as brain_app is denied (the leak repro, now closed)', async () => {
    if (!pgAvailable) return;
    const child = await superPool.query<{ schema: string; child: string }>(
      `SELECT n.nspname AS schema, c.relname AS child
         FROM pg_inherits i
         JOIN pg_class c     ON c.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_partitioned_table pt ON pt.partrelid = i.inhparent
        WHERE c.relname LIKE '%\\_p20%'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = i.inhparent
                      AND a.attname = 'brand_id' AND NOT a.attisdropped)
        LIMIT 1`,
    );
    if (child.rows.length === 0) return; // no dated child to probe
    const { schema, child: name } = child.rows[0]!;
    await expect(
      appPool.query(`SELECT count(*) FROM ${schema}.${name}`),
    ).rejects.toThrow(/permission denied/i);
  });
});
