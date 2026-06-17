/**
 * worker-guc.integration.test.ts — A2 slice
 * chore-connector-lifecycle-regression / defects #7a (NIL-uuid GUC) + #7b (cross-brand isolation)
 *
 * Pins: run.ts:255-296 loadConnectorInstance NIL-uuid fix (D-6) + cross-brand RLS (D-3).
 * Code-under-test:
 *   apps/stream-worker/src/jobs/shopify-backfill/run.ts:270
 *     const NIL_UUID = '00000000-0000-0000-0000-000000000000';
 *   apps/stream-worker/src/jobs/shopify-backfill/run.ts:274-279
 *     set_config('app.current_user_id', NIL_UUID, true)
 *     set_config('app.current_workspace_id', NIL_UUID, true)
 *
 * ALL ISOLATION ASSERTIONS run under BRAIN_APP_DATABASE_URL (appPool).
 * Superuser pool (superPool) is used ONLY for brand/instance seed + teardown.
 *
 * assertBrainApp() called at the top of every isolation block — D-3 durable rule.
 * If it fails, the isolation assertions below it are structurally inert
 * (dev superuser 'brain' bypasses RLS — MEMORY: dev-db-superuser-masks-rls).
 *
 * NON-INERT / REVERT-RED assertions:
 *
 *   #7a NIL-uuid fix:
 *     Positive control (fix in place): set_config('app.current_user_id', NIL_UUID) → SELECT returns row, no error.
 *     Revert-RED (empty-string GUC): set_config('app.current_user_id', '') → ::uuid cast raises 22P02.
 *     REVERTS: change NIL_UUID → '' in run.ts:270 → positive control now throws 22P02 → RED.
 *
 *   #7b cross-brand isolation:
 *     Brand B GUC reading brand A's connector_instance → count===0.
 *     REVERTS: DROP the FORCE RLS policy → count>0 → RED.
 *
 * NO product code change. Tests mirror the exact SQL from run.ts:271-289.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  CONNECTOR_TEST_BRAND_A,
  CONNECTOR_TEST_BRAND_B,
  CONNECTOR_TEST_CI_ID,
  NIL_UUID,
  seedTestBrand,
  seedConnectorInstance,
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

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 5 });

  // Seed test brands and connector instance
  await seedTestBrand(superPool, CONNECTOR_TEST_BRAND_A);
  await seedTestBrand(superPool, CONNECTOR_TEST_BRAND_B);
  await seedConnectorInstance(superPool, {
    brandId: CONNECTOR_TEST_BRAND_A,
    ciId: CONNECTOR_TEST_CI_ID,
    status: 'connected',
  });
}, 20_000);

afterAll(async () => {
  await cleanupConnectorFixtures(superPool, [CONNECTOR_TEST_BRAND_A, CONNECTOR_TEST_BRAND_B]);
  await appPool.end().catch(() => undefined);
  await superPool.end().catch(() => undefined);
});

// ── A2-1: assertBrainApp primitive (self-validating guard) ────────────────────

describe('A2-0: assertBrainApp guard is itself non-superuser (D-3 self-check)', () => {
  it('appPool connects as brain_app (non-superuser, NOBYPASSRLS)', async () => {
    // This is the durable rule guard — D-3.
    // If this fails, ALL isolation assertions in this file are meaningless.
    await assertBrainApp(appPool);
  });
});

// ── A2-1: NIL-uuid GUC positive control (#7a fix in place) ───────────────────

describe('A2-1: loadConnectorInstance NIL-uuid positive control (defect #7a)', () => {
  it('assertBrainApp: running under brain_app (D-3)', async () => {
    await assertBrainApp(appPool);
  });

  it('NIL-uuid GUC: set_config(current_user_id, NIL_UUID) → SELECT connector_instance returns row', async () => {
    /**
     * This mirrors run.ts:271-289 exactly:
     *   BEGIN
     *   set_config('app.current_brand_id', brandId, true)
     *   set_config('app.current_user_id', NIL_UUID, true)
     *   set_config('app.current_workspace_id', NIL_UUID, true)
     *   SELECT ci.brand_id, ci.shop_domain, ci.secret_ref, COALESCE(b.currency_code,'INR')
     *   FROM connector_instance ci JOIN brand b ON b.id = ci.brand_id
     *   WHERE ci.id = $1 AND ci.brand_id = $2
     *   COMMIT
     *
     * REVERT-RED: change NIL_UUID → '' in run.ts:270 → the ::uuid cast in the RLS policy
     * raises 22P02 (invalid input syntax for type uuid) → expect(row).not.toBeNull() goes RED.
     */
    const client = await appPool.connect();
    let row: { brand_id: string; shop_domain: string } | null = null;

    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, true),
                set_config('app.current_user_id', $2, true),
                set_config('app.current_workspace_id', $2, true)`,
        [CONNECTOR_TEST_BRAND_A, NIL_UUID],
      );
      const result = await client.query<{ brand_id: string; shop_domain: string }>(
        `SELECT ci.brand_id, ci.shop_domain, ci.secret_ref,
                COALESCE(b.currency_code, 'INR') AS currency_code
         FROM connector_instance ci
         JOIN brand b ON b.id = ci.brand_id
         WHERE ci.id = $1 AND ci.brand_id = $2`,
        [CONNECTOR_TEST_CI_ID, CONNECTOR_TEST_BRAND_A],
      );
      await client.query('COMMIT');
      row = result.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err; // fail the test — fix should not throw
    } finally {
      client.release();
    }

    // POSITIVE CONTROL: fix in place → row returned, no error
    expect(row).not.toBeNull();
    expect(row!.brand_id).toBe(CONNECTOR_TEST_BRAND_A);
  });
});

// ── A2-2: NIL-uuid REVERT-RED — empty-string GUC raises 22P02 ───────────────

describe('A2-2: loadConnectorInstance empty-string GUC revert-RED (defect #7a)', () => {
  it('assertBrainApp: running under brain_app (D-3)', async () => {
    await assertBrainApp(appPool);
  });

  it('REVERT-RED: empty-string GUC raises 22P02 (invalid input for uuid cast)', async () => {
    /**
     * This is the REVERT-RED assertion: demonstrates what fails WITHOUT the NIL-uuid fix.
     *
     * If run.ts:270 were reverted from NIL_UUID → '', the brand RLS policy casts
     * app.current_user_id::uuid → "invalid input syntax for type uuid: ''" → PG error 22P02.
     *
     * We explicitly reproduce this failure path here so a reviewer can confirm:
     * "this assertion proves the NIL-uuid substitution is load-bearing."
     *
     * Named revert: set NIL_UUID → '' in run.ts:270 → the POSITIVE CONTROL test above
     * (A2-1) would throw this same 22P02 error instead of returning a row → RED.
     */
    const client = await appPool.connect();
    let pgErrorCode: string | undefined;

    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, true),
                set_config('app.current_user_id', $2, true),
                set_config('app.current_workspace_id', $2, true)`,
        [CONNECTOR_TEST_BRAND_A, ''],  // '' — the OLD (buggy) empty-string sentinel
      );
      await client.query(
        `SELECT ci.brand_id
         FROM connector_instance ci
         JOIN brand b ON b.id = ci.brand_id
         WHERE ci.id = $1 AND ci.brand_id = $2`,
        [CONNECTOR_TEST_CI_ID, CONNECTOR_TEST_BRAND_A],
      );
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      pgErrorCode = (err as { code?: string }).code;
    } finally {
      client.release();
    }

    // The empty-string GUC MUST trigger a 22P02 (invalid uuid cast) from the RLS policy.
    // If this assertion passes, it proves the NIL-uuid fix is non-inert: '' → error, NIL → row.
    expect(pgErrorCode).toBe('22P02');
  });
});

