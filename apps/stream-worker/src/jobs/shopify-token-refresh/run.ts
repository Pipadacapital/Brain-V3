/**
 * shopify-token-refresh — proactive Shopify offline-token refresh job.
 *
 * Shopify offline-token expiry mandate:
 *   - 2026-04-01: tokens issued after this date expire after 1 year.
 *   - 2027-01-01: ALL offline tokens expire (including legacy ones).
 *
 * This job mirrors meta-token-refresh: it runs on a schedule (daily), enumerates
 * all connected Shopify connectors whose token was issued more than DEFAULT_REFRESH_AGE_DAYS
 * ago, exchanges the still-valid token for a fresh one, and writes back via
 * ISecretsManager.putSecretValue — so the ARN in connector_instance.secret_ref is
 * unchanged (NN-2) but the secret value is fresh.
 *
 * Enumerate: list_connectors_for_repull() — SECURITY DEFINER, NO GUC at enumerate time
 * (system-job-force-rls-enumeration). brand_id from fn result (MT-1).
 *
 * Secret read/write:
 *   PROD: AwsSecretsManager.getSecret(ARN) reads the bundle; putSecretValue writes it back.
 *   DEV:  dev_secret table (same as meta-token-refresh dev path).
 *
 * I-S09: tokens NEVER logged. Log only connector_instance_id + brand_id.
 *
 * Observability:
 *   shopify_token_refresh_total{}, shopify_token_refresh_error_total{reason},
 *   shopify_token_refresh_skipped_total{reason} — feeds BrainShopifyTokenRefreshFailing alert.
 *   Exchange failure flips health_state→TokenExpired (RECONNECT_REQUIRED) via
 *   updateConnectorInstanceHealth().
 */

import { Pool } from 'pg';
import { incrementCounter } from '@brain/observability';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { updateConnectorInstanceHealth } from '../../infrastructure/pg/ConnectorInstanceHealthRepository.js';
import {
  exchangeShopifyToken,
  isShopifyTokenRefreshDue,
  DEFAULT_REFRESH_AGE_DAYS,
  SHOPIFY_APP_CREDS_MISSING,
} from './shopify-token-client.js';
import { log } from '../../log.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import { loadStreamWorkerConfig } from '@brain/config';

// ── Configuration ──────────────────────────────────────────────────────────────

const DB_URL = loadStreamWorkerConfig().BRAIN_APP_DATABASE_URL;

// ── Types ──────────────────────────────────────────────────────────────────────

interface ShopifyConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  shop_domain: string;
  secret_ref: string;
}

/**
 * Dev secret bundle for a Shopify connector.
 * Mirrors the shape stored/read by HandleOAuthCallbackCommand + WorkerLocalSecretsManager.
 */
interface ShopifySecretBundle {
  access_token: string;           // NEVER logged (I-S09)
  shop_domain?: string;
  access_token_issued_at?: string; // ISO-8601; absent on legacy tokens → treated as due
}

// ── Enumerate (SECURITY DEFINER, NO GUC) ──────────────────────────────────────

async function enumerateShopifyConnectors(pool: Pool): Promise<ShopifyConnectorRow[]> {
  const result = await pool.query<ShopifyConnectorRow>(
    `SELECT connector_instance_id, brand_id, shop_domain, secret_ref
     FROM list_connectors_for_repull()
     WHERE provider = 'shopify'`,
  );
  return result.rows;
}

// ── Secret read (dev path — mirrors meta-token-refresh) ───────────────────────

async function readBundle(pool: Pool, secretRef: string): Promise<ShopifySecretBundle | null> {
  const name = secretRef.split(':secret:')[1] ?? secretRef;
  const res = await pool.query<{ secret_value: string }>(
    `SELECT secret_value FROM dev_secret WHERE name = $1`,
    [name],
  );
  const raw = res.rows[0]?.secret_value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShopifySecretBundle;
  } catch {
    return null;
  }
}

