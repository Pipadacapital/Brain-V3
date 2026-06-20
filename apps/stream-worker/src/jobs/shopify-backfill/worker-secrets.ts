/**
 * worker-secrets.ts — ISecretsManager seam for the backfill worker (ADR-BF-11).
 *
 * The backfill worker runs in stream-worker, a SEPARATE PROCESS from apps/core.
 * Core's LocalSecretsManager holds tokens in an in-memory Map that is invisible
 * across process boundaries. This is the ADR-BF-11 cross-process problem.
 *
 * Resolution:
 *   PROD: The worker instantiates its own AwsSecretsManager using the same IRSA
 *   credentials as core. Durable, shared, no restart problem.
 *
 *   DEV: The worker reads the token via a dev-convention env-var path. The
 *   LocalSecretsManager (in core) stores tokens keyed by ARN name; the ARN name
 *   follows the pattern `brain/connector/shopify/${brandId}/${shopDomain}`.
 *   In dev, the worker reads SHOPIFY_DEV_TOKEN_{BRAND_ID_NO_DASHES_UPPER} env var
 *   as a fallback (the brand reconnects once, the test suite sets the env var,
 *   or the trigger returns 409 RECONNECT_REQUIRED if absent — D-7).
 *
 *   NULL result: if the worker cannot resolve the token (null return), the job
 *   is marked failed with failure_reason='RECONNECT_REQUIRED' (SP-3 checkpoint).
 *   The cursor is preserved for resume after reconnect.
 *
 * Token is NEVER logged (I-S09). Log only secret_ref / ARN (safe to log).
 *
 * #75: the prod AwsSecretsManager is imported from the shared @brain/connector-secrets workspace
 * package — NOT via a relative require() reaching into apps/core's source tree (which resolved
 * outside the deployed bundle → MODULE_NOT_FOUND in prod, and hid an undeclared @aws-sdk
 * dependency). Both deployables now share ONE implementation, so the worker's READ path uses the
 * exact same per-brand KMS EncryptionContext core's WRITE path binds — no decryption drift.
 */
import { AwsSecretsManager } from '@brain/connector-secrets';

/** Minimal secrets interface for the worker (subset of ISecretsManager) */
export interface WorkerSecretsManager {
  getShopifyToken(secretRef: string): Promise<string | null>;
}

/**
 * Build the worker's ISecretsManager based on environment.
 * PROD: AwsSecretsManager (injected via env vars BRAIN_AWS_REGION / SHOPIFY_CLIENT_SECRET_ARN / KMS_KEY_ID).
 * DEV: WorkerLocalSecretsManager (reads from env vars + dev fallback).
 */
export function buildWorkerSecretsManager(): WorkerSecretsManager {
  if (process.env['NODE_ENV'] === 'production') {
    // Prod: delegate to the shared AwsSecretsManager (@brain/connector-secrets). It implements the
    // full ISecretsManager — including getShopifyToken — so it satisfies WorkerSecretsManager.
    const region = process.env['BRAIN_AWS_REGION'] ?? 'us-east-1';
    const clientSecretArn = process.env['SHOPIFY_CLIENT_SECRET_ARN'] ?? '';
    const kmsKeyId = process.env['KMS_KEY_ID'] ?? '';
    if (!kmsKeyId) throw new Error('[worker-secrets] KMS_KEY_ID env var required in production');
    return new AwsSecretsManager(region, clientSecretArn, kmsKeyId);
  }

  // Dev: use WorkerLocalSecretsManager (env-var backed, no in-memory dependency on core)
  return new WorkerLocalSecretsManager();
}

/**
 * Dev-only: resolve the Shopify token from environment variables.
 *
 * Lookup order:
 *  1. SHOPIFY_ACCESS_TOKEN env var (simplest dev override — set once after OAuth)
 *  2. SHOPIFY_DEV_TOKEN_{BRAND_ID_NO_DASHES_UPPER} (per-brand dev token)
 *  3. null → job fails with RECONNECT_REQUIRED (D-7 reconnect protocol)
 *
 * The secret_ref (ARN) structure is:
 *   arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/{brandId}/{shopDomain}
 * We extract brandId from the ARN to look up the per-brand env var.
 *
 * Note: this implementation is dev-only. In prod, AwsSecretsManager is used.
 */
import pg from 'pg';

export class WorkerLocalSecretsManager implements WorkerSecretsManager {
  constructor() {
    // SEC-CLR-MED-01: hard-fail if instantiated in production (belt-and-suspenders), mirroring
    // core's LocalSecretsManager. buildWorkerSecretsManager() already branches to AwsSecretsManager
    // in prod; this guard defends against a future direct-instantiation bypassing the factory.
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        '[WorkerLocalSecretsManager] FATAL: must not be instantiated in production. ' +
          'Use AwsSecretsManager via buildWorkerSecretsManager().',
      );
    }
  }

  // Lazily-created pool for reading the DEV-TOKEN-REACH dev_secret table (migration 0024).
  // The worker connects as brain_app, which is GRANTed SELECT on dev_secret.
  private devPool: pg.Pool | undefined;

  private getDevPool(): pg.Pool {
    if (!this.devPool) {
      // Safe localhost brain_app default (mirrors apps/stream-worker/src/main.ts:50): a
      // missing env must NEVER yield undefined → the dev_secret token read always reaches
      // Postgres. MUST be brain_app (RLS enforced) — never superuser 'brain'.
      const connectionString =
        process.env['BRAIN_APP_DATABASE_URL'] ??
        process.env['DATABASE_URL'] ??
        'postgres://brain_app:brain_app@localhost:5432/brain';
      this.devPool = new pg.Pool({ connectionString, max: 2 });
    }
    return this.devPool;
  }

  async getShopifyToken(secretRef: string): Promise<string | null> {
    // 1) Explicit dev override (handy for tests / single-brand): SHOPIFY_ACCESS_TOKEN.
    const directToken = process.env['SHOPIFY_ACCESS_TOKEN'];
    if (directToken) {
      return directToken; // Token NEVER logged (I-S09)
    }

    // 2) DEV-TOKEN-REACH (0024): the durable dev_secret store core writes on OAuth connect.
    //    Survives a core restart and is readable cross-process. This is the primary dev path.
    //    secret_ref ARN → the dev_secret name is the segment after ':secret:'.
    const name = secretRef.split(':secret:')[1] ?? secretRef;
    try {
      const res = await this.getDevPool().query<{ secret_value: string }>(
        `SELECT secret_value FROM dev_secret WHERE name = $1`,
        [name],
      );
      if (res.rows[0]?.secret_value) {
        return res.rows[0].secret_value; // NEVER logged (I-S09)
      }
    } catch {
      // dev_secret unavailable (e.g. migration not applied) — fall through to the env fallback.
    }

    // 3) Per-brand env fallback: SHOPIFY_DEV_TOKEN_{BRAND_NO_DASHES_UPPER}.
    const match = secretRef.match(/brain\/connector\/shopify\/([0-9a-f-]{36})\//i);
    if (match?.[1]) {
      const envKey = `SHOPIFY_DEV_TOKEN_${match[1].replace(/-/g, '').toUpperCase()}`;
      const brandToken = process.env[envKey];
      if (brandToken) {
        return brandToken;
      }
    }

    // 4) Not found → null → job marks failed with RECONNECT_REQUIRED (D-7/SP-3).
    return null;
  }
}
