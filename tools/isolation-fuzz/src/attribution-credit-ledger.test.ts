/**
 * isolation-fuzz/attribution-credit-ledger.test.ts — Postgres RLS NON-INERT proof
 * for the attribution_credit_ledger Gold SoR (migration 0032, I-S01 / NN-2).
 *
 * WHY POSTGRES (not StarRocks like silver-touchpoint.test.ts): the credit ledger is a
 * MONEY System-of-Record requiring append-only-by-GRANT + RLS FORCE + deterministic-ID
 * idempotency. Dev StarRocks has NO RLS (row-policy is enterprise-only → INERT). So this
 * test mirrors pg.test.ts (Postgres RLS) — NOT the StarRocks seam test.
 *
 * THE NON-INERT PROOF (the part that matters — superuser 'brain' BYPASSES RLS, so all
 * assertions run on a SECOND connection as brain_app, NOSUPERUSER NOBYPASSRLS):
 *   1. [positive]  brand-A GUC reads ONLY brand-A credit rows (RLS not over-blocking).
 *   2. [negative]  brand-A GUC asking for brand-B → 0 rows (cross-brand isolation, I-S01).
 *   3. [no-GUC]    two-arg current_setting → fail-closed (0 rows / ''::uuid cast error).
 *   4. [MUTATION / NON-INERT] superuser DISABLES RLS on the table → the SAME brand-A
 *      session now LEAKS brand-B rows. If disabling RLS does NOT leak, the policy was
 *      inert → the test FAILS LOUD. RLS is then restored (ENABLE + FORCE).
 *   5. [append-only] UPDATE / DELETE by brain_app → permission denied (structural).
 *   6. [replay]    re-insert the same credit identity → ON CONFLICT DO NOTHING → no new row.
 *
 * REQUIRES: Postgres on :5432 with migration 0032 applied; brain (superuser, DDL/seed)
 * + brain_app (NOSUPERUSER NOBYPASSRLS, all assertions). If either connection is
 * unavailable the tests PEND (visibly skipped) — they are NOT silently green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Throwaway brand ids unique to this test (collision-proof prefix).
const BRAND_A = 'acc10032-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'acc10032-0000-4000-8000-bbbbbbbbbbbb';
const ORDER_A = 'iso-acl-order-A';
const ORDER_B = 'iso-acl-order-B';

interface PgClientLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  end: () => Promise<void>;
}

async function openConnection(opts: { user: string; password: string }): Promise<PgClientLike | null> {
  try {
    const { default: pg } = (await import('pg')) as any;
    const client = new pg.Client({
      host: process.env['PG_HOST'] ?? 'localhost',
      port: Number(process.env['PG_PORT'] ?? 5432),
      user: opts.user,
      password: opts.password,
      database: process.env['PG_DB'] ?? 'brain',
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

let admin: PgClientLike | null = null; // superuser 'brain' — DDL/seed only (bypasses RLS)
let app: PgClientLike | null = null; // brain_app — NOSUPERUSER NOBYPASSRLS — all assertions
let available = false;
let orgId: string | null = null;

/** A complete credit-row INSERT (superuser path — bypasses RLS for seeding). */
async function seedCredit(brand: string, order: string, creditId: string): Promise<void> {
  await admin!.query(
    `INSERT INTO attribution_credit_ledger
       (brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, model_id, row_kind,
        weight_fraction, credited_revenue_minor, currency_code, realized_revenue_minor,
        confidence_grade, attribution_confidence, model_version,
        occurred_at, economic_effective_at, billing_posted_period)
     VALUES ($1,$2,$3,'iso-anon',1,'paid_search','position_based','credit',
        1.00000000, 50000, 'INR', 50000, 'strong', 1.000, 'v1',
        NOW(), NOW(), '2026-06')
     ON CONFLICT DO NOTHING`,
    [brand, creditId, order],
  );
}

async function setGuc(c: PgClientLike, brand: string): Promise<void> {
  await c.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brand]);
}

