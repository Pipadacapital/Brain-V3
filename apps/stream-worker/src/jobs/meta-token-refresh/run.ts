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
import { recoverConnectorInstanceHealth } from '../../infrastructure/pg/ConnectorInstanceHealthRepository.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import {
  exchangeLongLivedToken,
  isTokenRefreshDue,
  isTokenExpiringSoon,
  expiresAtFromSeconds,
  DEFAULT_REFRESH_AGE_DAYS,
  META_APP_CREDS_MISSING,
} from './meta-token-client.js';
import { log } from '../../log.js';
import type { ISecretsManager } from '@brain/connector-secrets';

/** Dev secret bundle for a Meta connector (extends the repull's bundle with the issued-at clock). */
interface MetaSecretBundle {
  access_token: string; // NEVER logged (I-S09)
  ad_account_id?: string;
  access_token_issued_at?: string;  // ISO-8601; absent on legacy tokens → treated as due
  access_token_expires_at?: string; // ISO-8601; stamped from the exchange's expires_in (A2 expiry hardening)
  /**
   * 'system_user' = a never-expiring system-user token (ConnectMetaWithSystemUserTokenCommand).
   * The refresh pass SKIPS these: there is nothing to re-exchange (fb_exchange_token is for user
   * tokens and would fail), and the issued-at clock would otherwise mark them due forever.
   */
  token_type?: string;
}

export interface MetaTokenRefreshReport {
  scanned: number;
  refreshed: number;
  skippedNotDue: number;
  /** System-user (never-expiring) tokens skipped — healthy, not an error (bundle token_type flag). */
  skippedSystemUser: number;
  reconnectRequired: number;
  errors: number;
}

/**
 * Read a meta connector's stored token bundle.
 *
 * PROD seam (the review's HIGH "readBundle has no prod seam → silent ~60-day death" finding):
 *   when a secretsManager is provided (prod), the bundle is read from AWS Secrets Manager via
 *   getSecret(secretRef) — the SAME ARN the spend repull's resolveMetaCredentials reads. Without
 *   this, in prod the refresh job read dev_secret (which does not exist in prod) → ALWAYS null →
 *   every token counted as reconnectRequired and NEVER refreshed → token silently dies at ~60 days.
 * DEV fallback (no secretsManager): read dev_secret (cross-process durable; the repull writes here).
 *
 * I-S09: bundle values are NEVER logged.
 */
