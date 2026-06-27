/**
 * workspace-create-rls.live.test.ts — regression guard for the standalone workspace-create RLS fix (0113).
 *
 * The bug: WorkspaceService.create (POST /api/v1/workspaces — creating an ADDITIONAL workspace) inserted
 * into `organization` directly. organization is FORCE ROW LEVEL SECURITY and its isolation policy doubles
 * as the INSERT WITH CHECK (id = app.current_workspace_id). The id is DB-generated, so there is no way to
 * set that GUC before the insert → under the non-superuser brain_app role it fails closed with 42501. The
 * fix routes create() through the SECURITY DEFINER provision_workspace() fn (mirrors provision_workspace_
 * and_brand / 0047).
 *
 * This test MUST run under brain_app (NOBYPASSRLS) — as superuser the RLS check is bypassed and the test
 * would be INERT (green even with the bug). It asserts is_superuser=false before trusting the result.
 *
 * RUN: cd apps/core && BRAIN_APP_DATABASE_URL=postgres://brain_app:brain_app@localhost:5432/brain \
 *   DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
 *   npx vitest run src/modules/workspace-access/tests/workspace-create-rls.live.test.ts
 * Skips cleanly if Postgres is unreachable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, type DbPool } from '@brain/db';
import { WorkspaceService } from '../internal/application/workspace.service.js';

const SUPER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const USER_ID = '40113113-aaaa-4aaa-8aaa-000000000113';

function noopAudit() {
  return { append: vi.fn().mockResolvedValue({ id: 0n, entry_hash: 'noop' }) } as never;
}

describe('workspace-create RLS LIVE (brain_app, 0113)', () => {
  let superPool: pg.Pool | null = null;
  let appPool: DbPool | null = null;
  let appIsRls = false;
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    try {
      superPool = new pg.Pool({ connectionString: SUPER_URL, max: 3, connectionTimeoutMillis: 4000 });
      await superPool.query('SELECT 1');
    } catch {
      superPool = null;
      return;
    }
    // Seed the owner user (superuser — RLS bypass for setup).
    await superPool.query(
      `INSERT INTO app_user (id, email, email_normalized, password_hash)
         VALUES ($1, $2, $3, 'x') ON CONFLICT (id) DO NOTHING`,
      [USER_ID, `${USER_ID}@x.invalid`, `${USER_ID}@x.invalid`],
    );
    appPool = await createPool({ connectionString: APP_URL, maxConnections: 3 });
    // Confirm the app pool is NOT superuser — else the RLS assertion is inert.
    const c = await appPool.connect();
    try {
      const r = await c.query<{ is: boolean }>({ correlationId: 'rls-check' }, 'SELECT current_setting($1)::bool AS is', ['is_superuser']);
      appIsRls = r.rows[0]?.is === false;
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    if (superPool) {
      for (const id of createdOrgIds) {
        await superPool.query('DELETE FROM membership WHERE organization_id=$1', [id]).catch(() => {});
        await superPool.query('DELETE FROM organization WHERE id=$1', [id]).catch(() => {});
      }
      await superPool.query('DELETE FROM app_user WHERE id=$1', [USER_ID]).catch(() => {});
      await superPool.end().catch(() => {});
    }
    await appPool?.end?.().catch(() => {});
  });

  it('creates a workspace under brain_app (RLS) without 42501', async () => {
    if (!superPool || !appPool) { console.warn('[workspace-create-rls] Postgres unavailable — PENDING.'); return; }
    expect(appIsRls).toBe(true); // negative-control: NOBYPASSRLS, else the test is inert

    const svc = new WorkspaceService(appPool, noopAudit());
    const { organization, membership } = await svc.create(
      { name: 'RLS Regression Workspace', ownerUserId: USER_ID },
      randomUUID(),
    );
    createdOrgIds.push(organization.id);

    // Org created with a derived slug + the caller as owner; org-level membership materialized.
    expect(organization.name).toBe('RLS Regression Workspace');
    expect(organization.ownerUserId).toBe(USER_ID);
    expect(organization.slug).toMatch(/^rls-regression-workspace-/);
    expect(membership.roleCode).toBe('owner');
    expect(membership.brandId).toBeNull();

    // Verify the rows actually landed (superuser read — ground truth, bypasses RLS).
    const orgRow = await superPool.query('SELECT onboarding_status FROM organization WHERE id=$1', [organization.id]);
    expect(orgRow.rowCount).toBe(1);
    expect(orgRow.rows[0].onboarding_status).toBe('org_created');
    const memRow = await superPool.query(
      `SELECT 1 FROM membership WHERE organization_id=$1 AND app_user_id=$2 AND brand_id IS NULL AND role_code='owner'`,
      [organization.id, USER_ID],
    );
    expect(memRow.rowCount).toBe(1);
  });
});
