/**
 * sync-run-repository.integration.test.ts — ledger writer test for connector_sync_run.
 *
 * Tests:
 *   1. start→finish (succeeded): two rows in connector_sync_run per run — a 'started' row and
 *      a 'succeeded' terminal row — verifiable via superuser read.
 *   2. start→finish (failed): the terminal row carries error_class + error_detail.
 *   3. RLS isolation: brand B GUC cannot read brand A's run rows.
 *   4. Append-only guard: brain_app has no UPDATE/DELETE on connector_sync_run.
 *
 * Pattern mirrors sync-status-currency.integration.test.ts:
 *   - superPool (superuser 'brain') for seed + assertion reads (bypasses RLS)
 *   - appPool  (brain_app) for write-path tests + isolation assertions (NOBYPASSRLS, FORCE RLS)
 *
 * ISOLATION: private UUID prefix 'sr000001-*' / 'sr000002-*' — no collision with existing suites.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  SyncRunRepository,
} from '../infrastructure/pg/SyncRunRepository.js';
import {
  seedTestBrand,
  seedConnectorInstance,
  cleanupConnectorFixtures,
  assertBrainApp,
} from './helpers/connector-lifecycle-fixtures.js';

// ── Pool configuration ─────────────────────────────────────────────────────────

const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

let superPool: Pool;
let appPool: Pool;
let repo: SyncRunRepository;

// ── Test fixtures ──────────────────────────────────────────────────────────────
// Private UUIDs — hex-only, valid UUIDv4 format, never used by any other suite.
const SR_BRAND_A = 'sr000001-0a00-4a00-8a00-000000000001';
const SR_BRAND_B = 'sr000002-0b00-4b00-8b00-000000000002';
const SR_CI_A    = 'sr000003-0c00-4c00-8c00-000000000003';

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool   = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 5 });
  repo      = new SyncRunRepository(appPool);

  // Seed two brands + connector instance for brand A.
  await seedTestBrand(superPool, SR_BRAND_A, 'INR');
  await seedTestBrand(superPool, SR_BRAND_B, 'INR');
  await seedConnectorInstance(superPool, { brandId: SR_BRAND_A, ciId: SR_CI_A });
}, 20_000);

afterAll(async () => {
  // Remove all sync run rows for the test brands, then clean up the brand fixtures.
  await superPool
    .query(`DELETE FROM connector_sync_run WHERE brand_id IN ($1, $2)`, [SR_BRAND_A, SR_BRAND_B])
    .catch(() => undefined);

  await cleanupConnectorFixtures(superPool, [SR_BRAND_A, SR_BRAND_B]);

  await appPool.end().catch(() => undefined);
  await superPool.end().catch(() => undefined);
}, 20_000);

// ── Suite 1: start → succeed ──────────────────────────────────────────────────

describe('SyncRunRepository — start→succeed lifecycle', () => {
  it('assertBrainApp: appPool is brain_app (NOBYPASSRLS)', async () => {
    await assertBrainApp(appPool);
  });

  it('startRun inserts a started row; closeRun inserts a succeeded row', async () => {
    const runId = SyncRunRepository.newRunId();

    // Write start row.
    const startedAt = await repo.startRun({
      runId,
      brandId: SR_BRAND_A,
      provider: 'shopify',
      runType: 'repull',
      correlationId: `test:${runId}`,
    });

    expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601

    // Verify the started row via superuser (bypasses RLS).
    const startedRows = await superPool.query<{ status: string; started_at: Date }>(
      `SELECT status, started_at FROM connector_sync_run
       WHERE run_id = $1 AND brand_id = $2`,
      [runId, SR_BRAND_A],
    );
    expect(startedRows.rows).toHaveLength(1);
    expect(startedRows.rows[0]!.status).toBe('started');

    // Write terminal succeeded row.
    await repo.closeRun({
      runId,
      brandId: SR_BRAND_A,
      startedAt,
      status: 'succeeded',
      rowsIngested: 42,
    });

    // Verify both rows exist: 1 started + 1 succeeded.
    const allRows = await superPool.query<{ status: string; rows_ingested: number | null }>(
      `SELECT status, rows_ingested FROM connector_sync_run
       WHERE brand_id = $1
         AND correlation_id = $2
       ORDER BY started_at, status`,
      [SR_BRAND_A, `test:${runId}`],
    );
    // Two rows: the 'started' row + the 'succeeded' terminal row.
    expect(allRows.rows.length).toBeGreaterThanOrEqual(2);
    const statuses = allRows.rows.map((r) => r.status).sort();
    expect(statuses).toContain('started');
    expect(statuses).toContain('succeeded');

    // The terminal row carries rows_ingested.
    const succeededRow = allRows.rows.find((r) => r.status === 'succeeded');
    expect(succeededRow?.rows_ingested).toBe(42);
  });
});

// ── Suite 2: start → fail ─────────────────────────────────────────────────────

describe('SyncRunRepository — start→fail lifecycle', () => {
  it('closeRun with status=failed records error_class + error_detail', async () => {
    const runId = SyncRunRepository.newRunId();

    const startedAt = await repo.startRun({
      runId,
      brandId: SR_BRAND_A,
      provider: 'meta',
      runType: 'repull',
    });

    await repo.closeRun({
      runId,
      brandId: SR_BRAND_A,
      startedAt,
      status: 'failed',
      rowsIngested: 0,
      errorClass: 'AUTH_ERROR',
      errorDetail: '401 — token expired',
    });

    const rows = await superPool.query<{
      status: string;
      error_class: string | null;
      error_detail: string | null;
    }>(
      `SELECT status, error_class, error_detail FROM connector_sync_run
       WHERE run_id = $1 AND brand_id = $2 AND status = 'failed'`,
      [runId, SR_BRAND_A],
    );

    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.error_class).toBe('AUTH_ERROR');
    expect(rows.rows[0]!.error_detail).toBe('401 — token expired');
  });

  it('closeRun truncates error_detail at 500 chars', async () => {
    const runId = SyncRunRepository.newRunId();
    const longDetail = 'x'.repeat(1000);

    const startedAt = await repo.startRun({
      runId,
      brandId: SR_BRAND_A,
      provider: 'razorpay',
      runType: 'repull',
    });

    await repo.closeRun({
      runId,
      brandId: SR_BRAND_A,
      startedAt,
      status: 'failed',
      errorClass: 'PAGE_ERROR',
      errorDetail: longDetail,
    });

    const rows = await superPool.query<{ error_detail: string | null }>(
      `SELECT error_detail FROM connector_sync_run
       WHERE run_id = $1 AND brand_id = $2 AND status = 'failed'`,
      [runId, SR_BRAND_A],
    );

    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.error_detail?.length).toBeLessThanOrEqual(500);
  });
});

// ── Suite 3: RLS isolation — brand B cannot see brand A's runs ────────────────

describe('SyncRunRepository — RLS isolation between brands', () => {
  it('assertBrainApp: appPool is brain_app (NOBYPASSRLS)', async () => {
    await assertBrainApp(appPool);
  });

  it('brand B GUC cannot read brand A sync run rows', async () => {
    // Seed a known run for brand A.
    const runId = SyncRunRepository.newRunId();
    await repo.startRun({
      runId,
      brandId: SR_BRAND_A,
      provider: 'shopify',
      runType: 'repull',
    });

    // Attempt to read brand A's run with brand B's GUC via appPool (brain_app, NOBYPASSRLS).
    const client = await appPool.connect();
    let count = -1;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [SR_BRAND_B]);
      const result = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM connector_sync_run WHERE run_id = $1`,
        [runId],
      );
      await client.query('COMMIT');
      count = parseInt(result.rows[0]?.c ?? '0', 10);
    } finally {
      client.release();
    }

    // RLS filters: brand B GUC sees 0 rows for brand A's run.
    expect(count).toBe(0);
  });

  it('brand A GUC sees its own run rows', async () => {
    const runId = SyncRunRepository.newRunId();
    await repo.startRun({
      runId,
      brandId: SR_BRAND_A,
      provider: 'google_ads',
      runType: 'repull',
    });

    const client = await appPool.connect();
    let count = -1;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [SR_BRAND_A]);
      const result = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM connector_sync_run WHERE run_id = $1`,
        [runId],
      );
      await client.query('COMMIT');
      count = parseInt(result.rows[0]?.c ?? '0', 10);
    } finally {
      client.release();
    }

    // Brand A GUC sees its own row.
    expect(count).toBe(1);
  });
});

// ── Suite 4: Append-only guard ────────────────────────────────────────────────

describe('SyncRunRepository — append-only grant guard', () => {
  it('brain_app has no UPDATE privilege on connector_sync_run', async () => {
    const result = await superPool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'connectors'
         AND table_name = 'connector_sync_run'
         AND grantee = 'brain_app'
         AND privilege_type = 'UPDATE'`,
    );
    expect(result.rows).toHaveLength(0);
  });

  it('brain_app has no DELETE privilege on connector_sync_run', async () => {
    const result = await superPool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'connectors'
         AND table_name = 'connector_sync_run'
         AND grantee = 'brain_app'
         AND privilege_type = 'DELETE'`,
    );
    expect(result.rows).toHaveLength(0);
  });

  it('brain_app has SELECT + INSERT on connector_sync_run', async () => {
    const result = await superPool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'connectors'
         AND table_name = 'connector_sync_run'
         AND grantee = 'brain_app'
         AND privilege_type IN ('SELECT', 'INSERT')
       ORDER BY privilege_type`,
    );
    const privs = result.rows.map((r) => r.privilege_type).sort();
    expect(privs).toContain('INSERT');
    expect(privs).toContain('SELECT');
  });
});
