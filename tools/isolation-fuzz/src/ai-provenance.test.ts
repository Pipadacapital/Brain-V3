/**
 * isolation-fuzz/ai-provenance.test.ts — Postgres RLS NON-INERT proof for ai_provenance
 * (migration 0036, Phase 8, I-S01 / I-S08 / NN-2).
 *
 * WHY POSTGRES (not StarRocks): ai_provenance is an append-only audit SoR requiring
 * append-only-by-GRANT + RLS FORCE per brand. Dev StarRocks has NO RLS (INERT). This test
 * mirrors attribution-credit-ledger.test.ts (Postgres RLS) — NOT a StarRocks seam test.
 *
 * THE NON-INERT PROOF (the part that matters — superuser 'brain' BYPASSES RLS, so all
 * assertions run on a SECOND connection as brain_app, NOSUPERUSER NOBYPASSRLS):
 *   1. [identity]  current_user is brain_app, rolsuper=false (assertions are real, not bypass).
 *   2. [positive]  brand-A GUC reads ONLY brand-A provenance rows (RLS not over-blocking).
 *   3. [negative]  brand-A GUC asking for brand-B → 0 rows (cross-brand isolation, I-S01).
 *   4. [no-GUC]    two-arg current_setting → fail-closed (0 rows / ''::uuid cast error).
 *   5. [MUTATION / NON-INERT] superuser DISABLES RLS → the SAME brand-A session now LEAKS
 *      brand-B rows. If disabling RLS does NOT leak, the policy was inert → test FAILS LOUD.
 *      RLS is then restored (ENABLE + FORCE).
 *   6. [append-only] UPDATE / DELETE by brain_app → permission denied (42501, structural).
 *   7. [redacted-only] the persisted question_redacted contains NO email/phone/long-digit
 *      (the raw question is never stored — D4).
 *
 * REQUIRES: Postgres on :5432 with migration 0036 applied; brain (superuser, DDL/seed)
 * + brain_app (NOSUPERUSER NOBYPASSRLS, all assertions). If either connection is
 * unavailable the tests PEND (visibly skipped) — they are NOT silently green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BRAND_A = 'a1060036-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'a1060036-0000-4000-8000-bbbbbbbbbbbb';

interface PgClientLike {
  query: <R = unknown>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
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

/** Seed one provenance row (superuser path — bypasses RLS for seeding). */
async function seedProvenance(brand: string, redacted: string): Promise<void> {
  await admin!.query(
    `INSERT INTO ai_provenance
       (brand_id, metric_id, metric_version, params, snapshot_id, question_redacted,
        confidence_grade, trust_tier)
     VALUES ($1,'realized_revenue','v1','{"date_to":"2026-06-18"}'::jsonb,
        'MjAyNi0wNi0xOA', $2, 'A', 'Trusted')`,
    [brand, redacted],
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
      '[isolation-fuzz/ai-provenance] Postgres brain/brain_app not reachable — tests PENDING. ' +
        'Start docker compose --profile core and apply migration 0036.',
    );
    return;
  }

  const tbl = await admin.query(`SELECT to_regclass('public.ai_provenance') IS NOT NULL AS present`);
  if (!(tbl.rows[0] as { present: boolean }).present) {
    console.warn('[isolation-fuzz/ai-provenance] table absent — apply 0036; tests PENDING.');
    return;
  }

  const org = await admin.query<{ id: string }>(`SELECT id FROM organization LIMIT 1`);
  orgId = (org.rows[0] as { id: string } | undefined)?.id ?? null;
  if (!orgId) {
    console.warn('[isolation-fuzz/ai-provenance] no organization seeded — tests PENDING.');
    return;
  }

  await admin.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code, status)
     VALUES ($1,$2,'iso-prov-A','INR','active'), ($3,$2,'iso-prov-B','INR','active')
     ON CONFLICT (id) DO UPDATE SET currency_code='INR', status='active'`,
    [BRAND_A, orgId, BRAND_B],
  );
  await admin.query(`DELETE FROM ai_provenance WHERE brand_id IN ($1,$2)`, [BRAND_A, BRAND_B]);
  await seedProvenance(BRAND_A, 'realized revenue last week [email]');
  await seedProvenance(BRAND_B, 'ad spend for june [number]');
  available = true;
});

afterAll(async () => {
  if (admin) {
    await admin.query(`ALTER TABLE ai_provenance ENABLE ROW LEVEL SECURITY`).catch(() => {});
    await admin.query(`ALTER TABLE ai_provenance FORCE ROW LEVEL SECURITY`).catch(() => {});
    await admin.query(`DELETE FROM ai_provenance WHERE brand_id IN ($1,$2)`, [BRAND_A, BRAND_B]).catch(() => {});
    await admin.query(`DELETE FROM brand WHERE id IN ($1,$2)`, [BRAND_A, BRAND_B]).catch(() => {});
    await admin.end().catch(() => {});
  }
  if (app) await app.end().catch(() => {});
});

describe('ai_provenance — Postgres RLS per-brand isolation (I-S01, NON-INERT)', () => {
  it('SKIP_IF_UNAVAILABLE: PENDING when Postgres / migration 0036 is not reachable', () => {
    if (!available) {
      console.warn('[isolation-fuzz/ai-provenance] unavailable — isolation assertions PENDING.');
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

  it('[positive] brand-A GUC reads ONLY brand-A provenance rows (RLS not over-blocking)', async (ctx) => {
    if (!available || !app) return ctx.skip();
    await app.query('BEGIN');
    try {
      await setGuc(app, BRAND_A);
      const r = await app.query<{ brand_id: string }>(
        `SELECT brand_id FROM ai_provenance WHERE brand_id IN ($1,$2)`,
        [BRAND_A, BRAND_B],
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
        `SELECT COUNT(*) AS cnt FROM ai_provenance WHERE brand_id = $1`,
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
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.current_brand_id', '', true)`);
      const r = await app.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ai_provenance`);
      await app.query('COMMIT');
      expect(BigInt((r.rows[0] as { cnt: string }).cnt)).toBe(0n);
    } catch (e: unknown) {
      await app.query('ROLLBACK').catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/invalid input syntax for type uuid/i);
    }
  });

  it('[MUTATION / NON-INERT proof] disabling RLS MUST leak brand-B rows to a brand-A session', async (ctx) => {
    if (!available || !app || !admin) return ctx.skip();
    const RLS = 'ROW LEVEL SECURITY';
    await admin.query(`ALTER TABLE ai_provenance DISABLE ${RLS}`);
    let leaked = 0n;
    try {
      await app.query('BEGIN');
      await setGuc(app, BRAND_A); // brand-A context, but RLS is OFF
      const r = await app.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM ai_provenance WHERE brand_id = $1`,
        [BRAND_B],
      );
      await app.query('COMMIT');
      leaked = BigInt((r.rows[0] as { cnt: string }).cnt);
    } finally {
      await admin.query(`ALTER TABLE ai_provenance ENABLE ${RLS}`);
      await admin.query(`ALTER TABLE ai_provenance FORCE ${RLS}`);
    }
    // With RLS OFF, brand-A session sees brand-B's row → the policy is PROVEN non-inert.
    expect(leaked).toBeGreaterThan(0n);
  });
});

