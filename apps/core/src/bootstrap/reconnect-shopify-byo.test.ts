/**
 * reconnect-shopify-byo.test.ts — one-shot boot task that flips env-app Shopify installs
 * to RECONNECT_REQUIRED:BYO_APP_REQUIRED (the tag satisfies migration 0112's
 * `last_error LIKE '%RECONNECT_REQUIRED%'` back-off AND the UI banner's
 * `includes('BYO_APP_REQUIRED')`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type pg from 'pg';
import type { ISecretsManager } from '@brain/connector-secrets';
import { runReconnectShopifyByoMigration, MIGRATION_KEY } from './reconnect-shopify-byo.js';

function mockPool(rows: Array<{ id: string; brand_id: string }>, alreadyApplied = false) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM ops.migration_state')) {
      return { rows: alreadyApplied ? [{ key: MIGRATION_KEY }] : [] };
    }
    if (sql.startsWith('SELECT id, brand_id FROM connector_instance')) {
      return { rows };
    }
    if (sql.startsWith('UPDATE connector_sync_status')) return { rowCount: 1 };
    if (sql.startsWith('INSERT INTO ops.migration_state')) return { rowCount: 1 };
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

// The last_error tag chosen in Task 10 Step 0 (0112 predicate: LIKE '%RECONNECT_REQUIRED%').
const LAST_ERROR_TAG = 'RECONNECT_REQUIRED:BYO_APP_REQUIRED';

function mockSecrets(bundlesByBrand: Record<string, Record<string, string> | null>): ISecretsManager {
  return {
    getSecret: vi.fn(async (name: string) => {
      const m = /shopify_app\/(.+)$/.exec(name);
      return m ? (bundlesByBrand[m[1]!] ?? null) : null;
    }),
  } as unknown as ISecretsManager;
}

describe('reconnect-shopify-byo boot task', () => {
  let emit: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    emit = vi.fn(async () => undefined);
  });

  it('flips instances with no per-brand secret to RECONNECT_REQUIRED and emits event', async () => {
    const pool = mockPool([{ id: 'inst-1', brand_id: 'brand-1' }]);
    const secrets = mockSecrets({ 'brand-1': null });

    await runReconnectShopifyByoMigration({ pool, secrets, emit });

    // UPDATE connector_sync_status ran once with the BYO tag.
    const updates = (pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => String(call[0]).startsWith('UPDATE connector_sync_status'),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[1]).toContain(LAST_ERROR_TAG);
    expect(emit).toHaveBeenCalledWith(
      'connector.reconnect_required',
      expect.objectContaining({
        brand_id: 'brand-1',
        connector_instance_id: 'inst-1',
        provider: 'shopify',
        reason: 'byo_app_required',
      }),
    );
  });

  it('leaves instances with a per-brand secret UNTOUCHED', async () => {
    const pool = mockPool([{ id: 'inst-1', brand_id: 'brand-1' }]);
    const secrets = mockSecrets({ 'brand-1': { client_id: 'x', client_secret: 'y' } });

    await runReconnectShopifyByoMigration({ pool, secrets, emit });

    const updates = (pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => String(call[0]).startsWith('UPDATE connector_sync_status'),
    );
    expect(updates).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('is idempotent — second run is a no-op when marker present', async () => {
    const pool = mockPool([{ id: 'inst-1', brand_id: 'brand-1' }], /*alreadyApplied=*/ true);
    const secrets = mockSecrets({ 'brand-1': null });

    await runReconnectShopifyByoMigration({ pool, secrets, emit });

    // Only the marker SELECT should have run; no SELECT of instances, no UPDATE.
    const selects = (pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => String(call[0]).startsWith('SELECT id, brand_id FROM connector_instance'),
    );
    expect(selects).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
