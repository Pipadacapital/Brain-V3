/**
 * connector-lifecycle.integration.test.ts — B1 slice
 * chore-connector-lifecycle-regression / defects #2 + #3 (D-1/D-7)
 *
 * Pins:
 *   #2 — Reconnect UPSERT no-23505 (PgConnectorInstanceRepository.save() :128)
 *   #3 — Single sync row (PgConnectorSyncStatusRepository.save() :64 + migration 0025 UNIQUE)
 *
 * NOTE on defect #5 (provisional-surfaced reference):
 *   apps/core/src/modules/analytics/tests/revenue-metrics.live.test.ts
 *   sections 2 and 4 (provisional-only → has_data contract) + section 3 (brain_app
 *   negative-control, lines 306-315) ALREADY cover defect #5. Do NOT duplicate here.
 *   That suite is the authoritative coverage for the provisional contract (D-5/plan §5).
 *
 * REVERT-RED:
 *   #2: Revert PgConnectorInstanceRepository.save() UPSERT → plain INSERT →
 *       second save() call throws 23505 → expect(saved2.id).toBe(originalId) goes RED.
 *   #3: Revert PgConnectorSyncStatusRepository.save() UPSERT → plain INSERT (or drop
 *       migration 0025 UNIQUE) → count becomes 2 (or 23505) → count===1 assertion RED.
 *
 * DATA-SAFETY (D-5):
 *   All brands use B-track–unique prefixes (b1b10001/b1b10002). NEVER 60d543dc-*.
 *   Brands seeded in beforeAll via superPool ON CONFLICT DO NOTHING.
 *   afterAll cleans up via superPool in FK order (sync_status → cursor → instance → brand).
 *
 * ISOLATION (D-3):
 *   All isolation assertions use appPool = BRAIN_APP_DATABASE_URL.
 *   assertBrainApp() is called before every isolation query.
 *   superPool used ONLY for seed/teardown.
 *
 * RUN:
 *   cd apps/core && \
 *   BRAIN_APP_DATABASE_URL=postgres://brain_app:brain_app@localhost:5432/brain \
 *   DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
 *   pnpm vitest run src/modules/connector/tests/connector-lifecycle.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { DbPool, QueryContext } from '@brain/db';

import { PgConnectorInstanceRepository } from '../sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import { PgConnectorSyncStatusRepository } from '../sources/storefront/shopify/infrastructure/repositories/PgConnectorSyncStatusRepository.js';
import { ConnectorInstance } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';

// ── Config ─────────────────────────────────────────────────────────────────────

const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

// B-track file-private brand UUIDs — unique prefix b1b10001/b1b10002 (parallel-safe,
// distinct from Track A's c07ec701/c07ec702 and all live brands).
// NEVER 60d543dc-* (D-5).
const B1_BRAND_A = 'b1b10001-0001-4001-8001-000000000001';
const B1_BRAND_B = 'b1b10002-0002-4002-8002-000000000002';
const B1_CI_ID = 'b1b1c001-0003-4003-8003-000000000003';
const FAKE_SECRET_REF =
  `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/${B1_BRAND_A}/test-myshopify-com`;

let superPool: pg.Pool;
let appPool: pg.Pool;

// ── DbPool adapter (mirrors connector-marketplace.live.test.ts:68-84) ──────────

function makeDbPool(pool: pg.Pool): DbPool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async <T = unknown>(ctx: QueryContext, sql: string, params?: unknown[]) => {
          if (ctx.brandId && ctx.brandId !== 'n/a') {
            await client.query(`SET LOCAL app.current_brand_id = '${ctx.brandId}'`);
          }
          if (ctx.workspaceId && ctx.workspaceId !== 'n/a') {
            await client.query(`SET LOCAL app.current_workspace_id = '${ctx.workspaceId}'`);
          }
          if (ctx.userId && ctx.userId !== 'n/a') {
            await client.query(`SET LOCAL app.current_user_id = '${ctx.userId}'`);
          }
          return client.query(sql, params) as unknown as { rows: T[]; rowCount: number | null };
        },
        release: () => client.release(),
      };
    },
  } as unknown as DbPool;
}

// ── brain_app discipline guard (D-3 durable rule) ─────────────────────────────
// Mirrors revenue-metrics.live.test.ts:306-315 and the A0 assertBrainApp helper.
// Inlined here to avoid a cross-package import (plan §5 — copy the 3 UUID constants).
async function assertBrainApp(pool: pg.Pool): Promise<void> {
  const r = await pool.query<{ current_user: string; is_superuser: boolean }>(
    `SELECT current_user,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
  );
  expect(r.rows[0]!.current_user).toBe('brain_app');
  expect(r.rows[0]!.is_superuser).toBe(false);
}

// ── Seed helpers ───────────────────────────────────────────────────────────────

async function seedBrand(brandId: string, currency = 'INR'): Promise<void> {
  const orgRes = await superPool.query<{ id: string }>('SELECT id FROM organization LIMIT 1');
  const orgId = orgRes.rows[0]?.id;
  if (!orgId) throw new Error('[B1 fixture] No organization row found');
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code, region_code)
     VALUES ($1, $2, $3, $4, 'IN')
     ON CONFLICT (id) DO NOTHING`,
    [brandId, orgId, `B1 Test Brand (${brandId.slice(0, 8)})`, currency],
  );
}

async function cleanupB1(): Promise<void> {
  const brandIds = [B1_BRAND_A, B1_BRAND_B];
  const ph = brandIds.map((_, i) => `$${i + 1}`).join(', ');
  await superPool.query(`DELETE FROM connector_sync_status WHERE brand_id IN (${ph})`, brandIds).catch(() => undefined);
  await superPool.query(`DELETE FROM connector_cursor WHERE brand_id IN (${ph})`, brandIds).catch(() => undefined);
  await superPool.query(`DELETE FROM connector_instance WHERE brand_id IN (${ph})`, brandIds).catch(() => undefined);
  await superPool.query(`DELETE FROM brand WHERE id IN (${ph})`, brandIds).catch(() => undefined);
}

// ── ConnectorInstance factory ──────────────────────────────────────────────────

function makeInstance(opts: {
  id?: string;
  brandId: string;
  status?: 'connected' | 'disconnected' | 'error';
  shopDomain?: string;
  secretRef?: string;
}): ConnectorInstance {
  const now = new Date();
  return ConnectorInstance.create({
    id: opts.id ?? randomUUID(),
    brandId: opts.brandId,
    provider: 'shopify',
    shopDomain: opts.shopDomain ?? 'test.myshopify.com',
    secretRef: opts.secretRef ?? FAKE_SECRET_REF,
    status: opts.status ?? 'connected',
    healthState: opts.status === 'disconnected' ? 'Disconnected' : 'Healthy',
    safetyRating: opts.status === 'disconnected' ? 'blocked' : 'safe',
    connectedAt: now,
    disconnectedAt: opts.status === 'disconnected' ? now : null,
    createdAt: now,
    updatedAt: now,
  });
}

function makeSyncStatus(opts: {
  brandId: string;
  connectorInstanceId: string;
  state?: 'connected' | 'syncing' | 'waiting_for_data' | 'error';
  lastError?: string | null;
}): ConnectorSyncStatus {
  return ConnectorSyncStatus.create({
    id: randomUUID(),
    brandId: opts.brandId,
    connectorInstanceId: opts.connectorInstanceId,
    state: opts.state ?? 'waiting_for_data',
    lastSyncAt: null,
    lastError: opts.lastError ?? null,
    updatedAt: new Date(),
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 3 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 3 });

  await superPool.query('SELECT 1');
  await appPool.query('SELECT 1');

  await cleanupB1(); // idempotent pre-clean from any prior failed run
  await seedBrand(B1_BRAND_A);
  await seedBrand(B1_BRAND_B);
});

afterAll(async () => {
  await cleanupB1();
  await superPool.end().catch(() => undefined);
  await appPool.end().catch(() => undefined);
});

// ── Test suite: defect #2 — Reconnect UPSERT no-23505 ─────────────────────────
//
// Code-under-test: PgConnectorInstanceRepository.save() :128
// ON CONFLICT (brand_id, provider) DO UPDATE — the fix ensures a second save() for
// the same (brand_id, provider) REACTIVATES the existing row instead of throwing 23505.
//
// Revert-RED: revert save() to plain INSERT (no ON CONFLICT clause) →
//   second save() throws PG error code 23505 →
//   expect(saved2.id).toBe(originalId) / expect(saved2.status).toBe('connected') go RED.

describe('defect #2 — reconnect UPSERT no-23505 (PgConnectorInstanceRepository.save)', () => {
  // Use the superPool-backed DbPool for these tests.
  // The UPSERT itself does not depend on RLS — we are testing the SQL mechanics.
  // The isolation assertions in defect #3 use appPool with assertBrainApp.
  let superDbPool: DbPool;

  beforeAll(() => {
    superDbPool = makeDbPool(superPool);
  });

  afterAll(async () => {
    // Clean connector_instance rows seeded by this describe block
    await superPool
      .query(`DELETE FROM connector_sync_status WHERE brand_id = $1`, [B1_BRAND_A])
      .catch(() => undefined);
    await superPool
      .query(`DELETE FROM connector_instance WHERE brand_id = $1`, [B1_BRAND_A])
      .catch(() => undefined);
  });

  it('first save() inserts and returns a connected connector_instance (positive control)', async () => {
    const repo = new PgConnectorInstanceRepository(superDbPool);
    const instance = makeInstance({ id: B1_CI_ID, brandId: B1_BRAND_A, status: 'connected' });
    const saved = await repo.save(instance);

    expect(saved.id).toBe(B1_CI_ID);
    expect(saved.brandId).toBe(B1_BRAND_A);
    expect(saved.status).toBe('connected');
    expect(saved.provider).toBe('shopify');
  });

  it('second save() for same (brand_id, provider) returns the SAME row id — no 23505 throw (defect #2 non-inert)', async () => {
    // The first save inserted B1_CI_ID. Now we disconnect then reconnect:
    // pass a NEW UUID but same (brand_id='B1_BRAND_A', provider='shopify').
    // The UPSERT must return the ORIGINAL B1_CI_ID row, reactivated — NOT a new row.
    const repo = new PgConnectorInstanceRepository(superDbPool);

    // Simulate a reconnect: a new ConnectorInstance with a NEW id but same brand+provider
    const reconnectInstance = makeInstance({
      id: randomUUID(), // new UUID — UPSERT must keep the original row id
      brandId: B1_BRAND_A,
      status: 'connected',
      shopDomain: 'test.myshopify.com',
    });

    // REVERT-RED: if save() used plain INSERT (no ON CONFLICT), this would throw
    // PG error 23505 (unique constraint violation on connector_instance_brand_provider_unique).
    // With the UPSERT fix, it must succeed and return the original row.
    const saved2 = await repo.save(reconnectInstance);

    // The RETURNING row must be the ORIGINAL row's id (kept by ON CONFLICT DO UPDATE).
    expect(saved2.id).toBe(B1_CI_ID);
    expect(saved2.status).toBe('connected');
    expect(saved2.brandId).toBe(B1_BRAND_A);
    expect(saved2.provider).toBe('shopify');
  });

  it('the saved row is visible in the DB with status=connected (DB-level confirmation)', async () => {
    const row = await superPool.query<{ id: string; status: string; brand_id: string }>(
      `SELECT id, status, brand_id FROM connector_instance
       WHERE brand_id = $1 AND provider = 'shopify'`,
      [B1_BRAND_A],
    );
    expect(row.rows).toHaveLength(1); // exactly ONE row (UPSERT deduped)
    expect(row.rows[0]!.id).toBe(B1_CI_ID);
    expect(row.rows[0]!.status).toBe('connected');
  });
});

// ── Test suite: defect #3 — Single sync row + stale-error reset ───────────────
//
// Code-under-test: PgConnectorSyncStatusRepository.save() :64 + migration 0025 UNIQUE
// ON CONFLICT (brand_id, connector_instance_id) DO UPDATE — the fix ensures a reconnect
// resets the existing sync_status row (clearing stale 'error') rather than inserting a
// duplicate, which would leave the old 'error' row and show "Error" in the dashboard.
//
// Revert-RED: revert save() to plain INSERT (no ON CONFLICT), or DROP migration 0025
// UNIQUE constraint →  second save() produces count=2 rows (duplicate), or throws 23505
// → count===1 assertion and state!=='error' assertion go RED.

describe('defect #3 — single sync row + stale-error reset (PgConnectorSyncStatusRepository.save)', () => {
  let superDbPool: DbPool;
  let appDbPool: DbPool;
  const syncCiId = 'b1b1c002-0004-4004-8004-000000000004'; // distinct from B1_CI_ID

  beforeAll(async () => {
    superDbPool = makeDbPool(superPool);
    appDbPool = makeDbPool(appPool);

    // Ensure a connector_instance row exists for syncCiId (FK constraint on connector_sync_status)
    await superPool.query(
      `INSERT INTO connector_instance
         (id, brand_id, provider, status, shop_domain, secret_ref)
       VALUES ($1, $2, 'shopify', 'connected', 'test.myshopify.com',
               'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/${B1_BRAND_A}/test2')
       ON CONFLICT (id) DO NOTHING`,
      [syncCiId, B1_BRAND_A],
    );
  });

  afterAll(async () => {
    await superPool
      .query(`DELETE FROM connector_sync_status WHERE brand_id = $1 AND connector_instance_id = $2`, [B1_BRAND_A, syncCiId])
      .catch(() => undefined);
    await superPool
      .query(`DELETE FROM connector_instance WHERE id = $1`, [syncCiId])
      .catch(() => undefined);
  });

  it('first save() inserts a sync_status row in waiting_for_data state (positive control)', async () => {
    const repo = new PgConnectorSyncStatusRepository(superDbPool);
    const status = makeSyncStatus({
      brandId: B1_BRAND_A,
      connectorInstanceId: syncCiId,
      state: 'waiting_for_data',
    });
    const saved = await repo.save(status);

    expect(saved.state).toBe('waiting_for_data');
    expect(saved.brandId).toBe(B1_BRAND_A);
    expect(saved.connectorInstanceId).toBe(syncCiId);
    expect(saved.lastError).toBeNull();
  });

  it('second save() with state=waiting_for_data after a prior error → count===1, state!==error (defect #3 non-inert)', async () => {
    // Simulate a stale 'error' row from a prior failed sync by directly updating
    // the row state via superPool (bypassing the repo to force the stale state).
    await superPool.query(
      `UPDATE connector_sync_status
       SET state = 'error', last_error = 'simulated prior error', updated_at = NOW()
       WHERE brand_id = $1 AND connector_instance_id = $2`,
      [B1_BRAND_A, syncCiId],
    );

    // Verify the stale error is in place before we test the fix
    const beforeRow = await superPool.query<{ state: string; last_error: string | null }>(
      `SELECT state, last_error FROM connector_sync_status
       WHERE brand_id = $1 AND connector_instance_id = $2`,
      [B1_BRAND_A, syncCiId],
    );
    expect(beforeRow.rows[0]!.state).toBe('error'); // confirms the stale state is set

    // Now call save() again (the reconnect path) — should UPSERT the existing row
    const repo = new PgConnectorSyncStatusRepository(superDbPool);
    const reconnectStatus = makeSyncStatus({
      brandId: B1_BRAND_A,
      connectorInstanceId: syncCiId,
      state: 'waiting_for_data',
      lastError: null,
    });

    // REVERT-RED: plain INSERT here would throw 23505 (duplicate on the 0025 UNIQUE constraint)
    // or (without the UNIQUE) insert a second row — either way the count===1 assertion would fail.
    await expect(async () => {
      await repo.save(reconnectStatus);
    }).not.toThrow();

    // Assert exactly ONE row in connector_sync_status for this connector_instance_id
    const countRow = await superPool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM connector_sync_status
       WHERE brand_id = $1 AND connector_instance_id = $2`,
      [B1_BRAND_A, syncCiId],
    );
    expect(Number(countRow.rows[0]!.cnt)).toBe(1); // UPSERT kept exactly one row

    // Assert the stale 'error' state was reset (no more dashboard "Error" for this connector)
    const stateRow = await superPool.query<{ state: string; last_error: string | null }>(
      `SELECT state, last_error FROM connector_sync_status
       WHERE brand_id = $1 AND connector_instance_id = $2`,
      [B1_BRAND_A, syncCiId],
    );
    expect(stateRow.rows[0]!.state).toBe('waiting_for_data');
    expect(stateRow.rows[0]!.state).not.toBe('error'); // non-inert: stale error was cleared
    expect(stateRow.rows[0]!.last_error).toBeNull(); // last_error reset to null
  });

  it('count===1 assertion under brain_app+GUC (D-3 isolation guard)', async () => {
    // D-3: isolation assertion MUST run under brain_app (NOSUPERUSER NOBYPASSRLS).
    await assertBrainApp(appPool);

    // Set GUC and read count under brain_app via a transaction
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_brand_id = '${B1_BRAND_A}'`);
      const r = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM connector_sync_status
         WHERE brand_id = $1 AND connector_instance_id = $2`,
        [B1_BRAND_A, syncCiId],
      );
      await client.query('COMMIT');
      expect(Number(r.rows[0]!.cnt)).toBe(1);
    } finally {
      client.release();
    }
  });
});