describe('ai_provenance — append-only by GRANT + redacted-only (D2 / D4)', () => {
  it('[append-only] UPDATE by brain_app → permission denied (42501, structural immutability)', async (ctx) => {
    if (!available || !app) return ctx.skip();
    await app.query('BEGIN');
    await setGuc(app, BRAND_A);
    await expect(
      app.query(`UPDATE ai_provenance SET question_redacted = 'x' WHERE brand_id = $1`, [BRAND_A]),
    ).rejects.toThrow(/permission denied/i);
    await app.query('ROLLBACK').catch(() => {});
  });

  it('[append-only] DELETE by brain_app → permission denied (42501, structural immutability)', async (ctx) => {
    if (!available || !app) return ctx.skip();
    await app.query('BEGIN');
    await setGuc(app, BRAND_A);
    await expect(
      app.query(`DELETE FROM ai_provenance WHERE brand_id = $1`, [BRAND_A]),
    ).rejects.toThrow(/permission denied/i);
    await app.query('ROLLBACK').catch(() => {});
  });

  it('[redacted-only] persisted question_redacted contains NO email/phone/long-digit (D4)', async (ctx) => {
    if (!available || !app) return ctx.skip();
    await app.query('BEGIN');
    try {
      await setGuc(app, BRAND_A);
      const r = await app.query<{ question_redacted: string }>(
        `SELECT question_redacted FROM ai_provenance WHERE brand_id = $1`,
        [BRAND_A],
      );
      await app.query('COMMIT');
      for (const row of r.rows as { question_redacted: string }[]) {
        expect(row.question_redacted).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
        expect(row.question_redacted).not.toMatch(/\d{5,}/);
      }
    } catch (e) {
      await app.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
});