/**
 * Write the refreshed bundle back.
 *
 * PROD: uses ISecretsManager.putSecretValue(secretRef, bundle) — writes to AWS
 *       Secrets Manager under the same ARN (NN-2: ARN unchanged). Tokens never
 *       expire silently because the write-back keeps the stored token fresh.
 * DEV:  upserts dev_secret (the repull / OAuth callback reads it the same way).
 *
 * I-S09: bundle values are NEVER logged.
 */
async function writeBundle(
  pool: Pool,
  secretRef: string,
  bundle: ShopifySecretBundle,
  secretsManager?: ISecretsManager,
): Promise<void> {
  if (secretsManager) {
    // PROD seam: PutSecretValue on the existing ARN — preserves the ARN stored in
    // connector_instance.secret_ref (NN-2). putSecretValue is the UPSERT from the
    // connector-secrets package.
    await secretsManager.putSecretValue(secretRef, bundle as unknown as Record<string, string>);
    return;
  }
  // DEV fallback: upsert into dev_secret so the repull job reads the fresh token.
  const name = secretRef.split(':secret:')[1] ?? secretRef;
  await pool.query(
    `INSERT INTO dev_secret (name, secret_value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET secret_value = EXCLUDED.secret_value`,
    [name, JSON.stringify(bundle)],
  );
}

// ── Set connector sync_status error on token expiry ──────────────────────────

