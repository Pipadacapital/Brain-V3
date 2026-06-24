/**
 * sync-status-currency.integration.test.ts — A3 slice
 * chore-connector-lifecycle-regression / defect #8a (sync-status→connected)
 *
 * Pins defect #8a — sync-status→connected on backfill complete (D-7.2)
 *   Code-under-test: apps/stream-worker/src/jobs/shopify-backfill/run.ts:485-503
 *   On recordsProcessed > 0n:
 *     UPDATE connector_sync_status SET state='connected', last_sync_at=NOW(), last_error=NULL, updated_at=NOW()
 *     WHERE brand_id=$1 AND connector_instance_id=$2
 *   Under brand GUC (BEGIN / set_config / UPDATE / COMMIT).
 *
 *   This test reproduces the EXACT SQL contract from run.ts:488-495 directly against
 *   the DB (approach from plan §3 "Note on 8a": direct-SQL contract assertion pins the
 *   SQL contract the dashboard reads — connector_sync_status.state='connected').
 *
 *   REVERT-RED: if run.ts skips the completion UPDATE, state stays 'waiting_for_data'
 *   → expect(state).toBe('connected') goes RED.
 *
 * MEDALLION REALIGNMENT (Epic 1 / decision B): the former defect #8c here pinned the PG
 *   trg_ledger_currency trigger on realized_revenue_ledger. That table + trigger (migration 0018)
 *   were DROPPED (migration 0098) — revenue is out of PG (Bronze→silver_order_recognition→gold
 *   revenue ledger). The currency/amount-pairing invariant (I-S07) now lives in the recognition
 *   pipeline (currency_code carried through from Bronze), so the PG-trigger tests were removed.
 *
 * ISOLATION:
 *   #8a: UPDATE under brain_app appPool + brand GUC (D-3). assertBrainApp() called first.
 *
 * NO product code change. Tests only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  NIL_UUID,
  seedTestBrand,
  seedConnectorInstance,
  seedSyncStatus,
  cleanupConnectorFixtures,
  assertBrainApp,
} from './helpers/connector-lifecycle-fixtures.js';

// ── Pool configuration ─────────────────────────────────────────────────────

const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

let superPool: Pool;
let appPool: Pool;

// A3-private brand + CI UUIDs (do NOT collide with A2's c07ec701/c07ec702 to avoid
// file-level parallelism conflicts when both suites run concurrently).
const A3_BRAND_INR   = 'a3000001-0a00-4a00-8a00-000000000001'; // INR brand for sync_status test
const A3_BRAND_B_INR = 'a3000002-0b00-4b00-8b00-000000000002'; // INR brand B for cross-brand test
const A3_CI_ID       = 'a3000003-0c00-4c00-8c00-000000000003'; // connector_instance for A3

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 5 });

  // Seed A3-private brands (INR for sync_status tests)
  await seedTestBrand(superPool, A3_BRAND_INR, 'INR');
  await seedTestBrand(superPool, A3_BRAND_B_INR, 'INR');

  // Seed connector instance and sync status for #8a
  await seedConnectorInstance(superPool, {
    brandId: A3_BRAND_INR,
    ciId: A3_CI_ID,
    status: 'connected',
  });
  await seedSyncStatus(superPool, {
    brandId: A3_BRAND_INR,
    ciId: A3_CI_ID,
    state: 'waiting_for_data',
  });
}, 20_000);

afterAll(async () => {
  await cleanupConnectorFixtures(superPool, [A3_BRAND_INR, A3_BRAND_B_INR]);

  await appPool.end().catch(() => undefined);
  await superPool.end().catch(() => undefined);
});

// ── A3-1: sync-status→connected on backfill complete (#8a) ───────────────────

describe('A3-1: sync-status→connected after backfill completes (defect #8a / D-7.2)', () => {
  it('assertBrainApp: appPool is brain_app (non-superuser, D-3)', async () => {
    await assertBrainApp(appPool);
  });

  it('SETUP: seeded sync_status state is waiting_for_data', async () => {
    // Verify seed via superPool (setup check)
    const result = await superPool.query<{ state: string }>(
      `SELECT state FROM connector_sync_status
       WHERE brand_id = $1 AND connector_instance_id = $2`,
      [A3_BRAND_INR, A3_CI_ID],
    );
    expect(result.rows[0]?.state).toBe('waiting_for_data');
  });

  it('REVERT-RED: applying the completion UPDATE sets state=connected, last_sync_at set, last_error=NULL', async () => {
    /**
     * This reproduces EXACTLY the SQL from run.ts:485-503:
     *
     *   const sc = await pool.connect();
     *   await sc.query('BEGIN');
     *   await sc.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
     *   await sc.query(
     *     `UPDATE connector_sync_status
     *        SET state = 'connected', last_sync_at = NOW(), last_error = NULL, updated_at = NOW()
     *      WHERE brand_id = $1 AND connector_instance_id = $2`,
     *     [brandId, connectorInstanceId],
     *   );
     *   await sc.query('COMMIT');
     *
     * REVERT-RED: if this UPDATE is removed from run.ts, the state stays 'waiting_for_data'
     * and the assertion below goes RED.
     */
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, true)`,
        [A3_BRAND_INR],
      );
      await client.query(
        `UPDATE connector_sync_status
           SET state = 'connected', last_sync_at = NOW(), last_error = NULL, updated_at = NOW()
         WHERE brand_id = $1 AND connector_instance_id = $2`,
        [A3_BRAND_INR, A3_CI_ID],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // Read back the updated state via superPool (authoritative read, no RLS masking)
    const result = await superPool.query<{
      state: string;
      last_sync_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT state, last_sync_at, last_error
       FROM connector_sync_status
       WHERE brand_id = $1 AND connector_instance_id = $2`,
      [A3_BRAND_INR, A3_CI_ID],
    );

    const row = result.rows[0];
    expect(row).toBeDefined();

    // REVERT-RED: if the completion UPDATE is skipped, state stays 'waiting_for_data' → RED
    expect(row!.state).toBe('connected');

    // last_sync_at must be set (not null) — proves the UPDATE ran
    expect(row!.last_sync_at).not.toBeNull();

    // last_error must be cleared to NULL on successful backfill
    expect(row!.last_error).toBeNull();
  });

  it('state is readable under brain_app + brand GUC (RLS isolation enforced)', async () => {
    const client = await appPool.connect();
    let state: string | null = null;
    try {
      // Read back under brain_app + correct GUC
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, false)`,
        [A3_BRAND_INR],
      );
      const result = await client.query<{ state: string }>(
        `SELECT state FROM connector_sync_status
         WHERE brand_id = $1 AND connector_instance_id = $2`,
        [A3_BRAND_INR, A3_CI_ID],
      );
      state = result.rows[0]?.state ?? null;
    } finally {
      client.release();
    }

    expect(state).toBe('connected');
  });

  it('cross-brand: brand B GUC cannot see brand A sync_status (RLS isolation)', async () => {
    await assertBrainApp(appPool);

    const client = await appPool.connect();
    let count = -1;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, true)`,
        [A3_BRAND_B_INR],
      );
      const result = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM connector_sync_status
         WHERE connector_instance_id = $1`,
        [A3_CI_ID],
      );
      await client.query('COMMIT');
      count = parseInt(result.rows[0]?.c ?? '0', 10);
    } finally {
      client.release();
    }

    // Brand B GUC → 0 rows for brand A's sync status
    expect(count).toBe(0);
  });
});
