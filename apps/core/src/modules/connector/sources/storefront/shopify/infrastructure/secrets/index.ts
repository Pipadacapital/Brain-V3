/**
 * Barrel export for the connector secrets infrastructure.
 *
 * The control-plane builder (main.ts) selects the implementation based on environment:
 *
 *   import { AwsSecretsManager, LocalSecretsManager } from './infrastructure/secrets/index.js';
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
