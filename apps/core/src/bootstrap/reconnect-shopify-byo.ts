/**
 * reconnect-shopify-byo.ts — one-shot idempotent boot task.
 *
 * Purpose: After the "Shopify BYO-app required" ship, existing Shopify installs authenticated
 * against the env-baked app are broken (webhook HMAC verifies against the env secret, which is
 * no longer accepted). This task flips those installs to RECONNECT_REQUIRED so the connect UI
 * prompts the merchant to reconnect with their own Custom App credentials.
 *
 * last_error tag: 'RECONNECT_REQUIRED:BYO_APP_REQUIRED' — the RECONNECT_REQUIRED substring
 * satisfies migration 0112's `LIKE '%RECONNECT_REQUIRED%'` repull back-off (no 45s retry
 * spam), and the BYO_APP_REQUIRED suffix drives the connect UI's reconnect banner.
 *
 * Idempotency: guarded by ops.migration_state (migration 0133) — the marker row is inserted
 * LAST, so a mid-run crash re-runs safely on next boot (per-row UPDATE is idempotent).
 *
 * Scope: reads across brands (superuser txn — ops layer). Emits the same event lane the OAuth
 * callback already uses, so the medallion audit trail catches the reconnect prompts.
 */
import type pg from 'pg';
import type { ISecretsManager } from '@brain/connector-secrets';
import { hasBrandOAuthAppCreds } from '../modules/connector/oauth-app-creds.js';

export const MIGRATION_KEY = 'shopify_byo_required_2026_07';

const LAST_ERROR_TAG = 'RECONNECT_REQUIRED:BYO_APP_REQUIRED';

export interface RunReconnectShopifyByoDeps {
  pool: pg.Pool;
  secrets: ISecretsManager;
  emit: (eventName: string, payload: Record<string, unknown>) => Promise<void>;
}

export async function runReconnectShopifyByoMigration(deps: RunReconnectShopifyByoDeps): Promise<void> {
  const { pool, secrets, emit } = deps;

  // 1. Idempotency check.
  const marker = await pool.query<{ key: string }>(
    `SELECT key FROM ops.migration_state WHERE key = $1`,
    [MIGRATION_KEY],
  );
  if (marker.rows.length > 0) return;

  // 2. Enumerate all connected Shopify instances.
  const instances = await pool.query<{ id: string; brand_id: string }>(
    `SELECT id, brand_id FROM connector_instance WHERE provider = 'shopify' AND status = 'connected'`,
  );

  // 3. For each, flip when no per-brand app secret exists.
  for (const row of instances.rows) {
    const hasCreds = await hasBrandOAuthAppCreds(secrets, 'shopify', row.brand_id);
    if (hasCreds) continue;

    await pool.query(
      `UPDATE connector_sync_status
         SET state = 'error',
             last_error = $2,
             updated_at = NOW()
       WHERE connector_instance_id = $1`,
      [row.id, LAST_ERROR_TAG],
    );
    await emit('connector.reconnect_required', {
      brand_id: row.brand_id,
      connector_instance_id: row.id,
      provider: 'shopify',
      reason: 'byo_app_required',
    });
  }

  // 4. Insert the marker LAST so a crash re-runs the migration safely.
  await pool.query(
    `INSERT INTO ops.migration_state (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
    [MIGRATION_KEY],
  );
}
