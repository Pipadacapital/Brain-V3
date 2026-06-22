/**
 * LocalSecretsManager (core) — DEV-TOKEN-REACH + prod-hard-fail (defect #8b / D-8).
 *
 * Moved here from apps/stream-worker/src/tests/dev-secret.integration.test.ts (QA-CLR-LOW-01):
 * the core write path belongs in-package (no cross-rootDir import from stream-worker).
 *
 * Covers:
 *   - storeShopifyToken → devPersist writes the token to dev_secret (the cross-process write half;
 *     the worker's READ half is in apps/stream-worker/src/tests/dev-secret.integration.test.ts).
 *   - getShopifyToken reads it back; deleteShopifyToken removes it.
 *   - prod-hard-fail: NODE_ENV=production → constructor throws (REVERT-RED: remove the guard → no throw).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { LocalSecretsManager } from './LocalSecretsManager.js';

const SUPERUSER_DB_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const BRAND_ID = '10ca15ec-0e00-4e00-8e00-000000000001';
const SHOP_DOMAIN = 'localsecrets-test.myshopify.com';
const ACCESS_TOKEN = 'shpat_test_local_secrets_write_path_xyz789';
const SECRET_NAME = `brain/connector/shopify/${BRAND_ID}/${SHOP_DOMAIN.replace(/\./g, '-')}`;

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 2 });
  await pool.query(`DELETE FROM dev_secret WHERE name = $1`, [SECRET_NAME]).catch(() => undefined);
});

afterAll(async () => {
  await pool.query(`DELETE FROM dev_secret WHERE name = $1`, [SECRET_NAME]).catch(() => undefined);
  await pool.end().catch(() => undefined);
});

describe('LocalSecretsManager — dev_secret write path (DEV-TOKEN-REACH)', () => {
  it('storeShopifyToken persists the token to dev_secret; getShopifyToken reads it back', async () => {
    const mgr = new LocalSecretsManager(pool); // NODE_ENV is 'test' under vitest → no throw
    const { arn } = await mgr.storeShopifyToken(BRAND_ID, SHOP_DOMAIN, ACCESS_TOKEN);

    expect(arn).toContain('arn:aws:secretsmanager');
    expect(arn).toContain(BRAND_ID);

    // REVERT-RED: remove the devPersist() call in storeShopifyToken → no dev_secret row → RED.
    const row = await pool.query<{ secret_value: string }>(
      `SELECT secret_value FROM dev_secret WHERE name = $1`,
      [SECRET_NAME],
    );
    expect(row.rows[0]?.secret_value).toBe(ACCESS_TOKEN);

    // Round-trip read via the manager's own getShopifyToken.
    const readBack = await mgr.getShopifyToken(arn);
    expect(readBack).toBe(ACCESS_TOKEN);

    // deleteShopifyToken removes it.
    await mgr.deleteShopifyToken(arn);
    const afterDelete = await pool.query(`SELECT 1 FROM dev_secret WHERE name = $1`, [SECRET_NAME]);
    expect(afterDelete.rowCount).toBe(0);
  });
});

describe('LocalSecretsManager — storeSecret UPSERT + putSecretValue (reconnect path)', () => {
  it('storeSecret called twice with the same key does NOT throw and overwrites the value', async () => {
    const mgr = new LocalSecretsManager(); // no pool — in-memory only
    const brandId = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
    const connectorRef = { connectorType: 'razorpay', subKey: 'rzp_test_account' };

    const first = await mgr.storeSecret(brandId, connectorRef, { webhook_secret: 'old_secret' });
    // REVERT-RED: remove the second storeSecret call and this test goes RED
    const second = await mgr.storeSecret(brandId, connectorRef, { webhook_secret: 'new_secret' });

    // Both calls must return the same ARN (NN-2: secret_ref must not change on reconnect).
    expect(first.arn).toBe(second.arn);
    expect(first.name).toBe(second.name);

    // Reading back must return the overwritten value.
    const stored = await mgr.getSecret(second.arn);
    expect(stored?.['webhook_secret']).toBe('new_secret');
  });

  it('putSecretValue overwrites an existing in-memory secret by ARN', async () => {
    const mgr = new LocalSecretsManager();
    const brandId = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
    const { arn } = await mgr.storeSecret(brandId, { connectorType: 'meta' }, { access_token: 'tok_old' });

    await mgr.putSecretValue(arn, { access_token: 'tok_new', access_token_issued_at: '2026-06-22T00:00:00Z' });

    const stored = await mgr.getSecret(arn);
    expect(stored?.['access_token']).toBe('tok_new');
    expect(stored?.['access_token_issued_at']).toBe('2026-06-22T00:00:00Z');
  });
});

describe('LocalSecretsManager — prod-hard-fail (D-7)', () => {
  it('REVERT-RED: NODE_ENV=production → constructor throws [LocalSecretsManager] FATAL', () => {
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => new LocalSecretsManager()).toThrow('[LocalSecretsManager] FATAL');
    } finally {
      if (prev !== undefined) process.env['NODE_ENV'] = prev;
      else delete process.env['NODE_ENV'];
    }
  });

  it('non-production: constructor does NOT throw (guard is NODE_ENV-scoped)', () => {
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'test';
    try {
      expect(() => new LocalSecretsManager()).not.toThrow();
    } finally {
      if (prev !== undefined) process.env['NODE_ENV'] = prev;
      else delete process.env['NODE_ENV'];
    }
  });
});
