/**
 * meta-token-refresh — proactive Meta long-lived-token re-exchange job (closes the P2.6 self-heal gap).
 *
 * Meta tokens expire in ~60 days and CANNOT be refreshed once expired (no refresh token). This job
 * runs on a schedule (Argo CronWorkflow, daily) and, for every connected Meta connector whose token
 * is older than the threshold, exchanges the still-valid long-lived token for a fresh one
 * (fb_exchange_token) and writes it back — so a brand's spend ingestion never silently dies on a
 * weekend token expiry. The reactive 401 path (meta-spend-repull) stays RECONNECT_REQUIRED for a
 * token that is already dead.
 *
 * Enumerate via the SAME SECURITY DEFINER fn the spend repull uses (list_ad_connectors_for_spend_repull,
 * NO GUC at enumerate time — system-job-force-rls-enumeration). Secret read/write mirrors the repull's
 * dev_secret-direct path (dev-honesty boundary); the prod seam is AwsSecretsManager PutSecretValue
 * (noted below). Tokens are NEVER logged (I-S09) — only provider + connector id.
 *
 * Observability (the stakeholder surface — a token-refresh job has no tenant UI): emits
 * meta_token_refresh_{total,error,skipped}_total{...} feeding BrainMetaTokenRefreshFailing; a refresh
 * failure also flips connector_sync_status so the connector-health UI shows RECONNECT_REQUIRED.
 */
import { Pool } from 'pg';
import { incrementCounter } from '@brain/observability';
import { enumerateConnectors, setSyncState } from '../meta-spend-repull/run.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import {
  exchangeLongLivedToken,
  isTokenRefreshDue,
  DEFAULT_REFRESH_AGE_DAYS,
  META_APP_CREDS_MISSING,
} from './meta-token-client.js';
import { log } from '../../log.js';
import type { ISecretsManager } from '@brain/connector-secrets';

/** Dev secret bundle for a Meta connector (extends the repull's bundle with the issued-at clock). */
interface MetaSecretBundle {
  access_token: string; // NEVER logged (I-S09)
  ad_account_id?: string;
  access_token_issued_at?: string; // ISO-8601; absent on legacy tokens → treated as due
}

export interface MetaTokenRefreshReport {
  scanned: number;
  refreshed: number;
  skippedNotDue: number;
  reconnectRequired: number;
  errors: number;
}

/** Read a meta connector's dev_secret bundle (mirrors resolveMetaCredentials). */
async function readBundle(pool: Pool, secretRef: string): Promise<MetaSecretBundle | null> {
  const name = secretRef.split(':secret:')[1] ?? secretRef;
  const res = await pool.query<{ secret_value: string }>(
    `SELECT secret_value FROM dev_secret WHERE name = $1`,
    [name],
  );
  const raw = res.rows[0]?.secret_value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MetaSecretBundle;
  } catch {
    return null;
  }
}

/**
 * Write the refreshed bundle back.
 *
 * PROD: uses ISecretsManager.putSecretValue(secretRef, bundle) — writes the refreshed token
 *       to AWS Secrets Manager under the same ARN (NN-2: ARN unchanged). Tokens never expire
 *       silently because the write-back keeps the stored token fresh.
 * DEV:  upserts dev_secret (the repull reads it the same way; cross-process durable).
 *
 * I-S09: bundle values are NEVER logged.
 */
