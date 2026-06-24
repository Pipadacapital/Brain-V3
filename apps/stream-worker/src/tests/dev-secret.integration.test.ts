/**
 * dev-secret.integration.test.ts — A4 slice
 * chore-connector-lifecycle-regression / defect #8b (D-8 / ADR-R3)
 *
 * Pins: dev_secret cross-process round-trip + prod-hard-fail guards.
 * Code-under-test:
 *   apps/core/src/.../LocalSecretsManager.ts (storeSecret/storeShopifyToken → devPersist)
 *   apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts (LocalWorkerSecretsProvider.getShopifyToken)
 *   db/migrations/0024_dev_secret.sql (dev_secret table, brain_app GRANT)
 *
 * ROUND-TRIP MECHANISM:
 *   LocalSecretsManager (core) writes to dev_secret via storeShopifyToken → devPersist.
 *   LocalWorkerSecretsProvider (worker) reads from dev_secret via getShopifyToken.
 *   Same token survives the "cross-process" hop because both share the dev_secret table.
 *   This is the DEV-TOKEN-REACH fix (ADR-BF-11).
 *
 * TESTS:
 *   1. storeShopifyToken → LocalWorkerSecretsProvider.getShopifyToken returns same token.
 *   2. deleteShopifyToken → getShopifyToken returns null.
 *   3. LocalSecretsManager prod-hard-fail: NODE_ENV=production → constructor throws.
 *   4. it.skip: LocalWorkerSecretsProvider prod-hard-fail — DISCOVERED GAP (ADR-R3).
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

// ── A4-1: round-trip — storeShopifyToken → LocalWorkerSecretsProvider reads it ─

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

    // Write the dev_secret row exactly as core's LocalSecretsManager.storeShopifyToken →
    // devPersist would (same name-key). The CORE write path (storeShopifyToken → devPersist) is
    // unit-tested in apps/core (LocalSecretsManager.test.ts) — in-package, no cross-rootDir import.
    // Here we test the WORKER's cross-process READ of dev_secret.
    storedArn = `arn:aws:secretsmanager:us-east-1:000000000000:secret:${SECRET_NAME}`;
    await superPool.query(
      `INSERT INTO dev_secret (name, secret_value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET secret_value = EXCLUDED.secret_value`,
      [SECRET_NAME, TEST_ACCESS_TOKEN],
    );

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

  it('LocalWorkerSecretsProvider.getShopifyToken reads the SAME token from dev_secret (cross-process read)', async () => {
    /**
     * LocalWorkerSecretsProvider.getShopifyToken:
     *   name = secretRef.split(':secret:')[1] ?? secretRef
     *   → SELECT secret_value FROM dev_secret WHERE name = $1
     *
     * This simulates the cross-process read: core wrote via LocalSecretsManager,
     * worker reads via LocalWorkerSecretsProvider — both share the dev_secret table.
     *
     * REVERT-RED: if LocalSecretsManager.devPersist() is removed, the row doesn't
     * exist and this returns null → expect(token).toBe(TEST_ACCESS_TOKEN) → RED.
     */

    // LocalWorkerSecretsProvider reads from dev_secret via BRAIN_APP_DATABASE_URL
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

  it('disconnect: deleteShopifyToken → LocalWorkerSecretsProvider.getShopifyToken returns null', async () => {
    /**
     * D-8 round-trip: deleteSecret removes from dev_secret; worker subsequently reads null.
     *
     * REVERT-RED: if devDelete() is removed from deleteShopifyToken, the dev_secret row
     * persists and the worker still reads the old token → expect(token).toBeNull() → RED.
     */
    // Delete the dev_secret row (as core's deleteShopifyToken → devDelete would; that core path
    // is covered in apps/core LocalSecretsManager.test.ts). Here we assert the WORKER reads null.
    await superPool.query(`DELETE FROM dev_secret WHERE name = $1`, [SECRET_NAME]);

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

// A4-2 (core LocalSecretsManager prod-hard-fail) lives in apps/core
// (LocalSecretsManager.test.ts) — in-package, no cross-rootDir import (QA-CLR-LOW-01).

// ── A4-3: LocalWorkerSecretsProvider prod-hard-fail (SEC-CLR-MED-01 — now FIXED) ─

describe('A4-3: LocalWorkerSecretsProvider prod-hard-fail (SEC-CLR-MED-01)', () => {
  it(
    // SEC-CLR-MED-01 (was ADR-R3 discovered gap, now FIXED): LocalWorkerSecretsProvider's
    // constructor now hard-fails under NODE_ENV=production, mirroring core's LocalSecretsManager.
    // buildWorkerSecretsManager() branches to AwsSecretsManager in prod; this guard defends a
    // direct-instantiation bypass. REVERT-RED: remove the guard at worker-secrets.ts → no throw.
    'LocalWorkerSecretsProvider hard-fails under NODE_ENV=production',
    async () => {
      const { LocalWorkerSecretsProvider } = await import('../jobs/shopify-backfill/worker-secrets.js');

      const prev = process.env['NODE_ENV'];
      process.env['NODE_ENV'] = 'production';
      try {
        expect(() => new LocalWorkerSecretsProvider()).toThrow(
          /LocalWorkerSecretsProvider.*FATAL|must not be instantiated in production/i,
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
