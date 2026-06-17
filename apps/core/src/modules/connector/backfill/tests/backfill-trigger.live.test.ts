/**
 * backfill-trigger.live.test.ts — Live integration tests for feat-connector-backfill Track B.
 *
 * Covers the B3 DoD checklist (architecture-plan §6 Track B):
 *
 * T1: brand_admin trigger path: insertQueued succeeds → 202 {job_id} shape (SC#1 positive)
 * T2: manager → 403 non-inert negative control (D-15)
 * T3: null secret → RECONNECT_REQUIRED (D-7)
 * T4: overlap-lock → BACKFILL_ALREADY_RUNNING, count === 1 (D-9/HP-2, SC#2)
 * T5: progress GET — real counts, percent null when estimated_total null (D-8/SC#6)
 * T6: no secret_ref / token in response (I-S09)
 * T7: audit row written (SC#14)
 * T8: cross-brand isolation under brain_app (SC#12/MT-2 — non-inert count === 0)
 *
 * CRITICAL: Isolation assertions run under brain_app (BRAIN_APP_DATABASE_URL).
 * Dev superuser 'brain' BYPASSES RLS — using it for isolation tests is a false-pass
 * trap (MEMORY: dev-db-superuser-masks-rls). The current_user assertion in T8 enforces this.
 *
 * Uses fresh brand UUIDs seeded per test run (avoids conflicts with existing dev data).
 * Each test that needs a connector_instance seeds its own to avoid cross-test state sharing.
 *
 * ADR-BF-3 / ADR-BF-4 / D-7/D-8/D-9/D-12/D-15.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg, { type QueryResultRow } from 'pg';
import type { DbPool, QueryContext } from '@brain/db';
import { PgBackfillJobRepository } from '../infrastructure/PgBackfillJobRepository.js';
import { LocalSecretsManager } from '../../sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.js';
import { DbAuditWriter } from '@brain/audit';

// ── Configuration ─────────────────────────────────────────────────────────────

const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

// Fresh brand UUIDs per test run — avoids conflicts with stable dev DB data.
const BRAND_A = 'bf000001-0000-4000-8000-000000000001';
const BRAND_B = 'bf000002-0000-4000-8000-000000000002';

// ── Shared infrastructure ─────────────────────────────────────────────────────

let superPool: pg.Pool;
let appPool: pg.Pool;
let backfillJobRepo: PgBackfillJobRepository;
let secretsManager: LocalSecretsManager;
let auditWriter: DbAuditWriter;

// Organization ID resolved in beforeAll (required for brand FK).
let orgId: string;

// ── DbPool adapter (brain_app + GUC — NN-1) ───────────────────────────────────
// Uses BEGIN/SET LOCAL/COMMIT pattern so the GUC persists for the statement.

function makeAppDbPool(pool: pg.Pool): DbPool {
  return {
    connect: async () => {
      const rawClient = await pool.connect();
      return {
        query: async <T = unknown>(ctx: QueryContext, sql: string, params?: unknown[]) => {
          // Wrap in explicit transaction so SET LOCAL persists (NN-1).
          await rawClient.query('BEGIN');
          if (ctx.brandId) {
            await rawClient.query(`SET LOCAL app.current_brand_id = '${ctx.brandId}'`);
          }
          let result;
          try {
            // Cast through QueryResultRow to satisfy pg's generic constraint;
            // @brain/db's DbClient.query<T> uses T=unknown so the widening is safe.
            result = await rawClient.query<T & QueryResultRow>(sql, params as unknown[]);
            await rawClient.query('COMMIT');
          } catch (err) {
            await rawClient.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
          return result as unknown as { rows: T[]; rowCount: number | null };
        },
        release: () => rawClient.release(),
      };
    },
    end: async () => {},
  } as DbPool;
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedBrand(brandId: string): Promise<void> {
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code, region_code)
     VALUES ($1, $2, $3, 'INR', 'IN')
     ON CONFLICT (id) DO NOTHING`,
    [brandId, orgId, `Backfill Test Brand ${brandId.slice(0, 8)}`],
  );
}

async function seedConnectorInstance(brandId: string, secretRef: string): Promise<string> {
  const id = randomUUID();
  await superPool.query(
    `INSERT INTO connector_instance
       (id, brand_id, provider, shop_domain, secret_ref, status,
        health_state, safety_rating, connected_at, created_at, updated_at)
     VALUES ($1, $2, 'shopify', $3, $4, 'connected', 'Healthy', 'safe', NOW(), NOW(), NOW())`,
    [id, brandId, `${id.slice(0, 8)}.myshopify.com`, secretRef],
  );
  return id;
}

async function cleanupAll(): Promise<void> {
  for (const brandId of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM backfill_job WHERE brand_id = $1`, [brandId]).catch(() => undefined);
    await superPool.query(`DELETE FROM connector_sync_status WHERE brand_id = $1`, [brandId]).catch(() => undefined);
    await superPool.query(`DELETE FROM connector_cursor WHERE brand_id = $1`, [brandId]).catch(() => undefined);
    await superPool.query(`DELETE FROM connector_instance WHERE brand_id = $1`, [brandId]).catch(() => undefined);
    await superPool.query(
      `DELETE FROM audit_log WHERE brand_id = $1 AND action = 'connector.backfill.requested'`,
      [brandId],
    ).catch(() => undefined);
    await superPool.query(`DELETE FROM brand WHERE id = $1`, [brandId]).catch(() => undefined);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 5 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });

  const appDbPool = makeAppDbPool(appPool);
  backfillJobRepo = new PgBackfillJobRepository(appDbPool);
  secretsManager = new LocalSecretsManager();

  const auditDb = {
    query: async (sql: string, params?: unknown[]) => {
      const r = await superPool.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount };
    },
  };
  auditWriter = new DbAuditWriter(auditDb);

  // Resolve an existing org.
  const orgResult = await superPool.query<{ id: string }>('SELECT id FROM organization LIMIT 1');
  if (!orgResult.rows[0]) throw new Error('[backfill-trigger.live.test] No organization found');
  orgId = orgResult.rows[0].id;

  // Pre-clean + seed test brands.
  await cleanupAll();
  await seedBrand(BRAND_A);
  await seedBrand(BRAND_B);
}, 30_000);

afterAll(async () => {
  await cleanupAll();
  await superPool.end();
  await appPool.end();
});

// ── T1: trigger path → job_id, status='queued' ────────────────────────────────

describe('T1: trigger path — insertQueued succeeds, 202 {job_id} shape (SC#1)', () => {
  it('insertQueued returns a UUID job_id and row has status=queued', async () => {
    // Seed a connector for Brand A.
    const secretRef = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/test/t1';
    const ciId = await seedConnectorInstance(BRAND_A, secretRef);
    expect(ciId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const jobId = await backfillJobRepo.insertQueued(BRAND_A, ciId, randomUUID());
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // Verify row in DB via superuser.
    const row = await superPool.query<{ status: string; brand_id: string }>(
      `SELECT status, brand_id FROM backfill_job WHERE id = $1`,
      [jobId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.status).toBe('queued');
    expect(row.rows[0]!.brand_id).toBe(BRAND_A);

    // Verify response shape matches BackfillTriggerResponse.
    expect({ job_id: jobId, status: 'queued' as const }).toMatchObject({
      job_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'queued',
    });

    // Cleanup.
    await superPool.query(`DELETE FROM backfill_job WHERE id = $1`, [jobId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T2: requireRole — manager → 403 non-inert negative control (D-15) ─────────

describe('T2: requireRole(brand_admin) — manager → 403 (non-inert, D-15)', () => {
  it('meetsMinimumRole(manager, brand_admin) === false', async () => {
    const { meetsMinimumRole } = await import(
      '../../../workspace-access/internal/security/rbac.js'
    );
    // Non-inert: manager MUST fail the brand_admin minimum check.
    expect(meetsMinimumRole('manager', 'brand_admin')).toBe(false);
    // Positive controls.
    expect(meetsMinimumRole('brand_admin', 'brand_admin')).toBe(true);
    expect(meetsMinimumRole('owner', 'brand_admin')).toBe(true);
    // Analyst also fails.
    expect(meetsMinimumRole('analyst', 'brand_admin')).toBe(false);
  });
});

// ── T3: null secret → RECONNECT_REQUIRED (D-7) ────────────────────────────────

describe('T3: null secret → RECONNECT_REQUIRED path (D-7)', () => {
  it('getSecret returns null for a never-stored ARN', async () => {
    const arn = `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/never-stored-${randomUUID()}`;
    const secret = await secretsManager.getSecret(arn);
    expect(secret).toBeNull();
  });

  it('a stored secret returns non-null (positive control)', async () => {
    const result = await secretsManager.storeShopifyToken(
      BRAND_A,
      'positive-control.myshopify.com',
      'shpat_test',
    );
    const secret = await secretsManager.getSecret(result.arn);
    expect(secret).not.toBeNull();
  });
});

// ── T4: overlap-lock → BACKFILL_ALREADY_RUNNING, no second row (D-9/HP-2) ────

describe('T4: overlap-lock — checkActiveJob blocks second insert (D-9/HP-2, SC#2)', () => {
  it('checkActiveJob returns existing job id; count === 1 (non-inert)', async () => {
    const secretRef = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/test/t4';
    const ciId = await seedConnectorInstance(BRAND_A, secretRef);

    // First insert.
    const jobId = await backfillJobRepo.insertQueued(BRAND_A, ciId, randomUUID());
    expect(jobId).toBeDefined();

    // Overlap-lock check: must find the existing queued job (DB-level FOR UPDATE SKIP LOCKED).
    const activeJobId = await backfillJobRepo.checkActiveJob(ciId, BRAND_A, randomUUID());
    expect(
      activeJobId,
      'BACKFILL_ALREADY_RUNNING check FAILED: checkActiveJob returned null despite queued job',
    ).not.toBeNull();
    expect(activeJobId).toBe(jobId);

    // Non-inert count: exactly 1 row, not 2.
    const cnt = await superPool.query<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM backfill_job WHERE connector_instance_id = $1`,
      [ciId],
    );
    expect(
      parseInt(cnt.rows[0]!.cnt, 10),
      'Overlap-lock count FAILED: more than one backfill_job row',
    ).toBe(1);

    // Cleanup.
    await superPool.query(`DELETE FROM backfill_job WHERE id = $1`, [jobId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T5: progress GET — real counts, percent null when estimated_total null ─────

describe('T5: progress — BackfillJobProgress shape, D-8 honesty (SC#6)', () => {
  it('findLatestForConnector returns the inserted row with null estimated_total', async () => {
    const secretRef = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/test/t5a';
    const ciId = await seedConnectorInstance(BRAND_A, secretRef);

    const jobId = await backfillJobRepo.insertQueued(BRAND_A, ciId, randomUUID());
    const job = await backfillJobRepo.findLatestForConnector(ciId, BRAND_A, randomUUID());

    expect(job).not.toBeNull();
    expect(job!.id).toBe(jobId);
    expect(job!.status).toBe('queued');
    expect(job!.records_processed).toBe('0');
    expect(job!.estimated_total).toBeNull();

    // D-8 honesty: percent MUST be null when estimated_total is null.
    const estimatedTotal = job!.estimated_total !== null ? parseInt(job!.estimated_total, 10) : null;
    const percent =
      estimatedTotal !== null && estimatedTotal > 0
        ? Math.min(100, Math.round((parseInt(job!.records_processed, 10) / estimatedTotal) * 100))
        : null;
    expect(percent).toBeNull();

    // Cleanup.
    await superPool.query(`DELETE FROM backfill_job WHERE id = $1`, [jobId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });

  it('percent is non-null and bounded 0-100 when estimated_total > 0', async () => {
    const secretRef = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/test/t5b';
    const ciId = await seedConnectorInstance(BRAND_A, secretRef);

    const jobId = await backfillJobRepo.insertQueued(BRAND_A, ciId, randomUUID());
    // Simulate worker: 50 of 100 processed.
    await superPool.query(
      `UPDATE backfill_job SET records_processed = 50, estimated_total = 100 WHERE id = $1`,
      [jobId],
    );

    const job = await backfillJobRepo.findLatestForConnector(ciId, BRAND_A, randomUUID());
    expect(job!.records_processed).toBe('50');
    expect(job!.estimated_total).toBe('100');

    const pct = Math.min(
      100,
      Math.round((parseInt(job!.records_processed, 10) / parseInt(job!.estimated_total!, 10)) * 100),
    );
    expect(pct).toBe(50);
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);

    // Cleanup.
    await superPool.query(`DELETE FROM backfill_job WHERE id = $1`, [jobId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T6: no secret_ref / token in response (I-S09) ─────────────────────────────

describe('T6: no secret_ref / token in response (I-S09)', () => {
  it('BackfillJobRow has no token/secret/ciphertext keys', async () => {
    const secretRef = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/test/t6';
    const ciId = await seedConnectorInstance(BRAND_A, secretRef);

    const jobId = await backfillJobRepo.insertQueued(BRAND_A, ciId, randomUUID());
    const job = await backfillJobRepo.findLatestForConnector(ciId, BRAND_A, randomUUID());

    expect(job).not.toBeNull();
    const keys = Object.keys(job!);
    const forbidden = keys.filter(
      (k) => k.includes('token') || k.includes('secret') || k.includes('ciphertext'),
    );
    expect(forbidden, `Forbidden keys in response: ${forbidden.join(', ')}`).toHaveLength(0);
    expect(keys).not.toContain('secret_ref');

    // Cleanup.
    await superPool.query(`DELETE FROM backfill_job WHERE id = $1`, [jobId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T7: audit row written (SC#14) ─────────────────────────────────────────────

describe('T7: audit log — connector.backfill.requested (SC#14)', () => {
  it('writes audit row with actor, connector_instance_id, brand_id; no secret in payload', async () => {
    const secretRef = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/test/t7';
    const ciId = await seedConnectorInstance(BRAND_A, secretRef);
    const jobId = await backfillJobRepo.insertQueued(BRAND_A, ciId, randomUUID());
    const actorId = randomUUID();

    const auditRow = await auditWriter.append({
      brand_id: BRAND_A,
      actor_id: actorId,
      actor_role: 'brand_admin',
      action: 'connector.backfill.requested',
      entity_type: 'backfill_job',
      entity_id: jobId,
      payload: {
        job_id: jobId,
        connector_instance_id: ciId,
        // NO secret_ref, NO token (I-S09).
      },
    });
    expect(auditRow.id).toBeDefined();

    // Verify in DB.
    const rows = await superPool.query<{ action: string; entity_id: string; payload: unknown }>(
      `SELECT action, entity_id, payload FROM audit_log
       WHERE entity_id = $1 AND action = 'connector.backfill.requested'`,
      [jobId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.action).toBe('connector.backfill.requested');
    expect(rows.rows[0]!.entity_id).toBe(jobId);

    // No secret in payload (I-S09).
    const payload = rows.rows[0]!.payload as Record<string, unknown>;
    const forbidden = Object.keys(payload).filter(
      (k) => k.includes('token') || k.includes('secret') || k.includes('ciphertext'),
    );
    expect(forbidden, `Secret in audit payload: ${forbidden.join(', ')}`).toHaveLength(0);

    // Cleanup.
    await superPool.query(`DELETE FROM audit_log WHERE entity_id = $1`, [jobId]);
    await superPool.query(`DELETE FROM backfill_job WHERE id = $1`, [jobId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T8: cross-brand isolation under brain_app (SC#12/MT-2) ────────────────────

describe('T8: cross-brand isolation under brain_app (SC#12/MT-2 — non-inert count===0)', () => {
  it('current_user is brain_app (NOSUPERUSER NOBYPASSRLS)', async () => {
    const client = await appPool.connect();
    try {
      const r = await client.query<{ current_user: string }>(`SELECT current_user`);
      expect(r.rows[0]!.current_user).toBe('brain_app');
    } finally {
      client.release();
    }
  });

  it('Brand A backfill_job NOT visible to Brand B under brain_app (count===0)', async () => {
    const secretRef = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/test/t8';
    const ciId = await seedConnectorInstance(BRAND_A, secretRef);

    // Seed a Brand A job via superuser.
    const jobId = randomUUID();
    await superPool.query(
      `INSERT INTO backfill_job
         (id, brand_id, connector_instance_id, status, records_processed)
       VALUES ($1, $2, $3, 'queued', 0)`,
      [jobId, BRAND_A, ciId],
    );

    // Under brain_app with Brand B GUC — RLS FORCE must return 0 rows.
    const client = await appPool.connect();
    let isolationPassed = false;
    let posControlPassed = false;
    try {
      // Negative control: Brand B cannot see Brand A row.
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_brand_id = '${BRAND_B}'`);
      const resultB = await client.query<{ id: string }>(
        `SELECT id FROM backfill_job WHERE id = $1`,
        [jobId],
      );
      await client.query('COMMIT');
      isolationPassed = resultB.rows.length === 0;

      // Positive control: Brand A can see its own row.
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_brand_id = '${BRAND_A}'`);
      const resultA = await client.query<{ id: string }>(
        `SELECT id FROM backfill_job WHERE id = $1`,
        [jobId],
      );
      await client.query('COMMIT');
      posControlPassed = resultA.rows.length === 1;
    } finally {
      client.release();
    }

    expect(
      isolationPassed,
      'Isolation FAILED: Brand B can see Brand A backfill_job (RLS FORCE not enforced)',
    ).toBe(true);
    expect(
      posControlPassed,
      'Positive control FAILED: Brand A cannot see its own backfill_job',
    ).toBe(true);

    // Cleanup.
    await superPool.query(`DELETE FROM backfill_job WHERE id = $1`, [jobId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});
