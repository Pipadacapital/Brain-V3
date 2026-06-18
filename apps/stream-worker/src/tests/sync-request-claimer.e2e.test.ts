/**
 * sync-request-claimer.e2e.test.ts — feat-connector-sync-now Track A (claimer).
 *
 * Proves the in-worker claimer's claim semantics under brain_app (RLS FORCE):
 *
 *   T1: claimSyncRequest claims a pending sentinel row ONCE (returns true), atomically
 *       tombstones it (cursor_value=''); a second claim returns false (no double-dispatch).
 *       Non-inert overlap proof at the claim layer (the tombstone-on-claim is the dedup
 *       primitive — brain_app has no DELETE grant; the repull run()'s OWN FOR UPDATE SKIP
 *       LOCKED is the authoritative double-run guard).
 *
 *   T2: cross-brand isolation — a sentinel seeded for Brand A is NOT claimable under
 *       Brand B's GUC (count of claims for B === 0); Brand A claims it. Asserts
 *       current_user='brain_app' + is_superuser=false FIRST (non-inert).
 *
 * The dev superuser 'brain' BYPASSES RLS — these run under BRAIN_APP_DATABASE_URL with
 * assertBrainApp() so the isolation assertion is real (MEMORY: dev-db-superuser-masks-rls).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  seedTestBrand,
  seedConnectorInstance,
  cleanupConnectorFixtures,
  assertBrainApp,
} from './helpers/connector-lifecycle-fixtures.js';
import { claimSyncRequest } from '../jobs/sync-request-claimer/run.js';

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

// Q-ISOLATION fix: this test owns UNIQUE brand/CI ids (NOT the shared CONNECTOR_TEST_*
// constants) so its beforeAll/afterAll cleanupConnectorFixtures only truncates ITS rows.
// Sharing the common fixtures caused full-suite nondeterminism — one file's cleanup wiped
// rows another e2e file was mid-test on (green-in-isolation, red-in-full-suite).
const BRAND_A = 'c1a1c1a1-0000-4000-8000-000000000a01';
const BRAND_B = 'c1a1c1a1-0000-4000-8000-000000000a02';
const CI_ID = 'c1a1c1a1-0000-4000-8000-0000000000c1';
const SYNC_REQUEST_RESOURCE = 'sync.request';

let superPool: Pool;
let appPool: Pool;

async function seedSentinel(brandId: string, ciId: string): Promise<void> {
  await superPool.query(
    `INSERT INTO connector_cursor (brand_id, connector_instance_id, resource, cursor_value, updated_at)
     VALUES ($1, $2, $3, NOW()::text, NOW())
     ON CONFLICT ON CONSTRAINT connector_cursor_upsert_key
     DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()`,
    [brandId, ciId, SYNC_REQUEST_RESOURCE],
  );
}

/** Count PENDING sentinels (non-empty cursor_value). A '' tombstone = consumed. */
async function countSentinels(ciId: string): Promise<number> {
  const r = await superPool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM connector_cursor
      WHERE connector_instance_id = $1 AND resource = $2
        AND cursor_value IS NOT NULL AND cursor_value <> ''`,
    [ciId, SYNC_REQUEST_RESOURCE],
  );
  return parseInt(r.rows[0]!.cnt, 10);
}

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 5 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 5 });

  await cleanupConnectorFixtures(superPool, [BRAND_A, BRAND_B]);
  await seedTestBrand(superPool, BRAND_A);
  await seedTestBrand(superPool, BRAND_B);
  await seedConnectorInstance(superPool, { brandId: BRAND_A, ciId: CI_ID });
}, 30_000);

afterAll(async () => {
  await cleanupConnectorFixtures(superPool, [BRAND_A, BRAND_B]);
  await superPool.end();
  await appPool.end();
});

// ── T1: claim once, second claim false, exactly zero left after claim ─────────
describe('T1: claimSyncRequest — claims once, second claim returns false', () => {
  it('first claim true + deletes sentinel; second claim false', async () => {
    await seedSentinel(BRAND_A, CI_ID);
    expect(await countSentinels(CI_ID)).toBe(1);

    const first = await claimSyncRequest(appPool, BRAND_A, CI_ID);
    expect(first, 'first claim should succeed').toBe(true);

    // Claim-is-tombstone: the sentinel is consumed (cursor_value='').
    expect(
      await countSentinels(CI_ID),
      'claim must tombstone the sentinel (no re-dispatch)',
    ).toBe(0);

    const second = await claimSyncRequest(appPool, BRAND_A, CI_ID);
    expect(second, 'second claim should find nothing (already claimed)').toBe(false);
  });
});

// ── T2: cross-brand isolation under brain_app ─────────────────────────────────
describe('T2: cross-brand isolation under brain_app', () => {
  it('Brand B cannot claim Brand A sentinel; Brand A can (non-inert)', async () => {
    await assertBrainApp(appPool);

    await seedSentinel(BRAND_A, CI_ID);
    expect(await countSentinels(CI_ID)).toBe(1);

    // Brand B claim under its own GUC → RLS FORCE hides the Brand A row → false.
    const claimedByB = await claimSyncRequest(appPool, BRAND_B, CI_ID);
    expect(
      claimedByB,
      'Isolation FAILED: Brand B claimed Brand A sentinel (RLS not enforced under brain_app)',
    ).toBe(false);
    expect(await countSentinels(CI_ID), 'Brand B must not delete Brand A sentinel').toBe(1);

    // Positive control: Brand A claims its own.
    const claimedByA = await claimSyncRequest(appPool, BRAND_A, CI_ID);
    expect(claimedByA).toBe(true);
    expect(await countSentinels(CI_ID)).toBe(0);
  });
});
