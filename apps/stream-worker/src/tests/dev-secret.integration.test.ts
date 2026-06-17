/**
 * dev-secret.integration.test.ts — A4 slice
 * chore-connector-lifecycle-regression / defect #8b (D-8 / ADR-R3)
 *
 * Pins: dev_secret cross-process round-trip + prod-hard-fail guards.
 * Code-under-test:
 *   apps/core/src/.../LocalSecretsManager.ts (storeSecret/storeShopifyToken → devPersist)
 *   apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts (WorkerLocalSecretsManager.getShopifyToken)
 *   db/migrations/0024_dev_secret.sql (dev_secret table, brain_app GRANT)
 *
 * ROUND-TRIP MECHANISM:
 *   LocalSecretsManager (core) writes to dev_secret via storeShopifyToken → devPersist.
 *   WorkerLocalSecretsManager (worker) reads from dev_secret via getShopifyToken.
 *   Same token survives the "cross-process" hop because both share the dev_secret table.
 *   This is the DEV-TOKEN-REACH fix (ADR-BF-11).
 *
 * TESTS:
 *   1. storeShopifyToken → WorkerLocalSecretsManager.getShopifyToken returns same token.
 *   2. deleteShopifyToken → getShopifyToken returns null.
 *   3. LocalSecretsManager prod-hard-fail: NODE_ENV=production → constructor throws.
 *   4. it.skip: WorkerLocalSecretsManager prod-hard-fail — DISCOVERED GAP (ADR-R3).
 *
 * REVERT-RED:
 *   Test 1: if LocalSecretsManager.devPersist() is removed → worker reads null → RED.
 *   Test 3: remove the prod guard → toThrow() assertion fails → RED.
 *
 * ISOLATION:
 *   Uses superPool (brain) for seed — dev_secret is NOT RLS-scoped (name-keyed, migration 0024).
 *   Cleanup: DELETE FROM dev_secret WHERE name LIKE 'brain/connector/shopify/<brandId>%'.
 *
 * NO product code change (D-9). ADR-R3 gap surfaced as it.skip.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { LocalSecretsManager } from '../../../core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.js';
import {
  seedTestBrand,
  cleanupConnectorFixtures,
} from './helpers/connector-lifecycle-fixtures.js';

// ── Pool configuration ─────────────────────────────────────────────────────

const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

let superPool: Pool;
let appPool: Pool;

// A4-private brand UUID — does NOT collide with A2/A3 brands (avoids parallelism conflicts)
const A4_BRAND_ID = 'a4000001-0a00-4a00-8a00-000000000001';

// The test shop domain — drives the ARN name
const TEST_SHOP_DOMAIN = 'devsecret-test.myshopify.com';
const TEST_ACCESS_TOKEN = 'shpat_test_dev_secret_round_trip_token_abc123';

// Expected ARN name from LocalSecretsManager.storeShopifyToken:
//   brain/connector/shopify/${brandId}/${shopDomain.replace(/\./g, '-')}
const SECRET_NAME = `brain/connector/shopify/${A4_BRAND_ID}/${TEST_SHOP_DOMAIN.replace(/\./g, '-')}`;
const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:000000000000:secret:${SECRET_NAME}`;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 3 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 3 });

  // Seed test brand (needed by cleanupConnectorFixtures)
  await seedTestBrand(superPool, A4_BRAND_ID, 'INR');

  // Pre-clean any leftover dev_secret from a prior run
  await superPool
    .query(`DELETE FROM dev_secret WHERE name LIKE $1`, [`brain/connector/shopify/${A4_BRAND_ID}%`])
    .catch(() => undefined);
}, 20_000);

afterAll(async () => {
  // Clean dev_secret rows first
  await superPool
    .query(`DELETE FROM dev_secret WHERE name LIKE $1`, [`brain/connector/shopify/${A4_BRAND_ID}%`])
    .catch(() => undefined);

  await cleanupConnectorFixtures(superPool, [A4_BRAND_ID]);
  await appPool.end().catch(() => undefined);
  await superPool.end().catch(() => undefined);
});

// ── A4-1: round-trip — storeShopifyToken → WorkerLocalSecretsManager reads it ─

describe('A4-1: dev_secret cross-process round-trip (defect #8b / D-8)', () => {
  let storedArn: string;

  it('LocalSecretsManager.storeShopifyToken writes to dev_secret (DEV-TOKEN-REACH)', async () => {
    /**
     * storeShopifyToken:
     *   name = `brain/connector/shopify/${brandId}/${shopDomain.replace(/\./g, '-')}`
     *   devPersist(name, accessToken) → INSERT INTO dev_secret (name, secret_value) ON CONFLICT DO UPDATE
     *
     * REVERT-RED: remove devPersist() call → dev_secret row not written → next test reads null.
     */

    // LocalSecretsManager needs NODE_ENV != 'production' — it's 'test' in vitest
    const core = new LocalSecretsManager(superPool);
    const result = await core.storeShopifyToken(
      A4_BRAND_ID,
      TEST_SHOP_DOMAIN,
      TEST_ACCESS_TOKEN,
    );
    storedArn = result.arn;

    // Verify ARN shape
    expect(storedArn).toContain('arn:aws:secretsmanager');
    expect(storedArn).toContain(A4_BRAND_ID);

    // Verify the dev_secret row was actually written (via superPool)
    const row = await superPool.query<{ secret_value: string }>(
      `SELECT secret_value FROM dev_secret WHERE name = $1`,
      [SECRET_NAME],
    );
    expect(row.rows[0]?.secret_value).toBe(TEST_ACCESS_TOKEN);
  });

  it('WorkerLocalSecretsManager.getShopifyToken reads the SAME token from dev_secret (cross-process read)', async () => {
    /**
     * WorkerLocalSecretsManager.getShopifyToken:
     *   name = secretRef.split(':secret:')[1] ?? secretRef
     *   → SELECT secret_value FROM dev_secret WHERE name = $1
     *
     * This simulates the cross-process read: core wrote via LocalSecretsManager,
     * worker reads via WorkerLocalSecretsManager — both share the dev_secret table.
     *
     * REVERT-RED: if LocalSecretsManager.devPersist() is removed, the row doesn't
     * exist and this returns null → expect(token).toBe(TEST_ACCESS_TOKEN) → RED.
     */

    // WorkerLocalSecretsManager reads from dev_secret via BRAIN_APP_DATABASE_URL
    // We set the env var so the worker's lazy pool uses the test DB
    const prevDbUrl = process.env['BRAIN_APP_DATABASE_URL'];
    process.env['BRAIN_APP_DATABASE_URL'] = BRAIN_APP_DB_URL;

    let token: string | null = null;
    try {
      // Import dynamically to avoid env-var capture before we set it
      const { buildWorkerSecretsManager } = await import('../jobs/shopify-backfill/worker-secrets.js');
      const workerSecrets = buildWorkerSecretsManager();

      // Unset SHOPIFY_ACCESS_TOKEN env override so the test falls through to dev_secret
      const prevOverride = process.env['SHOPIFY_ACCESS_TOKEN'];
      delete process.env['SHOPIFY_ACCESS_TOKEN'];
      try {
        token = await workerSecrets.getShopifyToken(SECRET_ARN);
      } finally {
        if (prevOverride !== undefined) {
          process.env['SHOPIFY_ACCESS_TOKEN'] = prevOverride;
        }
      }
    } finally {
      if (prevDbUrl !== undefined) {
        process.env['BRAIN_APP_DATABASE_URL'] = prevDbUrl;
      } else {
        delete process.env['BRAIN_APP_DATABASE_URL'];
      }
    }

    // The SAME token written by core must be readable by the worker
    expect(token).toBe(TEST_ACCESS_TOKEN);
  });

  it('disconnect: deleteShopifyToken → WorkerLocalSecretsManager.getShopifyToken returns null', async () => {
    /**
     * D-8 round-trip: deleteSecret removes from dev_secret; worker subsequently reads null.
     *
     * REVERT-RED: if devDelete() is removed from deleteShopifyToken, the dev_secret row
     * persists and the worker still reads the old token → expect(token).toBeNull() → RED.
     */
    const core = new LocalSecretsManager(superPool);
    await core.deleteShopifyToken(SECRET_ARN);

    // Verify dev_secret row is gone
    const row = await superPool.query<{ secret_value: string }>(
      `SELECT secret_value FROM dev_secret WHERE name = $1`,
      [SECRET_NAME],
    );
    expect(row.rows.length).toBe(0); // row deleted

    // Worker read now returns null
    const prevDbUrl = process.env['BRAIN_APP_DATABASE_URL'];
    process.env['BRAIN_APP_DATABASE_URL'] = BRAIN_APP_DB_URL;

    let token: string | null = 'NOT_NULL'; // sentinel to detect no-op
    try {
      const { buildWorkerSecretsManager } = await import('../jobs/shopify-backfill/worker-secrets.js');
      const workerSecrets = buildWorkerSecretsManager();

      const prevOverride = process.env['SHOPIFY_ACCESS_TOKEN'];
      delete process.env['SHOPIFY_ACCESS_TOKEN'];
      try {
        token = await workerSecrets.getShopifyToken(SECRET_ARN);
      } finally {
        if (prevOverride !== undefined) {
          process.env['SHOPIFY_ACCESS_TOKEN'] = prevOverride;
        }
      }
    } finally {
      if (prevDbUrl !== undefined) {
        process.env['BRAIN_APP_DATABASE_URL'] = prevDbUrl;
      } else {
        delete process.env['BRAIN_APP_DATABASE_URL'];
      }
    }

    // After deletion, worker must return null
    expect(token).toBeNull();
  });
});

