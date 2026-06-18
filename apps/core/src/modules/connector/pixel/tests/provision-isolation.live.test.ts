/**
 * provision-isolation.live.test.ts — feat-onboarding-website Track A isolation proofs.
 *
 * Proves the auto-provision seam + install_token→brand_id derivation are correct and
 * tenant-isolated, per 05-architecture.md §6. The five obligations:
 *
 *   P1: Provision under tenant scope — brand A with website provisions exactly ONE
 *       pixel_installation; install_token is a server-minted uuid; target_host == the
 *       canonical host. The row is visible under app.current_brand_id = A and INVISIBLE
 *       (0 rows) under app.current_brand_id = B (RLS isolates — non-inert).
 *   P2: Never trust client brand_id — the provisioner takes brandId only from the
 *       freshly-written brand.id; a grep guard asserts no request-body brand_id path.
 *   P3: Token round-trips — resolve_brand_by_install_token(A's token) returns A's id.
 *   P4: Idempotency — provisioning A twice yields exactly ONE row, SAME token.
 *   P5: Edit-host-in-place — provision A with host1, re-provision with host2 → still ONE
 *       row, SAME token, target_host == host2.
 *
 * CRITICAL (THE invariant): the dev superuser 'brain' BYPASSES RLS — any isolation
 * assertion run under 'brain' is INERT (false-pass trap; MEMORY: dev-db-superuser-masks-rls).
 * Every RLS read here runs under brain_app via BRAIN_APP_DATABASE_URL, and beforeAll
 * asserts current_user='brain_app' AND is_superuser=false — else the suite throws (the
 * whole run is treated as a FAIL rather than a green inert).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg, { type QueryResultRow } from 'pg';
import type { DbPool, QueryContext } from '@brain/db';
import { PgPixelInstallationRepository } from '../infrastructure/repositories/PgPixelInstallationRepository.js';
import { PgPixelStatusRepository } from '../infrastructure/repositories/PgPixelStatusRepository.js';
import { GetOrCreatePixelInstallationCommand } from '../application/commands/GetOrCreatePixelInstallationCommand.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'b1000001-0000-4000-8000-000000000001';
const BRAND_B = 'b1000002-0000-4000-8000-000000000002';

const HOST_1 = 'sugandh-lok.example.com';
const HOST_2 = 'shop.sugandh-lok.example.com';

// ── Shared infrastructure ───────────────────────────────────────────────────

let superPool: pg.Pool;
let appPool: pg.Pool;
let installationRepo: PgPixelInstallationRepository;
let statusRepo: PgPixelStatusRepository;
let provision: GetOrCreatePixelInstallationCommand;
let orgId: string;

// DbPool adapter over brain_app: wraps every statement in BEGIN/SET LOCAL app.current_brand_id/
// COMMIT so the brand GUC drives RLS (NN-1 two-arg fail-closed). Mirrors the production pool.
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

// Count pixel_installation rows for a brand UNDER brain_app + the given GUC (RLS-scoped).
async function countRowsAsBrand(gucBrandId: string, filterBrandId: string): Promise<number> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_brand_id = '${gucBrandId}'`);
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pixel_installation WHERE brand_id = $1`,
      [filterBrandId],
    );
    await client.query('COMMIT');
    return Number(r.rows[0]!.n);
  } finally {
    client.release();
  }
}

async function seedBrand(brandId: string, host: string | null): Promise<void> {
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, domain, currency_code, region_code)
     VALUES ($1, $2, $3, $4, 'INR', 'IN')
     ON CONFLICT (id) DO NOTHING`,
    [brandId, orgId, `Onboarding Test ${brandId.slice(0, 8)}`, host],
  );
}

async function cleanupAll(): Promise<void> {
  for (const brandId of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM pixel_status WHERE brand_id = $1`, [brandId]).catch(() => undefined);
    await superPool.query(`DELETE FROM pixel_installation WHERE brand_id = $1`, [brandId]).catch(() => undefined);
    await superPool.query(`DELETE FROM brand WHERE id = $1`, [brandId]).catch(() => undefined);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 5 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });

  // INVARIANT GUARD: prove we are brain_app and NOT a superuser, else every RLS
  // assertion below is inert and the run must FAIL (not silently green).
  const who = await appPool.query<{ current_user: string; super: boolean }>(
    `SELECT current_user, current_setting('is_superuser')::boolean AS super`,
  );
  const row = who.rows[0]!;
  if (row.current_user !== 'brain_app' || row.super !== false) {
    throw new Error(
      `[provision-isolation.live] INERT-TEST GUARD: must run as non-superuser brain_app. ` +
        `Got current_user=${row.current_user}, is_superuser=${row.super}. ` +
        `Set BRAIN_APP_DATABASE_URL to the brain_app role.`,
    );
  }

  const appDbPool = makeAppDbPool(appPool);
  installationRepo = new PgPixelInstallationRepository(appDbPool);
  statusRepo = new PgPixelStatusRepository(appDbPool);
  provision = new GetOrCreatePixelInstallationCommand(
    installationRepo,
    statusRepo,
    async () => undefined, // event emit is a no-op in the isolation harness
  );

  const orgResult = await superPool.query<{ id: string }>('SELECT id FROM organization LIMIT 1');
  if (!orgResult.rows[0]) throw new Error('[provision-isolation.live] No organization found');
  orgId = orgResult.rows[0].id;

  await cleanupAll();
  await seedBrand(BRAND_A, HOST_1);
  await seedBrand(BRAND_B, HOST_1);
}, 30_000);

afterAll(async () => {
  await cleanupAll();
  await superPool.end();
  await appPool.end();
});

// ── P1: provision under tenant scope + cross-brand RLS isolation (non-inert) ──

describe('P1: provision under tenant scope — one row, server-minted token, RLS-isolated', () => {
  it('provisions exactly one row for A, visible to A, invisible to B', async () => {
    const result = await provision.execute({
      brandId: BRAND_A,
      targetHost: HOST_1,
      idempotencyKey: 'p1-key',
    });

    expect(result.isNew).toBe(true);
    expect(result.targetHost).toBe(HOST_1);
    // install_token is a server-minted uuid (NOT client-supplied).
    expect(result.installToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // Under A's GUC → 1 row. Under B's GUC → 0 rows (RLS isolates — NON-INERT).
    expect(await countRowsAsBrand(BRAND_A, BRAND_A)).toBe(1);
    expect(await countRowsAsBrand(BRAND_B, BRAND_A)).toBe(0);
  });
});

// ── P2: never trust a client-sent brand_id ────────────────────────────────────

describe('P2: provisioner takes brandId only from the brand row (R2)', () => {
  it('no provision code path reads brand_id from a request body', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const brandSvc = readFileSync(
      resolve(here, '../../../workspace-access/internal/application/brand.service.ts'),
      'utf8',
    );
    // The provision call must pass brand.id / the path-resolved id — never a body field.
    expect(brandSvc).toMatch(/provisionPixel\(brand\.id,/);
    expect(brandSvc).toMatch(/provisionPixel\(id,/);
    // Guard: no request-body brand_id is forwarded into the provisioner.
    expect(brandSvc).not.toMatch(/provisionPixel\([^)]*data\.brand/);
    expect(brandSvc).not.toMatch(/provisionPixel\([^)]*body/);
  });
});

// ── P3: token round-trips via resolve_brand_by_install_token (collector path) ──

describe('P3: install_token → brand_id derivation resolves to the right brand', () => {
  it("resolve_brand_by_install_token(A's token) returns A; a foreign token never returns A", async () => {
    const existing = await installationRepo.findByBrandId(BRAND_A);
    expect(existing).not.toBeNull();
    const token = existing!.installToken;

    // SECURITY DEFINER fn — callable by brain_app, no GUC needed.
    const resolved = await appPool.query<{ brand_id: string }>(
      `SELECT brand_id FROM resolve_brand_by_install_token($1)`,
      [token],
    );
    expect(resolved.rows).toHaveLength(1);
    expect(resolved.rows[0]!.brand_id).toBe(BRAND_A);
    expect(resolved.rows[0]!.brand_id).not.toBe(BRAND_B);

    // A random (never-issued) token resolves to nothing (no wrong-brand leak).
    const bogus = await appPool.query<{ brand_id: string }>(
      `SELECT brand_id FROM resolve_brand_by_install_token($1)`,
      ['00000000-0000-4000-8000-0000000000ff'],
    );
    expect(bogus.rows).toHaveLength(0);
  });
});

// ── P4: idempotency — re-provision is a no-op (one row, same token) ───────────

describe('P4: idempotent — provisioning A twice yields one row, same token', () => {
  it('second execute returns isNew=false with the same token and one row', async () => {
    const first = await installationRepo.findByBrandId(BRAND_A);
    const again = await provision.execute({
      brandId: BRAND_A,
      targetHost: HOST_1,
      idempotencyKey: 'p4-key',
    });
    expect(again.isNew).toBe(false);
    expect(again.installToken).toBe(first!.installToken);
    expect(await countRowsAsBrand(BRAND_A, BRAND_A)).toBe(1);
  });
});

// ── P5: edit-host-in-place — same row, same token, new target_host ────────────

describe('P5: website edit updates target_host in place, keeping the token', () => {
  it('re-provisioning A with a new host updates the row, not mints a second', async () => {
    const before = await installationRepo.findByBrandId(BRAND_A);
    const edited = await provision.execute({
      brandId: BRAND_A,
      targetHost: HOST_2,
      idempotencyKey: 'p5-key',
    });

    expect(edited.isNew).toBe(false);
    expect(edited.targetHost).toBe(HOST_2);
    expect(edited.installToken).toBe(before!.installToken); // SAME token (stable tenant key)
    expect(edited.installationId).toBe(before!.id); // SAME row

    // Still exactly one row for A, now bearing HOST_2.
    expect(await countRowsAsBrand(BRAND_A, BRAND_A)).toBe(1);
    const after = await installationRepo.findByBrandId(BRAND_A);
    expect(after!.targetHost).toBe(HOST_2);
  });
});