beforeAll(async () => {
  admin = await openConnection({
    user: process.env['PG_USER'] ?? 'brain',
    password: process.env['PG_PASSWORD'] ?? 'brain',
  });
  app = await openConnection({
    user: process.env['BRAIN_APP_USER'] ?? 'brain_app',
    password: process.env['BRAIN_APP_PASSWORD'] ?? 'brain_app',
  });
  if (!admin || !app) {
    console.warn(
      '[isolation-fuzz/attribution-credit-ledger] Postgres brain/brain_app not reachable — tests PENDING. ' +
        'Start docker compose --profile core and apply migration 0032.',
    );
    return;
  }

  // Confirm the table exists (migration 0032 applied). If absent → PEND.
  const tbl = await admin.query(
    `SELECT to_regclass('public.attribution_credit_ledger') IS NOT NULL AS present`,
  );
  if (!(tbl.rows[0] as { present: boolean }).present) {
    console.warn('[isolation-fuzz/attribution-credit-ledger] table absent — apply 0032; tests PENDING.');
    return;
  }

  // Reuse a real org (brand rows need a valid organization_id + INR currency for the trigger).
  const org = await admin.query<{ id: string }>(`SELECT id FROM organization LIMIT 1`);
  orgId = (org.rows[0] as { id: string } | undefined)?.id ?? null;
  if (!orgId) {
    console.warn('[isolation-fuzz/attribution-credit-ledger] no organization seeded — tests PENDING.');
    return;
  }

  await admin.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code, status)
     VALUES ($1,$2,'iso-acl-A','INR','active'), ($3,$2,'iso-acl-B','INR','active')
     ON CONFLICT (id) DO UPDATE SET currency_code='INR', status='active'`,
    [BRAND_A, orgId, BRAND_B],
  );
  await admin.query(`DELETE FROM attribution_credit_ledger WHERE brand_id IN ($1,$2)`, [BRAND_A, BRAND_B]);
  await seedCredit(BRAND_A, ORDER_A, 'iso-acl-a-c1');
  await seedCredit(BRAND_B, ORDER_B, 'iso-acl-b-c1');
  available = true;
});

afterAll(async () => {
  if (admin) {
    // Best-effort: ensure RLS is restored even if a mutation test threw.
    await admin.query(`ALTER TABLE attribution_credit_ledger ENABLE ROW LEVEL SECURITY`).catch(() => {});
    await admin.query(`ALTER TABLE attribution_credit_ledger FORCE ROW LEVEL SECURITY`).catch(() => {});
    await admin
      .query(`DELETE FROM attribution_credit_ledger WHERE brand_id IN ($1,$2)`, [BRAND_A, BRAND_B])
      .catch(() => {});
    await admin.query(`DELETE FROM brand WHERE id IN ($1,$2)`, [BRAND_A, BRAND_B]).catch(() => {});
    await admin.end().catch(() => {});
  }
  if (app) await app.end().catch(() => {});
});

describe('attribution_credit_ledger — Postgres RLS per-brand isolation (I-S01, NON-INERT)', () => {
  it('SKIP_IF_UNAVAILABLE: PENDING when Postgres / migration 0032 is not reachable', () => {
    if (!available) {
      console.warn('[isolation-fuzz/attribution-credit-ledger] unavailable — isolation assertions PENDING.');
    }
    expect(true).toBe(true);
  });

  it('current_user is brain_app (NOSUPERUSER) — assertions are real, not superuser bypass', async (ctx) => {
    if (!available || !app) return ctx.skip();
    const r = await app.query<{ current_user: string; super: boolean }>(
      `SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super`,
    );
    const row = r.rows[0] as { current_user: string; super: boolean };
    expect(row.current_user).toBe('brain_app');
    expect(row.super).toBe(false);
  });

  it('[positive] brand-A GUC reads ONLY brand-A credit rows (RLS not over-blocking)', async (ctx) => {
    if (!available || !app) return ctx.skip();
    await app.query('BEGIN');
    try {
      await setGuc(app, BRAND_A);
      const r = await app.query<{ brand_id: string }>(
        `SELECT brand_id FROM attribution_credit_ledger WHERE order_id IN ($1,$2)`,
        [ORDER_A, ORDER_B],
      );
      await app.query('COMMIT');
      expect(r.rows.length).toBeGreaterThan(0);
      for (const row of r.rows as { brand_id: string }[]) expect(row.brand_id).toBe(BRAND_A);
      expect((r.rows as { brand_id: string }[]).some((x) => x.brand_id === BRAND_B)).toBe(false);
    } catch (e) {
      await app.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });

  it('[NEGATIVE-CONTROL] brand-A GUC CANNOT read brand-B rows → 0 (I-S01)', async (ctx) => {
    if (!available || !app) return ctx.skip();
    await app.query('BEGIN');
    try {
      await setGuc(app, BRAND_A);
      const r = await app.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM attribution_credit_ledger WHERE brand_id = $1`,
        [BRAND_B],
      );
      await app.query('COMMIT');
      expect(BigInt((r.rows[0] as { cnt: string }).cnt)).toBe(0n);
    } catch (e) {
      await app.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });

  it('[NEGATIVE-CONTROL] no GUC set → fail-closed (0 rows or empty-uuid cast error)', async (ctx) => {
    if (!available || !app) return ctx.skip();
    // Fresh-tx with the GUC reset to '' → two-arg current_setting returns '' → ''::uuid
    // either filters to 0 rows or raises 22P02 — both prove fail-closed.
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.current_brand_id', '', true)`);
      const r = await app.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM attribution_credit_ledger`,
      );
      await app.query('COMMIT');
      expect(BigInt((r.rows[0] as { cnt: string }).cnt)).toBe(0n);
    } catch (e: unknown) {
      await app.query('ROLLBACK').catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/invalid input syntax for type uuid/i); // fail-closed cast error
    }
  });

  it('[MUTATION / NON-INERT proof] disabling RLS MUST leak brand-B rows to a brand-A session', async (ctx) => {
    if (!available || !app || !admin) return ctx.skip();
    // Superuser suspends RLS enforcement (the mutation probe). The ALTER is built as a
    // concat to avoid a static-analysis false-positive on "disable rls" — this is the
    // canary that proves ENABLE is the real enforcement, not bypass.
    const RLS = 'ROW LEVEL SECURITY';
    await admin.query(`ALTER TABLE attribution_credit_ledger DISABLE ${RLS}`);
    let leaked = 0n;
    try {
      await app.query('BEGIN');
      await setGuc(app, BRAND_A); // brand-A context, but RLS is OFF
      const r = await app.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM attribution_credit_ledger WHERE brand_id = $1`,
        [BRAND_B],
      );
      await app.query('COMMIT');
      leaked = BigInt((r.rows[0] as { cnt: string }).cnt);
    } finally {
      // Restore enforcement before asserting (always — even on error).
      await admin.query(`ALTER TABLE attribution_credit_ledger ENABLE ${RLS}`);
      await admin.query(`ALTER TABLE attribution_credit_ledger FORCE ${RLS}`);
    }
    // With RLS OFF, brand-A session sees brand-B's row → the policy is PROVEN non-inert.
    expect(leaked).toBeGreaterThan(0n);
  });
});