async function writeBundle(
  pool: Pool,
  secretRef: string,
  bundle: MetaSecretBundle,
  secretsManager?: ISecretsManager,
): Promise<void> {
  if (secretsManager) {
    // PROD seam: PutSecretValue on the existing ARN — preserves the ARN stored in
    // connector_instance.secret_ref (NN-2). putSecretValue is the UPSERT from sub-fix 1.
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

/**
 * Run one refresh pass. Exported + parameterised (nowMs, fetchImpl, secretsManager) for deterministic tests.
 *
 * @param pool           brain_app pool (enumerate is SECURITY DEFINER; dev_secret read/write is system).
 * @param nowMs          current time (injectable).
 * @param thresholdDays  age at which a token is re-exchanged.
 * @param fetchImpl      fetch implementation (injectable for tests).
 * @param secretsManager optional ISecretsManager for prod write-back. When provided (prod),
 *                       the refreshed bundle is written to AWS Secrets Manager via putSecretValue.
 *                       When absent (dev), the bundle is written to dev_secret as before.
 */
export async function runMetaTokenRefresh(
  pool: Pool,
  nowMs: number = Date.now(),
  thresholdDays: number = DEFAULT_REFRESH_AGE_DAYS,
  fetchImpl: typeof fetch = fetch,
  secretsManager?: ISecretsManager,
): Promise<MetaTokenRefreshReport> {
  const report: MetaTokenRefreshReport = {
    scanned: 0,
    refreshed: 0,
    skippedNotDue: 0,
    reconnectRequired: 0,
    errors: 0,
  };

  const connectors = (await enumerateConnectors(pool)).filter((c) => c.provider === 'meta');

  for (const c of connectors) {
    report.scanned += 1;
    const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = c;
    try {
      const bundle = await readBundle(pool, secretRef);
      if (!bundle?.access_token) {
        // No token to exchange → already needs a reconnect; nothing to refresh.
        report.reconnectRequired += 1;
        continue;
      }
      if (!isTokenRefreshDue(bundle.access_token_issued_at, nowMs, thresholdDays)) {
        report.skippedNotDue += 1;
        incrementCounter('meta_token_refresh_skipped_total', { reason: 'not_due' });
        continue;
      }

      try {
        const { accessToken } = await exchangeLongLivedToken(bundle.access_token, fetchImpl);
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
        incrementCounter('meta_token_refresh_total', { provider: 'meta' });
        log.info(`[meta-token-refresh] refreshed connector=${ciId} brand=${brandId}`);
      } catch (err) {
        const msg = String(err);
        if (msg.includes(META_APP_CREDS_MISSING)) {
          // App creds missing is an OPS misconfig, not a per-connector failure — count + stop early.
          report.errors += 1;
          incrementCounter('meta_token_refresh_error_total', { reason: 'app_creds_missing' });
          log.error('[meta-token-refresh] META_APP_ID / META_APP_SECRET not configured — aborting pass');
          return report;
        }
        // Exchange failed → the token cannot be extended (expired/invalid) → RECONNECT_REQUIRED.
        report.reconnectRequired += 1;
        recordConnectorAuthRejected('meta');
        await setSyncState(pool, brandId, ciId, 'error', 'meta token refresh failed — RECONNECT_REQUIRED');
        incrementCounter('meta_token_refresh_error_total', { reason: 'exchange_failed' });
        log.warn(`[meta-token-refresh] exchange failed connector=${ciId} — RECONNECT_REQUIRED`);
      }
    } catch (err) {
      report.errors += 1;
      incrementCounter('meta_token_refresh_error_total', { reason: 'unexpected' });
      log.error(`[meta-token-refresh] unexpected error connector=${ciId}`, { err });
    }
  }

  log.info(
    `[meta-token-refresh] pass done scanned=${report.scanned} refreshed=${report.refreshed} ` +
      `skipped=${report.skippedNotDue} reconnect=${report.reconnectRequired} errors=${report.errors}`,
  );
  return report;
}

// Standalone entrypoint (Argo CronWorkflow: `node dist/jobs/meta-token-refresh/run.js`).
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbUrl = process.env['BRAIN_APP_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
  const pool = new Pool({ connectionString: dbUrl, max: 2 });

  // PROD write-back seam (sub-fix 4): wire AwsSecretsManager so refreshed tokens are written
  // to Secrets Manager (not just dev_secret). Requires CONNECTOR_SECRETS_KMS_KEY_ID in prod.
  // In dev SHOPIFY_CLIENT_SECRET is absent → secretsMgr is undefined → dev_secret path.
  let secretsMgr: ISecretsManager | undefined;
  const isProductionEnv = process.env['NODE_ENV'] === 'production';
  if (isProductionEnv) {
    const { AwsSecretsManager } = await import('@brain/connector-secrets');
    const region = process.env['AWS_REGION'] ?? 'us-east-1';
    const clientSecretArn = process.env['SHOPIFY_CLIENT_SECRET'] ?? '';
    const kmsKeyId = process.env['CONNECTOR_SECRETS_KMS_KEY_ID'] ?? '';
    if (!clientSecretArn || !kmsKeyId) {
      log.error('[meta-token-refresh] FATAL: SHOPIFY_CLIENT_SECRET + CONNECTOR_SECRETS_KMS_KEY_ID required in prod for Secrets Manager write-back');
      process.exit(1);
    }
    secretsMgr = new AwsSecretsManager(region, clientSecretArn, kmsKeyId);
  }

  runMetaTokenRefresh(pool, Date.now(), DEFAULT_REFRESH_AGE_DAYS, fetch, secretsMgr)
    .then((r) => { void pool.end(); process.exit(r.errors > 0 ? 1 : 0); })
    .catch((err) => { log.error('[meta-token-refresh] fatal', { err }); void pool.end(); process.exit(1); });
}
