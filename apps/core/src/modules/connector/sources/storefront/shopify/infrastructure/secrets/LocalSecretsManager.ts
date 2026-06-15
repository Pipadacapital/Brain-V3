/**
 * LocalSecretsManager — dev/test stub for ISecretsManager.
 *
 * Returns fake ARNs of the form `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/...`
 * so that NN-2 enforcement (secret_ref is a non-empty ARN) is testable locally
 * without a real AWS account.
 *
 * In production this is replaced by AwsSecretsManager (backed by the AWS SDK).
 *
 * SECURITY NOTE: This implementation LOGS that a token was stored but NEVER logs
 * the token value itself (I-S09). In tests, tokens are discarded after the call.
 */
import type { ISecretsManager, SecretWriteResult } from './ISecretsManager.js';

export class LocalSecretsManager implements ISecretsManager {
  // In-memory store for dev. Keyed by secret name.
  private readonly store = new Map<string, string>();

  async storeShopifyToken(
    brandId: string,
    shopDomain: string,
    accessToken: string,
  ): Promise<SecretWriteResult> {
    const name = `brain/connector/shopify/${brandId}/${shopDomain.replace(/\./g, '-')}`;
    // Store value in memory (dev only — never in Postgres).
    this.store.set(name, accessToken);
    const arn = `arn:aws:secretsmanager:us-east-1:000000000000:secret:${name}`;
    return { arn, name };
  }

  async getShopifyClientSecret(): Promise<string> {
    // In dev, fall back to env (allowed in non-production only).
    const secret = process.env['SHOPIFY_CLIENT_SECRET'];
    if (!secret) {
      throw new Error(
        '[LocalSecretsManager] SHOPIFY_CLIENT_SECRET env var not set. ' +
          'Set it for local dev or use a LocalStack-backed secret.',
      );
    }
    return secret;
  }

  async deleteShopifyToken(secretArn: string): Promise<void> {
    // Extract name from ARN to remove from local store.
    const parts = secretArn.split(':secret:');
    if (parts[1]) {
      this.store.delete(parts[1]);
    }
  }
}