async function setSyncStateError(pool: Pool, brandId: string, connectorInstanceId: string, reason: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
    await client.query(
      `UPDATE connector_sync_status
       SET state = 'error', error_message = $3, updated_at = NOW()
       WHERE brand_id = $1 AND connector_instance_id = $2`,
      [brandId, connectorInstanceId, reason],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export interface ShopifyTokenRefreshReport {
  scanned: number;
  refreshed: number;
  skippedNotDue: number;
  reconnectRequired: number;
  errors: number;
}

/**
 * Run one refresh pass. Parameterised (nowMs, fetchImpl, secretsManager) for deterministic tests.
 *
 * @param pool            brain_app pool (enumerate is SECURITY DEFINER; dev_secret is system).
 * @param nowMs           current time (injectable).
 * @param thresholdDays   age at which a token is proactively refreshed.
 * @param fetchImpl       fetch implementation (injectable for tests).
 * @param secretsManager  optional ISecretsManager for prod write-back. When absent (dev),
 *                        the bundle is written to dev_secret.
 */
export async function runShopifyTokenRefresh(
  pool: Pool,
  nowMs: number = Date.now(),
  thresholdDays: number = DEFAULT_REFRESH_AGE_DAYS,
  fetchImpl: typeof fetch = fetch,
  secretsManager?: ISecretsManager,
): Promise<ShopifyTokenRefreshReport> {
  const report: ShopifyTokenRefreshReport = {
    scanned: 0,
    refreshed: 0,
    skippedNotDue: 0,
    reconnectRequired: 0,
    errors: 0,
  };

  const connectors = await enumerateShopifyConnectors(pool);

  for (const c of connectors) {
    report.scanned += 1;
    const { connector_instance_id: ciId, brand_id: brandId, shop_domain: shopDomain, secret_ref: secretRef } = c;

    try {
      // ── Read current bundle ────────────────────────────────────────────────────
      let bundle: ShopifySecretBundle | null;
      if (secretsManager) {
        // PROD: read via ISecretsManager.getSecret (AwsSecretsManager).
        const raw = await secretsManager.getSecret(secretRef);
        bundle = raw ? (raw as unknown as ShopifySecretBundle) : null;
      } else {
        // DEV: read from dev_secret table.
        bundle = await readBundle(pool, secretRef);
      }

      if (!bundle?.access_token) {
        // No token → already needs reconnect; nothing to refresh.
        report.reconnectRequired += 1;
        continue;
      }

      // ── Due check ─────────────────────────────────────────────────────────────
      if (!isShopifyTokenRefreshDue(bundle.access_token_issued_at, nowMs, thresholdDays)) {
        report.skippedNotDue += 1;
        incrementCounter('shopify_token_refresh_skipped_total', { reason: 'not_due' });
        continue;
      }

      // ── Exchange ──────────────────────────────────────────────────────────────
      try {
        const { accessToken } = await exchangeShopifyToken(shopDomain, bundle.access_token, fetchImpl);
        await writeBundle(
          pool,
          secretRef,
          {
            ...bundle,
            access_token: accessToken,
            access_token_issued_at: new Date(nowMs).toISOString(),
          },
          secretsManager,
        );
        report.refreshed += 1;
        incrementCounter('shopify_token_refresh_total', { provider: 'shopify' });
        log.info(`[shopify-token-refresh] refreshed connector=${ciId} brand=${brandId}`);
      } catch (err) {
        const msg = String(err);
        if (msg.includes(SHOPIFY_APP_CREDS_MISSING)) {
          // App creds missing is an OPS misconfig — count + stop early.
          report.errors += 1;
          incrementCounter('shopify_token_refresh_error_total', { reason: 'app_creds_missing' });
          log.error('[shopify-token-refresh] SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET not configured — aborting pass');
          return report;
        }
        // Exchange failed → token cannot be renewed → RECONNECT_REQUIRED.
        report.reconnectRequired += 1;
        recordConnectorAuthRejected('shopify');
        await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired').catch(() => undefined);
        await setSyncStateError(pool, brandId, ciId, 'shopify token refresh failed — RECONNECT_REQUIRED').catch(() => undefined);
        incrementCounter('shopify_token_refresh_error_total', { reason: 'exchange_failed' });
        log.warn(`[shopify-token-refresh] exchange failed connector=${ciId} — RECONNECT_REQUIRED`);
      }
    } catch (err) {
      report.errors += 1;
      incrementCounter('shopify_token_refresh_error_total', { reason: 'unexpected' });
      log.error(`[shopify-token-refresh] unexpected error connector=${ciId}`, { err });
    }
  }

  log.info(
    `[shopify-token-refresh] pass done scanned=${report.scanned} refreshed=${report.refreshed} ` +
      `skipped=${report.skippedNotDue} reconnect=${report.reconnectRequired} errors=${report.errors}`,
  );
  return report;
}

// ── Standalone entrypoint (Argo CronWorkflow: `node dist/jobs/shopify-token-refresh/run.js`) ─

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = new Pool({ connectionString: DB_URL, max: 2 });

  let secretsMgr: ISecretsManager | undefined;
  const isProductionEnv = process.env['NODE_ENV'] === 'production';
  if (isProductionEnv) {
    const { AwsSecretsManager } = await import('@brain/connector-secrets');
    const region = process.env['AWS_REGION'] ?? 'us-east-1';
    const clientSecretArn = process.env['SHOPIFY_CLIENT_SECRET'] ?? '';
    const kmsKeyId = process.env['CONNECTOR_SECRETS_KMS_KEY_ID'] ?? '';
    if (!clientSecretArn || !kmsKeyId) {
      log.error(
        '[shopify-token-refresh] FATAL: SHOPIFY_CLIENT_SECRET + CONNECTOR_SECRETS_KMS_KEY_ID required in prod',
      );
      process.exit(1);
    }
    secretsMgr = new AwsSecretsManager(region, clientSecretArn, kmsKeyId);
  }

  runShopifyTokenRefresh(pool, Date.now(), DEFAULT_REFRESH_AGE_DAYS, fetch, secretsMgr)
    .then((r) => { void pool.end(); process.exit(r.errors > 0 ? 1 : 0); })
    .catch((err) => { log.error('[shopify-token-refresh] fatal', { err }); void pool.end(); process.exit(1); });
}
