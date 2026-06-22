/**
 * sync-trigger.live.test.ts — Live integration tests for feat-connector-sync-now Track A.
 *
 * Covers:
 *   T1: RequestConnectorSyncCommand success → enqueues sentinel connector_cursor row,
 *       writes audit connector.sync.requested, 'syncing' result. (positive)
 *   T2: requireRole(brand_admin) — manager / analyst → false (non-inert negative control).
 *   T3: null secret → RECONNECT_REQUIRED.
 *   T4: in-flight (state='syncing') → SYNC_ALREADY_RUNNING (no duplicate enqueue).
 *   T5: pending request already queued → SYNC_ALREADY_REQUESTED (spam-safe dedup), count===1.
 *   T6: audit payload has NO secret_ref / token (I-S09).
 *   T7: cross-brand isolation under brain_app — Brand B cannot trigger / see Brand A's
 *       connector or sentinel row (non-inert: current_user asserted brain_app first).
 *
 * CRITICAL: isolation assertions run under brain_app (BRAIN_APP_DATABASE_URL). Dev superuser
 * 'brain' BYPASSES RLS — using it for isolation is a false-pass trap (dev-db-superuser-masks-rls).
 * T7 asserts current_user='brain_app' (is_superuser=false) BEFORE the isolation check.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg, { type QueryResultRow } from 'pg';
import type { DbPool, QueryContext } from '@brain/db';
import { DbAuditWriter } from '@brain/audit';
import {
  PgSyncRequestRepository,
  SYNC_REQUEST_RESOURCE,
} from '../infrastructure/PgSyncRequestRepository.js';
import { RequestConnectorSyncCommand } from '../application/commands/RequestConnectorSyncCommand.js';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import { PgConnectorInstanceRepository } from '../../sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import { meetsMinimumRole } from '../../../workspace-access/internal/security/rbac.js';

const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'fc000001-0000-4000-8000-000000000001';
const BRAND_B = 'fc000002-0000-4000-8000-000000000002';

let superPool: pg.Pool;
let appPool: pg.Pool;
let syncRequestRepo: PgSyncRequestRepository;
let connectorRepo: IConnectorInstanceRepository;
let auditWriter: DbAuditWriter;
let orgId: string;

// ── DbPool adapter (brain_app + GUC — NN-1) ───────────────────────────────────
function makeAppDbPool(pool: pg.Pool): DbPool {
  return {
    connect: async () => {
      const rawClient = await pool.connect();
      return {
        query: async <T = unknown>(ctx: QueryContext, sql: string, params?: unknown[]) => {
          await rawClient.query('BEGIN');
          if (ctx.brandId) {
            await rawClient.query(`SET LOCAL app.current_brand_id = '${ctx.brandId}'`);
          }
          let result;
          try {
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

// A secrets manager stub: returns a non-null secret for any ref, null for refs
// containing 'never-stored' (drives the RECONNECT_REQUIRED path deterministically).
const secretsStub: ISecretsManager = {
  getSecret: async (ref: string) =>
    ref.includes('never-stored') ? null : { access_token: 'shpat_test' },
} as unknown as ISecretsManager;

async function seedBrand(brandId: string): Promise<void> {
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code, region_code)
     VALUES ($1, $2, $3, 'INR', 'IN')
     ON CONFLICT (id) DO NOTHING`,
    [brandId, orgId, `SyncNow Test ${brandId.slice(0, 8)}`],
  );
}

async function seedConnector(brandId: string, secretRef: string): Promise<string> {
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

async function seedSyncStatus(brandId: string, ciId: string, state: string): Promise<void> {
  await superPool.query(
    `INSERT INTO connector_sync_status
       (id, brand_id, connector_instance_id, state, last_sync_at, last_error, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, NULL, NULL, NOW())
     ON CONFLICT (brand_id, connector_instance_id)
     DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [brandId, ciId, state],
  );
}

async function cleanupAll(): Promise<void> {
  for (const brandId of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM connector_sync_status WHERE brand_id = $1`, [brandId]).catch(() => undefined);
    await superPool.query(`DELETE FROM connector_cursor WHERE brand_id = $1`, [brandId]).catch(() => undefined);
    await superPool.query(`DELETE FROM connector_instance WHERE brand_id = $1`, [brandId]).catch(() => undefined);
    await superPool.query(
      `DELETE FROM audit_log WHERE brand_id = $1 AND action = 'connector.sync.requested'`,
      [brandId],
    ).catch(() => undefined);
    await superPool.query(`DELETE FROM brand WHERE id = $1`, [brandId]).catch(() => undefined);
  }
}

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 5 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });

  const appDbPool = makeAppDbPool(appPool);
  syncRequestRepo = new PgSyncRequestRepository(appDbPool);
  connectorRepo = new PgConnectorInstanceRepository(appDbPool);

  const auditDb = {
    query: async (sql: string, params?: unknown[]) => {
      const r = await superPool.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount };
    },
  };
  auditWriter = new DbAuditWriter(auditDb);

  const orgResult = await superPool.query<{ id: string }>('SELECT id FROM organization LIMIT 1');
  if (!orgResult.rows[0]) throw new Error('[sync-trigger.live.test] No organization found');
  orgId = orgResult.rows[0].id;

  await cleanupAll();
  await seedBrand(BRAND_A);
  await seedBrand(BRAND_B);
}, 30_000);

afterAll(async () => {
  await cleanupAll();
  await superPool.end();
  await appPool.end();
});

function makeCommand(): RequestConnectorSyncCommand {
  return new RequestConnectorSyncCommand(connectorRepo, secretsStub, syncRequestRepo, auditWriter);
}

// ── T1: success path — enqueue sentinel + audit + syncing ─────────────────────
describe('T1: success — enqueues sentinel connector_cursor row + audit', () => {
  it('returns ok/syncing, writes one sentinel row + one audit row', async () => {
    const ciId = await seedConnector(BRAND_A, 'arn:test:t1');
    const cmd = makeCommand();
    const actorId = randomUUID();

    const result = await cmd.execute({
      connectorInstanceId: ciId,
      brandId: BRAND_A,
      correlationId: randomUUID(),
      actorId,
      actorRole: 'brand_admin',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('syncing');
      expect(result.connectorInstanceId).toBe(ciId);
    }

    const sentinel = await superPool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM connector_cursor
        WHERE connector_instance_id = $1 AND resource = $2`,
      [ciId, SYNC_REQUEST_RESOURCE],
    );
    expect(parseInt(sentinel.rows[0]!.cnt, 10)).toBe(1);

    const audit = await superPool.query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE entity_id = $1 AND action = 'connector.sync.requested'`,
      [ciId],
    );
    expect(audit.rows).toHaveLength(1);

    await superPool.query(`DELETE FROM audit_log WHERE entity_id = $1`, [ciId]);
    await superPool.query(`DELETE FROM connector_cursor WHERE connector_instance_id = $1`, [ciId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T2: requireRole(manager) for SYNC — non-inert negative control ────────────
// Sync = Owner/Brand-Admin/Manager (spec); only Analyst is rejected. (Backfill stays
// brand_admin+ via its own per-route guard — see main.ts.)
describe('T2: requireRole(manager) for sync — analyst → false, manager+ → true', () => {
  it('meetsMinimumRole accepts owner/brand_admin/manager for sync(manager); rejects analyst', () => {
    expect(meetsMinimumRole('manager', 'manager')).toBe(true);
    expect(meetsMinimumRole('analyst', 'manager')).toBe(false);
    expect(meetsMinimumRole('brand_admin', 'manager')).toBe(true);
    expect(meetsMinimumRole('owner', 'manager')).toBe(true);
    // backfill remains stricter — manager is rejected at brand_admin:
    expect(meetsMinimumRole('manager', 'brand_admin')).toBe(false);
  });
});

// ── T3: null secret → RECONNECT_REQUIRED ──────────────────────────────────────
describe('T3: null secret → RECONNECT_REQUIRED', () => {
  it('returns RECONNECT_REQUIRED, enqueues NOTHING', async () => {
    const ciId = await seedConnector(BRAND_A, 'arn:never-stored:t3');
    const cmd = makeCommand();

    const result = await cmd.execute({
      connectorInstanceId: ciId,
      brandId: BRAND_A,
      correlationId: randomUUID(),
      actorId: randomUUID(),
      actorRole: 'brand_admin',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('RECONNECT_REQUIRED');

    const sentinel = await superPool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM connector_cursor
        WHERE connector_instance_id = $1 AND resource = $2`,
      [ciId, SYNC_REQUEST_RESOURCE],
    );
    expect(parseInt(sentinel.rows[0]!.cnt, 10)).toBe(0);

    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T4: in-flight → SYNC_ALREADY_RUNNING (overlap-lock surfaced) ──────────────
describe('T4: state=syncing → SYNC_ALREADY_RUNNING (no duplicate run)', () => {
  it('returns SYNC_ALREADY_RUNNING, enqueues NOTHING', async () => {
    const ciId = await seedConnector(BRAND_A, 'arn:test:t4');
    await seedSyncStatus(BRAND_A, ciId, 'syncing');
    const cmd = makeCommand();

    const result = await cmd.execute({
      connectorInstanceId: ciId,
      brandId: BRAND_A,
      correlationId: randomUUID(),
      actorId: randomUUID(),
      actorRole: 'brand_admin',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SYNC_ALREADY_RUNNING');

    const sentinel = await superPool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM connector_cursor
        WHERE connector_instance_id = $1 AND resource = $2`,
      [ciId, SYNC_REQUEST_RESOURCE],
    );
    expect(parseInt(sentinel.rows[0]!.cnt, 10)).toBe(0);

    await superPool.query(`DELETE FROM connector_sync_status WHERE connector_instance_id = $1`, [ciId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T5: second trigger → SYNC_ALREADY_REQUESTED, exactly ONE sentinel ─────────
describe('T5: pending request → SYNC_ALREADY_REQUESTED (spam-safe, count===1)', () => {
  it('second execute is rejected; exactly one sentinel row exists', async () => {
    const ciId = await seedConnector(BRAND_A, 'arn:test:t5');
    const cmd = makeCommand();

    const first = await cmd.execute({
      connectorInstanceId: ciId,
      brandId: BRAND_A,
      correlationId: randomUUID(),
      actorId: randomUUID(),
      actorRole: 'brand_admin',
    });
    expect(first.ok).toBe(true);

    const second = await cmd.execute({
      connectorInstanceId: ciId,
      brandId: BRAND_A,
      correlationId: randomUUID(),
      actorId: randomUUID(),
      actorRole: 'brand_admin',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('SYNC_ALREADY_REQUESTED');

    const sentinel = await superPool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM connector_cursor
        WHERE connector_instance_id = $1 AND resource = $2`,
      [ciId, SYNC_REQUEST_RESOURCE],
    );
    expect(
      parseInt(sentinel.rows[0]!.cnt, 10),
      'spam-safe dedup FAILED: more than one sentinel sync-request row',
    ).toBe(1);

    await superPool.query(`DELETE FROM audit_log WHERE entity_id = $1`, [ciId]);
    await superPool.query(`DELETE FROM connector_cursor WHERE connector_instance_id = $1`, [ciId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T6: no secret_ref / token in audit payload (I-S09) ────────────────────────
describe('T6: audit payload has no token/secret (I-S09)', () => {
  it('audit payload keys contain no token/secret/ciphertext/secret_ref', async () => {
    const ciId = await seedConnector(BRAND_A, 'arn:test:t6');
    const cmd = makeCommand();
    await cmd.execute({
      connectorInstanceId: ciId,
      brandId: BRAND_A,
      correlationId: randomUUID(),
      actorId: randomUUID(),
      actorRole: 'brand_admin',
    });

    const audit = await superPool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_log
        WHERE entity_id = $1 AND action = 'connector.sync.requested'`,
      [ciId],
    );
    expect(audit.rows).toHaveLength(1);
    const keys = Object.keys(audit.rows[0]!.payload);
    const forbidden = keys.filter(
      (k) => k.includes('token') || k.includes('secret') || k.includes('ciphertext'),
    );
    expect(forbidden, `Secret in audit payload: ${forbidden.join(', ')}`).toHaveLength(0);

    await superPool.query(`DELETE FROM audit_log WHERE entity_id = $1`, [ciId]);
    await superPool.query(`DELETE FROM connector_cursor WHERE connector_instance_id = $1`, [ciId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});

// ── T7: cross-brand isolation under brain_app (non-inert) ─────────────────────
describe('T7: cross-brand isolation under brain_app', () => {
  it('current_user is brain_app (NOSUPERUSER NOBYPASSRLS)', async () => {
    const client = await appPool.connect();
    try {
      const r = await client.query<{ current_user: string; is_super: boolean }>(
        `SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super`,
      );
      expect(r.rows[0]!.current_user).toBe('brain_app');
      expect(r.rows[0]!.is_super).toBe(false);
    } finally {
      client.release();
    }
  });

  it('Brand B cannot trigger sync for / see Brand A connector (CONNECTOR_NOT_FOUND, sentinel invisible)', async () => {
    const ciId = await seedConnector(BRAND_A, 'arn:test:t7');
    // Seed a Brand A sentinel directly.
    await superPool.query(
      `INSERT INTO connector_cursor (brand_id, connector_instance_id, resource, cursor_value, updated_at)
       VALUES ($1, $2, $3, NOW()::text, NOW())`,
      [BRAND_A, ciId, SYNC_REQUEST_RESOURCE],
    );

    // Brand B triggers sync for Brand A's connector → must NOT find it (RLS FORCE).
    const cmd = makeCommand();
    const result = await cmd.execute({
      connectorInstanceId: ciId,
      brandId: BRAND_B,
      correlationId: randomUUID(),
      actorId: randomUUID(),
      actorRole: 'brand_admin',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.code,
        'Isolation FAILED: Brand B reached Brand A connector (RLS not enforced)',
      ).toBe('CONNECTOR_NOT_FOUND');
    }

    // Brand B cannot read the Brand A sentinel under brain_app GUC (count===0).
    const pendingForB = await syncRequestRepo.checkPendingRequest(ciId, BRAND_B, randomUUID());
    expect(pendingForB, 'Isolation FAILED: Brand B saw Brand A sentinel row').toBeNull();

    // Positive control: Brand A DOES see its own sentinel.
    const pendingForA = await syncRequestRepo.checkPendingRequest(ciId, BRAND_A, randomUUID());
    expect(pendingForA).not.toBeNull();

    await superPool.query(`DELETE FROM connector_cursor WHERE connector_instance_id = $1`, [ciId]);
    await superPool.query(`DELETE FROM connector_instance WHERE id = $1`, [ciId]);
  });
});
