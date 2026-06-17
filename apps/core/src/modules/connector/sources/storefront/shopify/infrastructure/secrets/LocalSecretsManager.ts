/**
 * LocalSecretsManager — dev/test stub for ISecretsManager.
 *
 * Returns fake ARNs of the form `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/...`
 * so that NN-2 enforcement (secret_ref is a non-empty ARN) is testable locally
 * without a real AWS account.
 *
 * In production this is replaced by AwsSecretsManager (backed by the AWS SDK).
 *
 * D-7 (feat-connector-marketplace A2): HARD-FAILS if instantiated in production.
 * The composition root in main.ts only imports LocalSecretsManager outside production;
 * this runtime guard is the belt-and-suspenders check.
 *
 * SECURITY NOTE: This implementation LOGS that a token was stored but NEVER logs
 * the token value itself (I-S09). In tests, tokens are discarded after the call.
 */
import type {
  ISecretsManager,
  SecretWriteResult,
  ConnectorSecretRef,
} from './ISecretsManager.js';

export class LocalSecretsManager implements ISecretsManager {
  constructor() {
    // D-7: Hard-fail if instantiated in production (belt-and-suspenders).
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        '[LocalSecretsManager] FATAL: LocalSecretsManager must not be instantiated in production. ' +
          'Use AwsSecretsManager. Check the composition root in main.ts.',
      );
    }
  }

  // In-memory store for dev. Keyed by secret name.
  private readonly store = new Map<string, string>();

  // ── Generic methods (ADR-CM-4) ───────────────────────────────────────────────

  async storeSecret(
    brandId: string,
    connectorRef: ConnectorSecretRef,
    credential: Record<string, string>,
  ): Promise<SecretWriteResult> {
    const subKey = connectorRef.subKey ? `/${connectorRef.subKey.replace(/\./g, '-')}` : '';
    const name = `brain/connector/${connectorRef.connectorType}/${brandId}${subKey}`;
    // Store as JSON in memory (dev only — never in Postgres).
    this.store.set(name, JSON.stringify(credential));
    const arn = `arn:aws:secretsmanager:us-east-1:000000000000:secret:${name}`;
    return { arn, name };
  }

  async getSecret(secretArn: string): Promise<Record<string, string> | null> {
    const name = secretArn.split(':secret:')[1] ?? secretArn;
    const raw = this.store.get(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      // Fallback for non-JSON stored values (e.g. plain tokens stored via Shopify path)
      return { value: raw };
    }
  }

  async deleteSecret(secretArn: string): Promise<void> {
    const name = secretArn.split(':secret:')[1] ?? secretArn;
    this.store.delete(name);
  }

  // ── Shopify-specific methods (back-compat — unused by new generic code) ───────

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

  async getShopifyToken(secretRef: string): Promise<string | null> {
    // secret_ref is the fake ARN from storeShopifyToken; the name follows `:secret:`.
    // NOTE: dev-only in-memory store — a process restart loses the token (reconnect needed).
    const name = secretRef.split(':secret:')[1] ?? secretRef;
    return this.store.get(name) ?? null;
  }
}