// ── A4-2: LocalSecretsManager prod-hard-fail ─────────────────────────────────

describe('A4-2: LocalSecretsManager (core) hard-fails in production (defect #8b / D-8)', () => {
  it('REVERT-RED: NODE_ENV=production → constructor throws [LocalSecretsManager] FATAL', () => {
    /**
     * LocalSecretsManager.ts:33-38:
     *   if (process.env['NODE_ENV'] === 'production') {
     *     throw new Error('[LocalSecretsManager] FATAL: ...');
     *   }
     *
     * REVERT-RED: remove this guard → constructor no longer throws in production
     * → toThrow('[LocalSecretsManager] FATAL') goes RED.
     */
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => new LocalSecretsManager()).toThrow('[LocalSecretsManager] FATAL');
    } finally {
      if (prev !== undefined) {
        process.env['NODE_ENV'] = prev;
      } else {
        delete process.env['NODE_ENV'];
      }
    }
  });

  it('non-production: constructor does NOT throw (confirm guard is NODE_ENV-scoped)', () => {
    const prev = process.env['NODE_ENV'];
    // In test/dev, constructor must not throw
    process.env['NODE_ENV'] = 'test';
    try {
      expect(() => new LocalSecretsManager()).not.toThrow();
    } finally {
      if (prev !== undefined) {
        process.env['NODE_ENV'] = prev;
      } else {
        delete process.env['NODE_ENV'];
      }
    }
  });
});

