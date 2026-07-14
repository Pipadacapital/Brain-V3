/**
 * @brain/connector-secrets — shared connector secrets abstraction.
 *
 * Lives in a workspace package (NOT inside apps/core) because BOTH deployables need it: apps/core
 * writes/reads connector credentials, and apps/stream-worker's backfill job reads the Shopify token.
 * The prod AwsSecretsManager binds each secret to a per-brand KMS EncryptionContext — the read path
 * MUST pass the identical context the write path used, so the two deployables share ONE
 * implementation rather than risk drift between duplicates (#75: this replaces the fragile
 * cross-package require() that reached into apps/core's source tree).
 *
 * The control-plane builder (main.ts) selects the implementation based on environment:
 *
 *   import { AwsSecretsManager, LocalSecretsManager } from '@brain/connector-secrets';
 *
 *   const secretsManager: ISecretsManager = isProduction
 *     ? new AwsSecretsManager(getEnv('AWS_REGION', 'us-east-1'), getEnvOrThrow('SHOPIFY_CLIENT_SECRET'))
 *     : new LocalSecretsManager();
 *
 * In production:
 *   - SHOPIFY_CLIENT_SECRET env var holds the ARN (not the value).
 *   - AwsSecretsManager fetches the value at call time via IRSA. Fail-closed.
 *
 * In development:
 *   - SHOPIFY_CLIENT_SECRET env var holds the raw value.
 *   - LocalSecretsManager reads it directly (dev-only, never in prod images).
 *
 * HIGH-SECRETS-01-RESIDUAL: AwsSecretsManager is the production implementation.
 * I-S09: secret values are never stored in env vars or code in production.
 */
export { AwsSecretsManager } from './AwsSecretsManager.js';
export { LocalSecretsManager } from './LocalSecretsManager.js';
export type { ISecretsManager, SecretWriteResult } from './ISecretsManager.js';
export { unwrapShopifyTokenValue } from './ISecretsManager.js';
