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
import type { Pool } from 'pg';

export class LocalSecretsManager implements ISecretsManager {
  /**
   * @param pool  Optional pg Pool. When provided (DEV-TOKEN-REACH / migration 0024), secrets are
   *   ALSO persisted to the dev_secret table so they (a) survive a core restart and (b) are
   *   readable by the separate stream-worker process. The in-memory Map stays as an L1 cache.
   *   When omitted (e.g. unit tests), behaviour is the original in-memory-only store.
   */
  constructor(private readonly pool?: Pool) {
    // D-7: Hard-fail if instantiated in production (belt-and-suspenders).
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        '[LocalSecretsManager] FATAL: LocalSecretsManager must not be instantiated in production. ' +
          'Use AwsSecretsManager. Check the composition root in main.ts.',
      );
    }
  }

  // In-memory L1 cache for dev. Keyed by secret name. Durable layer is dev_secret (when pool set).
  private readonly store = new Map<string, string>();

  /** DEV-TOKEN-REACH: durable + cross-process upsert into dev_secret. Never logs the value. */
  private async devPersist(name: string, value: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO dev_secret (name, secret_value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET secret_value = EXCLUDED.secret_value, updated_at = NOW()`,
      [name, value],
    );
  }

  /** DEV-TOKEN-REACH: read a secret value from dev_secret (cross-process / post-restart). */
  private async devRead(name: string): Promise<string | null> {
    if (!this.pool) return null;
    const res = await this.pool.query<{ secret_value: string }>(
      `SELECT secret_value FROM dev_secret WHERE name = $1`,
      [name],
    );
    return res.rows[0]?.secret_value ?? null;
  }

  /** DEV-TOKEN-REACH: delete a secret from dev_secret (on disconnect). */
  private async devDelete(name: string): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`DELETE FROM dev_secret WHERE name = $1`, [name]);
  }

  // ── Generic methods (ADR-CM-4) ───────────────────────────────────────────────

  async storeSecret(
    brandId: string,
    connectorRef: ConnectorSecretRef,
    credential: Record<string, string>,
  ): Promise<SecretWriteResult> {
    const subKey = connectorRef.subKey ? `/${connectorRef.subKey.replace(/\./g, '-')}` : '';
    const name = `brain/connector/${connectorRef.connectorType}/${brandId}${subKey}`;
    const json = JSON.stringify(credential);
    this.store.set(name, json);
    await this.devPersist(name, json); // DEV-TOKEN-REACH: durable + cross-process
    const arn = `arn:aws:secretsmanager:us-east-1:000000000000:secret:${name}`;
    return { arn, name };
  }

  async getSecret(secretArn: string): Promise<Record<string, string> | null> {
    const name = secretArn.split(':secret:')[1] ?? secretArn;
    const raw = this.store.get(name) ?? (await this.devRead(name)); // L1 cache → durable dev_secret
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
    await this.devDelete(name); // DEV-TOKEN-REACH
  }

  async putSecretValue(
    secretArn: string,
    credential: Record<string, string>,
  ): Promise<void> {
    // I-S09: credential values are NEVER logged.
    const name = secretArn.split(':secret:')[1] ?? secretArn;
    const json = JSON.stringify(credential);
    this.store.set(name, json);
    await this.devPersist(name, json); // DEV-TOKEN-REACH: durable + cross-process
  }

  // ── Shopify-specific methods (back-compat — unused by new generic code) ───────

  async storeShopifyToken(
    brandId: string,
    shopDomain: string,
    accessToken: string,
  ): Promise<SecretWriteResult> {
    const name = `brain/connector/shopify/${brandId}/${shopDomain.replace(/\./g, '-')}`;
    this.store.set(name, accessToken);
    await this.devPersist(name, accessToken); // DEV-TOKEN-REACH: durable + worker-readable
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
      await this.devDelete(parts[1]); // DEV-TOKEN-REACH
    }
  }

  async getShopifyToken(secretRef: string): Promise<string | null> {
    // secret_ref is the fake ARN from storeShopifyToken; the name follows `:secret:`.
    // DEV-TOKEN-REACH: L1 in-memory cache → durable dev_secret (survives restart, cross-process).
    const name = secretRef.split(':secret:')[1] ?? secretRef;
    return this.store.get(name) ?? (await this.devRead(name));
  }
}