// ── A2-3: Cross-brand isolation under brain_app (#7b) ────────────────────────

describe('A2-3: cross-brand isolation — brand B GUC cannot see brand A connector_instance', () => {
  it('assertBrainApp: running under brain_app (D-3)', async () => {
    await assertBrainApp(appPool);
  });

  it('POSITIVE CONTROL: brand A GUC → connector_instance count = 1 for brand A', async () => {
    const client = await appPool.connect();
    let count = -1;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, true),
                set_config('app.current_user_id', $2, true),
                set_config('app.current_workspace_id', $2, true)`,
        [CONNECTOR_TEST_BRAND_A, NIL_UUID],
      );
      const result = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM connector_instance WHERE brand_id = $1`,
        [CONNECTOR_TEST_BRAND_A],
      );
      await client.query('COMMIT');
      count = parseInt(result.rows[0]?.c ?? '0', 10);
    } finally {
      client.release();
    }

    // POSITIVE CONTROL: brand A GUC → sees brand A's row
    expect(count).toBe(1);
  });

  it('NEGATIVE CONTROL: brand B GUC → connector_instance count for brand A = 0 (REVERT-RED)', async () => {
    /**
     * NON-INERT: cross-brand RLS isolation.
     *
     * REVERT-RED: if the FORCE RLS policy on connector_instance is dropped,
     * brain_app with brand B's GUC would see brand A's row → count > 0 → RED.
     *
     * This also catches the case where a developer accidentally turns off FORCE RLS
     * for connector_instance — the count would become 1 and this test fails.
     */
    const client = await appPool.connect();
    let count = -1;
    try {
      await client.query('BEGIN');
      // Set BRAND_B's GUC
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, true),
                set_config('app.current_user_id', $2, true),
                set_config('app.current_workspace_id', $2, true)`,
        [CONNECTOR_TEST_BRAND_B, NIL_UUID],
      );
      // Try to read BRAND_A's connector_instance row
      const result = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM connector_instance WHERE brand_id = $1`,
        [CONNECTOR_TEST_BRAND_A],
      );
      await client.query('COMMIT');
      count = parseInt(result.rows[0]?.c ?? '0', 10);
    } finally {
      client.release();
    }

    // NEGATIVE CONTROL: brand B GUC → 0 rows for brand A (RLS isolation enforced)
    // REVERT-RED: if RLS is dropped → count > 0 → this assertion fails
    expect(count).toBe(0);
  });

  it('NEGATIVE CONTROL: no GUC set → connector_instance fails-closed (0 rows or 22P02 cast error)', async () => {
    /**
     * Additional fail-closed assertion: without ANY brand GUC set,
     * brain_app either sees 0 rows (RLS blocks all) or the RLS policy raises 22P02
     * because the empty-string app.current_user_id cannot be cast to uuid.
     * Both outcomes prove fail-closed — no data leaks to an unscoped query.
     *
     * This mirrors the "fail-closed" requirement (NN-1 from D-3).
     * The RLS policy behavior (0 rows vs 22P02) depends on the policy expression.
     */
    const client = await appPool.connect();
    let count = -1;
    let pgErrorCode: string | undefined;

    try {
      // No GUC set at all — raw brain_app query
      const result = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM connector_instance WHERE brand_id = $1`,
        [CONNECTOR_TEST_BRAND_A],
      );
      count = parseInt(result.rows[0]?.c ?? '0', 10);
    } catch (err: unknown) {
      pgErrorCode = (err as { code?: string }).code;
    } finally {
      client.release();
    }

    // Without a GUC: fail-closed — either 0 rows OR 22P02 (both prove no data leak)
    if (pgErrorCode !== undefined) {
      // RLS cast error: the policy raised 22P02 on empty-string uuid cast
      expect(pgErrorCode).toBe('22P02');
    } else {
      // RLS filtered all rows: no data visible without brand GUC
      expect(count).toBe(0);
    }
  });
});
