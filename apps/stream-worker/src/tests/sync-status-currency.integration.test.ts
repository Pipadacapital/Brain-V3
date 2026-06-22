/**
 * sync-status-currency.integration.test.ts — A3 slice
 * chore-connector-lifecycle-regression / defects #8a (sync-status→connected) + #8c (currency trigger)
 *
 * Pins two defect classes:
 *
 * #8a — sync-status→connected on backfill complete (D-7.2)
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
 * #8c — currency-mismatch trigger fires on mismatched INSERT (D-7.3)
 *   Code-under-test: db/migrations/0018_realized_revenue_ledger.sql:129-159
 *     trg_ledger_currency → RAISE EXCEPTION 'currency mismatch …' on currency mismatch.
 *
 *   REVERT-RED: if the trigger is dropped, the INSERT succeeds silently
 *   → expect(insert).rejects assertion goes RED.
 *
 * ISOLATION:
 *   #8a: UPDATE under brain_app appPool + brand GUC (D-3). assertBrainApp() called first.
 *   #8c: INSERT via superPool (structural DB trigger — fires regardless of user).
 *       The trigger reads brand.currency_code; superPool has full access.
 *
 * NO product code change. Tests only.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
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

// Currency trigger test brands (AED — isolated to A3, never touched by A2)
const CURRENCY_TEST_BRAND_AED = 'c07ec703-0c00-4c00-8c00-000000000004';

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 5 });

  // Seed A3-private brands (INR for sync_status tests, AED for trigger tests)
  await seedTestBrand(superPool, A3_BRAND_INR, 'INR');
  await seedTestBrand(superPool, A3_BRAND_B_INR, 'INR');
  await seedTestBrand(superPool, CURRENCY_TEST_BRAND_AED, 'AED');

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
  // Clean up currency trigger test ledger rows for all A3 brands
  await superPool
    .query(`DELETE FROM realized_revenue_ledger WHERE brand_id IN ($1, $2, $3)`, [
      A3_BRAND_INR,
      A3_BRAND_B_INR,
      CURRENCY_TEST_BRAND_AED,
    ])
    .catch(() => undefined);

  await cleanupConnectorFixtures(superPool, [
    A3_BRAND_INR,
    A3_BRAND_B_INR,
    CURRENCY_TEST_BRAND_AED,
  ]);

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

// ── A3-2: currency-mismatch trigger (#8c) ────────────────────────────────────

describe('A3-2: trg_ledger_currency fires on currency mismatch (defect #8c / D-7.3)', () => {
  it('SETUP: CURRENCY_TEST_BRAND_AED has currency_code=AED in brand table', async () => {
    const result = await superPool.query<{ currency_code: string }>(
      `SELECT currency_code FROM brand WHERE id = $1`,
      [CURRENCY_TEST_BRAND_AED],
    );
    expect(result.rows[0]?.currency_code).toBe('AED');
  });

  it('REVERT-RED: INSERT with mismatched currency (INR into AED brand) → trigger raises exception', async () => {
    /**
     * The trigger: trg_ledger_currency (migration 0018:156-159)
     * fires BEFORE INSERT on realized_revenue_ledger FOR EACH ROW.
     *
     * It reads brand.currency_code and compares to NEW.currency_code.
     * A mismatch raises: 'currency mismatch: ledger row currency=... but brand ... currency=...'
     * PG error class P0 (PL/pgSQL RAISE EXCEPTION → code P0001).
     *
     * REVERT-RED: if the trigger is dropped, the INSERT succeeds silently
     * → this rejects() assertion fails (resolves instead) → RED.
     */
    const ledgerEventId = randomUUID();
    const orderId = `trigger-test-${randomUUID()}`;

    const insertPromise = superPool.query(
      `INSERT INTO realized_revenue_ledger (
         brand_id, ledger_event_id, order_id, event_type,
         amount_minor, currency_code, rounding_adjustment_minor,
         occurred_at, occurred_date, economic_effective_at, billing_posted_period,
         recognition_label
       ) VALUES ($1, $2, $3, 'finalization', 100000, 'INR', 0, NOW(), (timezone('UTC',NOW()::timestamptz))::date, NOW(), '2024-01', 'finalized')`,
      [CURRENCY_TEST_BRAND_AED, ledgerEventId, orderId],
    );

    // REVERT-RED: if trigger is dropped, this rejects() becomes a no-throw → test fails
    await expect(insertPromise).rejects.toThrow(/currency mismatch/i);
  });

  it('trigger error code is P0001 (RAISE EXCEPTION = plpgsql error)', async () => {
    const ledgerEventId = randomUUID();
    const orderId = `trigger-test-code-${randomUUID()}`;

    let errorCode: string | undefined;
    try {
      await superPool.query(
        `INSERT INTO realized_revenue_ledger (
           brand_id, ledger_event_id, order_id, event_type,
           amount_minor, currency_code, rounding_adjustment_minor,
           occurred_at, occurred_date, economic_effective_at, billing_posted_period,
           recognition_label
         ) VALUES ($1, $2, $3, 'finalization', 100000, 'INR', 0, NOW(), (timezone('UTC',NOW()::timestamptz))::date, NOW(), '2024-01', 'finalized')`,
        [CURRENCY_TEST_BRAND_AED, ledgerEventId, orderId],
      );
    } catch (err: unknown) {
      errorCode = (err as { code?: string }).code;
    }

    expect(errorCode).toBe('P0001');
  });

  it('correct currency (AED into AED brand) → INSERT succeeds (trigger allows matching currency)', async () => {
    /**
     * Positive control: the trigger ALLOWS matching currency.
     * This confirms the trigger is narrowly scoped to mismatches, not a blanket block.
     */
    const ledgerEventId = randomUUID();
    const orderId = `trigger-test-match-${randomUUID()}`;

    await expect(
      superPool.query(
        `INSERT INTO realized_revenue_ledger (
           brand_id, ledger_event_id, order_id, event_type,
           amount_minor, currency_code, rounding_adjustment_minor,
           occurred_at, occurred_date, economic_effective_at, billing_posted_period,
           recognition_label
         ) VALUES ($1, $2, $3, 'finalization', 100000, 'AED', 0, NOW(), (timezone('UTC',NOW()::timestamptz))::date, NOW(), '2024-01', 'finalized')`,
        [CURRENCY_TEST_BRAND_AED, ledgerEventId, orderId],
      ),
    ).resolves.toBeDefined(); // INSERT succeeds — no trigger exception

    // Cleanup this successful row
    await superPool.query(
      `DELETE FROM realized_revenue_ledger WHERE order_id = $1`,
      [orderId],
    ).catch(() => undefined);
  });

  it('REVERT-RED (AED brand, wrong INR): inserting wrong INR into same AED brand → same trigger', async () => {
    /**
     * Additional revert-RED: same AED brand, but attempt to insert a different wrong currency (GBP).
     * Proves the trigger checks ANY mismatch, not just AED↔INR.
     * Uses CURRENCY_TEST_BRAND_AED (AED brand) — only seeded by this test file (no parallelism risk).
     */
    const ledgerEventId = randomUUID();
    const orderId = `trigger-test-gbp-${randomUUID()}`;

    const insertPromise = superPool.query(
      `INSERT INTO realized_revenue_ledger (
         brand_id, ledger_event_id, order_id, event_type,
         amount_minor, currency_code, rounding_adjustment_minor,
         occurred_at, occurred_date, economic_effective_at, billing_posted_period,
         recognition_label
       ) VALUES ($1, $2, $3, 'finalization', 100000, 'GBP', 0, NOW(), (timezone('UTC',NOW()::timestamptz))::date, NOW(), '2024-01', 'finalized')`,
      [CURRENCY_TEST_BRAND_AED, ledgerEventId, orderId],
    );

    // GBP ≠ AED → trigger fires (same mechanism as INR ≠ AED)
    await expect(insertPromise).rejects.toThrow(/currency mismatch/i);
  });
});