// ── A4-3: ADR-R3 — WorkerLocalSecretsManager prod-hard-fail (DISCOVERED GAP) ─

describe('A4-3: WorkerLocalSecretsManager prod-hard-fail — ADR-R3 discovered gap', () => {
  it.skip(
    // DISCOVERED BUG: WorkerLocalSecretsManager has no NODE_ENV=production guard
    // (worker-secrets.ts:69). buildWorkerSecretsManager() branches to AwsSecretsManager
    // in prod (line 37), but the WorkerLocalSecretsManager CLASS ITSELF is instantiable
    // in production — its constructor has no guard. Only the factory function avoids it.
    //
    // This means: if someone instantiates new WorkerLocalSecretsManager() directly
    // (e.g. in a test, a future refactor, or a DI container), the prod guard is bypassed.
    // LocalSecretsManager (core) has this guard; WorkerLocalSecretsManager does NOT.
    //
    // D-8 requires "both managers throw under NODE_ENV=production."
    // This assertion would be RED on current master (WorkerLocalSecretsManager does not throw).
    // NOT fixed in this PR (tests-only / D-9). Surface as a separate requirement.
    //
    // ADR-R3: This is a PRODUCT GAP — a separate PR should add:
    //   if (process.env['NODE_ENV'] === 'production') {
    //     throw new Error('[WorkerLocalSecretsManager] FATAL: must not be instantiated in production');
    //   }
    // to the WorkerLocalSecretsManager constructor at worker-secrets.ts:69.
    'WorkerLocalSecretsManager should hard-fail under NODE_ENV=production — DISCOVERED GAP (ADR-R3)',
    async () => {
      // This test CANNOT pass on current master (WorkerLocalSecretsManager has no prod guard).
      // Skipped until the guard is added in a separate product PR.
      //
      // When un-skipped, the assertion should be:
      const { WorkerLocalSecretsManager } = await import('../jobs/shopify-backfill/worker-secrets.js') as {
        WorkerLocalSecretsManager: new () => unknown;
      };

      const prev = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        expect(() => new WorkerLocalSecretsManager()).toThrow(
          /WorkerLocalSecretsManager.*FATAL|must not be instantiated in production/i,
        );
      } finally {
        if (prev !== undefined) {
          process.env['NODE_ENV'] = prev;
        } else {
          delete process.env['NODE_ENV'];
        }
      }
    },
  );
});