async function readBundle(
  pool: Pool,
  secretRef: string,
  secretsManager?: ISecretsManager,
): Promise<MetaSecretBundle | null> {
  if (secretsManager) {
    const sec = await secretsManager.getSecret(secretRef); // GetSecretValue → parsed JSON (honors AWS_ENDPOINT_URL)
    if (!sec || typeof sec['access_token'] !== 'string') return null;
    return sec as unknown as MetaSecretBundle;
  }
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
 * @param targetConnectorInstanceId optional scoping seam: refresh ONLY this meta connector
 *                       (same optional-target contract enumerateConnectors already exposes for
 *                       the spend repull). Default undefined = all activated meta connectors —
 *                       behaviour unchanged for the cron entrypoint. Used by the live test so a
 *                       shared/dirty dev DB's real connectors are never touched by a test pass.
 */
export async function runMetaTokenRefresh(
  pool: Pool,
  nowMs: number = Date.now(),
  thresholdDays: number = DEFAULT_REFRESH_AGE_DAYS,
  fetchImpl: typeof fetch = fetch,
  secretsManager?: ISecretsManager,
  targetConnectorInstanceId?: string,
): Promise<MetaTokenRefreshReport> {
  const report: MetaTokenRefreshReport = {
    scanned: 0,
    refreshed: 0,
    skippedNotDue: 0,
    skippedSystemUser: 0,
    reconnectRequired: 0,
    errors: 0,
  };

  const connectors = (await enumerateConnectors(pool, targetConnectorInstanceId)).filter(
    (c) => c.provider === 'meta',
  );

  for (const c of connectors) {
    report.scanned += 1;
    const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = c;
    try {
      const bundle = await readBundle(pool, secretRef, secretsManager);
      if (!bundle?.access_token) {
        // No token to exchange → already needs a reconnect; nothing to refresh.
        report.reconnectRequired += 1;
        continue;
      }
      // System-user tokens NEVER expire (Meta Business Settings system users) — skip: there is
      // nothing to re-exchange (fb_exchange_token is a user-token grant and fails on them), and the
      // issued-at clock would otherwise flag them due forever → a daily doomed-exchange loop that
      // flips a HEALTHY connector to RECONNECT_REQUIRED. Detected via the bundle flag stamped by
      // ConnectMetaWithSystemUserTokenCommand.
      if (bundle.token_type === 'system_user') {
        report.skippedSystemUser += 1;
        incrementCounter('meta_token_refresh_skipped_total', { reason: 'system_user_token' });
        continue;
      }
      // DUE when the issued-at age crosses the threshold OR a KNOWN expiry is within the refresh margin
      // (the short-lived "looks fresh but dies in ~2h" case the issued-at clock alone cannot catch).
      const due =
        isTokenRefreshDue(bundle.access_token_issued_at, nowMs, thresholdDays) ||
        isTokenExpiringSoon(bundle.access_token_expires_at, nowMs, thresholdDays);
      if (!due) {
        report.skippedNotDue += 1;
        incrementCounter('meta_token_refresh_skipped_total', { reason: 'not_due' });
        continue;
      }

      try {
        const { accessToken, expiresInSeconds } = await exchangeLongLivedToken(bundle.access_token, fetchImpl);
        // Stamp BOTH the issued-at clock and a real expires_at (from Graph's expires_in) so the next
        // pass can fire on imminent expiry, not just on age — closes the silent ~60-day death window.
        const refreshed: MetaSecretBundle = {
          ...bundle,
          access_token: accessToken,
          access_token_issued_at: new Date(nowMs).toISOString(),
        };
        const expiresAt = expiresAtFromSeconds(expiresInSeconds, nowMs);
        if (expiresAt) refreshed.access_token_expires_at = expiresAt;
        await writeBundle(pool, secretRef, refreshed, secretsManager);
        report.refreshed += 1;
        // Recovery edge: a successful token exchange cures a TokenExpired badge — self-heal back to
        // Healthy/safe now (no-op if already Healthy or in a sticky state).
        await recoverConnectorInstanceHealth(pool, brandId, ciId).catch(() => undefined);
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
      `skipped=${report.skippedNotDue} systemUser=${report.skippedSystemUser} ` +
      `reconnect=${report.reconnectRequired} errors=${report.errors}`,
  );
  return report;
}

// Standalone entrypoint (Argo CronWorkflow: `node dist/jobs/meta-token-refresh/run.js`).
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbUrl = process.env['BRAIN_APP_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
  const pool = new Pool({ connectionString: dbUrl, max: 2 });

  // PROD Secrets-Manager seam: wire AwsSecretsManager so the refresh job READS the stored token
  // (the prod read-seam fix) AND writes the refreshed token back to the SAME ARN — not just dev_secret.
  //
  // Connector-neutral (the review's MED "Meta refresh FATAL-exits on Shopify env state" finding):
  // the former code keyed prod activation on SHOPIFY_CLIENT_SECRET, so a Meta-only tenant with no
  // Shopify connector FATAL-exited the Meta refresh. AwsSecretsManager's clientSecretArn is only used
  // by the Shopify-specific getShopifyClientSecret() path — never by getSecret/putSecretValue — so we
  // pass '' and gate solely on the KMS key (mirrors meta-spend-repull/resolveMetaCredentials).
  // In dev (NODE_ENV != production) secretsMgr stays undefined → dev_secret read/write path.
  let secretsMgr: ISecretsManager | undefined;
  const isProductionEnv = process.env['NODE_ENV'] === 'production';
  if (isProductionEnv) {
    const { AwsSecretsManager } = await import('@brain/connector-secrets');
    const region = process.env['BRAIN_AWS_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1';
    const kmsKeyId = process.env['CONNECTOR_SECRETS_KMS_KEY_ID'] ?? process.env['KMS_KEY_ID'] ?? '';
    if (!kmsKeyId) {
      log.error('[meta-token-refresh] FATAL: CONNECTOR_SECRETS_KMS_KEY_ID required in prod for Secrets Manager read/write-back');
      process.exit(1);
    }
    secretsMgr = new AwsSecretsManager(region, '', kmsKeyId);
  }

  runMetaTokenRefresh(pool, Date.now(), DEFAULT_REFRESH_AGE_DAYS, fetch, secretsMgr)
    .then((r) => { void pool.end(); process.exit(r.errors > 0 ? 1 : 0); })
    .catch((err) => { log.error('[meta-token-refresh] fatal', { err }); void pool.end(); process.exit(1); });
}
