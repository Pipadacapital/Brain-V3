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
 */

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
    // Prod: delegate to the full AwsSecretsManager
    // Import dynamically to avoid loading AWS SDK in dev
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AwsSecretsManager } = require('../../../../../../apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/AwsSecretsManager.js') as typeof import('../../../../../core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/AwsSecretsManager.js');
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
class WorkerLocalSecretsManager implements WorkerSecretsManager {
  async getShopifyToken(secretRef: string): Promise<string | null> {
    // First try: simple SHOPIFY_ACCESS_TOKEN override (works for single-brand dev)
    const directToken = process.env['SHOPIFY_ACCESS_TOKEN'];
    if (directToken) {
      // Token NEVER logged (I-S09)
      return directToken;
    }

    // Second try: extract brandId from ARN → SHOPIFY_DEV_TOKEN_{BRAND_NO_DASHES_UPPER}
    // ARN format: ...secret:brain/connector/shopify/{brandId}/{shopDomain}
    const match = secretRef.match(/brain\/connector\/shopify\/([0-9a-f-]{36})\//i);
    if (match?.[1]) {
      const brandId = match[1];
      const envKey = `SHOPIFY_DEV_TOKEN_${brandId.replace(/-/g, '').toUpperCase()}`;
      const brandToken = process.env[envKey];
      if (brandToken) {
        return brandToken;
      }
    }

    // Not found → null → job will mark failed with RECONNECT_REQUIRED (D-7/SP-3)
    return null;
  }
}