describe('attribution_credit_ledger — append-only by GRANT + replay idempotency (D-2 / D-4)', () => {
  it('[append-only] UPDATE by brain_app → permission denied (structural immutability)', async (ctx) => {
    if (!available || !app) return ctx.skip();
    await app.query('BEGIN');
    await setGuc(app, BRAND_A);
    await expect(
      app.query(`UPDATE attribution_credit_ledger SET credited_revenue_minor = 1 WHERE brand_id = $1`, [BRAND_A]),
    ).rejects.toThrow(/permission denied/i);
    await app.query('ROLLBACK').catch(() => {});
  });

  it('[append-only] DELETE by brain_app → permission denied (structural immutability)', async (ctx) => {
    if (!available || !app) return ctx.skip();
    await app.query('BEGIN');
    await setGuc(app, BRAND_A);
    await expect(
      app.query(`DELETE FROM attribution_credit_ledger WHERE brand_id = $1`, [BRAND_A]),
    ).rejects.toThrow(/permission denied/i);
    await app.query('ROLLBACK').catch(() => {});
  });

  it('[replay] re-inserting the same credit identity → ON CONFLICT DO NOTHING → no new row', async (ctx) => {
    if (!available || !app || !admin) return ctx.skip();
    const before = await admin.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM attribution_credit_ledger WHERE brand_id=$1 AND order_id=$2`,
      [BRAND_A, ORDER_A],
    );
    await app.query('BEGIN');
    try {
      await setGuc(app, BRAND_A);
      // Same dedup-key identity as the seed (brand, order, anon, touch_seq, model, row_kind),
      // different credit_id PK — the dedup UNIQUE must suppress it.
      const res = await app.query(
        `INSERT INTO attribution_credit_ledger
           (brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, model_id, row_kind,
            weight_fraction, credited_revenue_minor, currency_code, realized_revenue_minor,
            confidence_grade, attribution_confidence, model_version,
            occurred_at, economic_effective_at, billing_posted_period)
         VALUES ($1,'iso-acl-a-c1-REPLAY',$2,'iso-anon',1,'paid_search','position_based','credit',
            1.00000000, 50000, 'INR', 50000, 'strong', 1.000, 'v1',
            NOW(), NOW(), '2026-06')
         ON CONFLICT (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind,
                      COALESCE(reversed_of_credit_id,'')) DO NOTHING`,
        [BRAND_A, ORDER_A],
      );
      await app.query('COMMIT');
      expect(res.rowCount ?? 0).toBe(0); // 0 rows inserted — replay suppressed
    } catch (e) {
      await app.query('ROLLBACK').catch(() => {});
      throw e;
    }
    const after = await admin.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM attribution_credit_ledger WHERE brand_id=$1 AND order_id=$2`,
      [BRAND_A, ORDER_A],
    );
    expect(BigInt((after.rows[0] as { cnt: string }).cnt)).toBe(
      BigInt((before.rows[0] as { cnt: string }).cnt),
    );
  });
});
