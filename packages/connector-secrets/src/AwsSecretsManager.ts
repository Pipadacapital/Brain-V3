/**
 * AwsSecretsManager — production implementation of ISecretsManager.
 *
 * Fetches and stores connector credentials in AWS Secrets Manager using
 * IRSA credentials (no static AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
 * The SDK reads credentials from the IRSA token file automatically.
 *
 * I-S09 / NN-2:
 *   - The Shopify client secret is never stored in env vars or code in production.
 *     The env var SHOPIFY_CLIENT_SECRET holds the ARN in production; this class
 *     fetches the value at call time.
 *   - Access tokens are stored per-brand in a namespaced path and the ARN is
 *     returned for storage in connector_instance.secret_ref (NN-2).
 *   - Secret values are NEVER logged (I-S09).
 *
 * D-7/ADR-CM-4 (HIGH-01 fix): every storeSecret / storeShopifyToken call passes
 * KmsKeyId (a customer-managed CMK injected from the composition root). Secrets
 * Manager uses the CMK for envelope encryption; IAM/key-policy on the CMK provides
 * per-brand decryption isolation — an ARN leak alone is insufficient to decrypt
 * without the appropriate key-policy permission.
 *
 * NOTE: AWS Secrets Manager's CreateSecret and GetSecretValue APIs do not accept a
 * caller-supplied EncryptionContext parameter — the service derives its own internal
 * context. The structural isolation guarantee comes from the CMK binding (KmsKeyId).
 * The Tags (brand_id, connector_type) provide auditable metadata attribution.
 *
 * FAIL-CLOSED: if any Secrets Manager call fails, the error propagates and
 * the caller must abort the operation (never fall back to a plain env read).
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  ResourceExistsException,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import type {
  ISecretsManager,
  SecretWriteResult,
  ConnectorSecretRef,
} from './ISecretsManager.js';
import { sanitizeSecretSubKey, unwrapShopifyTokenValue } from './ISecretsManager.js';

export class AwsSecretsManager implements ISecretsManager {
  private readonly client: SecretsManagerClient;
  private readonly clientSecretArn: string;
  private readonly kmsKeyId: string;

  /**
   * @param region           AWS region (default: AWS_REGION env var or us-east-1).
   * @param clientSecretArn  ARN (or name) of the Shopify client secret in Secrets Manager.
   *                         In production: value of SHOPIFY_CLIENT_SECRET env var.
   * @param kmsKeyId         ARN or alias of the customer-managed KMS key used for
   *                         per-brand secret encryption (D-7/ADR-CM-4). Injected from
   *                         the composition root; the root hard-fails at startup if this
   *                         is absent in production. Using a CMK (not the AWS-managed default
   *                         key) enables key-policy-level per-brand decryption isolation.
   */
  constructor(region: string, clientSecretArn: string, kmsKeyId: string) {
    // SDK picks up IRSA credentials automatically via web-identity token file.
    this.client = new SecretsManagerClient({ region });
    this.clientSecretArn = clientSecretArn;
    this.kmsKeyId = kmsKeyId;
  }

  // ── Generic methods (ADR-CM-4 / D-3) ────────────────────────────────────────

  async storeSecret(
    brandId: string,
    connectorRef: ConnectorSecretRef,
    credential: Record<string, string>,
  ): Promise<SecretWriteResult> {
    const subKey = connectorRef.subKey ? `/${sanitizeSecretSubKey(connectorRef.subKey)}` : '';
    const name = `brain/connector/${connectorRef.connectorType}/${brandId}${subKey}`;
    const secretString = JSON.stringify(credential);

    // UPSERT: attempt Create; on ResourceExistsException (reconnect / repeated call) fall back
    // to PutSecretValue so the ARN is preserved (NN-2: secret_ref in connector_instance must
    // not change on reconnect). I-S09: secret string is never logged.
    try {
      const response = await this.client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: secretString,
          // D-7/ADR-CM-4 (HIGH-01): KmsKeyId binds the secret to a customer-managed CMK.
          // The CMK's key policy enforces per-brand decryption isolation — without IAM
          // permission on this specific CMK, GetSecretValue is denied even with the ARN.
          // Tags carry brand context for audit/cost attribution (not cryptographic).
          KmsKeyId: this.kmsKeyId,
          Tags: [
            { Key: 'brand_id', Value: brandId },
            { Key: 'connector_type', Value: connectorRef.connectorType },
            { Key: 'managed_by', Value: 'brain-core' },
          ],
        }),
      );
      const arn = response.ARN;
      if (!arn) {
        throw new Error(
          `[AwsSecretsManager] CreateSecret returned no ARN for secret "${name}"`,
        );
      }
      return { arn, name };
    } catch (err) {
      // ResourceExistsException → secret already exists (reconnect path). Fall back to
      // PutSecretValue, which updates the value on the existing ARN (NN-2 preserved).
      if (err instanceof ResourceExistsException) {
        const putResponse = await this.client.send(
          new PutSecretValueCommand({
            SecretId: name,
            SecretString: secretString,
          }),
        );
        const arn = putResponse.ARN;
        if (!arn) {
          throw new Error(
            `[AwsSecretsManager] PutSecretValue returned no ARN for secret "${name}"`,
          );
        }
        return { arn, name };
      }
      // MED-03: do not include brand_id in error messages (linked identifier per COMPLIANCE.md).
      throw new Error(
        `[AwsSecretsManager] Failed to store secret for connector ${connectorRef.connectorType}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async putSecretValue(
    secretArn: string,
    credential: Record<string, string>,
  ): Promise<void> {
    // I-S09: credential values are NEVER logged.
    try {
      await this.client.send(
        new PutSecretValueCommand({
          SecretId: secretArn,
          SecretString: JSON.stringify(credential),
        }),
      );
    } catch (err) {
      throw new Error(
        `[AwsSecretsManager] Failed to put secret value for "${secretArn}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getSecret(secretArn: string): Promise<Record<string, string> | null> {
    try {
      const response = await this.client.send(
        new GetSecretValueCommand({ SecretId: secretArn }),
      );
      if (!response.SecretString) return null;
      try {
        return JSON.parse(response.SecretString) as Record<string, string>;
      } catch {
        return { value: response.SecretString };
      }
    } catch (err) {
      throw new Error(
        `[AwsSecretsManager] Failed to fetch secret: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async deleteSecret(secretArn: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteSecretCommand({
          SecretId: secretArn,
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (err) {
      throw new Error(
        `[AwsSecretsManager] Failed to delete secret "${secretArn}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Shopify-specific methods (back-compat — unused by new generic code) ───────

  async storeShopifyToken(
    brandId: string,
    shopDomain: string,
    accessToken: string,
  ): Promise<SecretWriteResult> {
    const name = `brain/connector/shopify/${brandId}/${shopDomain.replace(/\./g, '-')}`;
    let response;
    try {
      response = await this.client.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: accessToken,
          // D-7/ADR-CM-4 (HIGH-01): same CMK binding as storeSecret.
          KmsKeyId: this.kmsKeyId,
          // Tags allow cost attribution and audit filtering.
          Tags: [
            { Key: 'brand_id', Value: brandId },
            { Key: 'connector_type', Value: 'shopify' },
            { Key: 'shop_domain', Value: shopDomain },
            { Key: 'managed_by', Value: 'brain-core' },
          ],
        }),
      );
    } catch (err) {
      // Fail-closed: never fall back. Token is not written if this throws.
      // MED-03: do not include brand_id in error messages.
      throw new Error(
        `[AwsSecretsManager] Failed to store Shopify token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const arn = response.ARN;
    if (!arn) {
      throw new Error(
        `[AwsSecretsManager] CreateSecret returned no ARN for secret "${name}"`,
      );
    }
    // SECURITY: Do NOT log the secret name in a way that reveals the token path to
    // untrusted log consumers. The ARN is safe to log (it identifies the secret, not the value).
    return { arn, name };
  }

  async getShopifyClientSecret(): Promise<string> {
    let response: GetSecretValueCommandOutput;
    try {
      response = await this.client.send(
        new GetSecretValueCommand({ SecretId: this.clientSecretArn }),
      );
    } catch (err) {
      throw new Error(
        `[AwsSecretsManager] Failed to fetch Shopify client secret from "${this.clientSecretArn}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const value = response.SecretString;
    if (!value) {
      throw new Error(
        `[AwsSecretsManager] Shopify client secret at "${this.clientSecretArn}" resolved to an empty value`,
      );
    }
    // Value is NOT logged (I-S09).
    return value;
  }

  async getShopifyToken(secretRef: string): Promise<string | null> {
    try {
      const response = await this.client.send(
        new GetSecretValueCommand({ SecretId: secretRef }),
      );
      // Value is NEVER logged (I-S09). Bundle-aware: the client-credentials connect path stores a
      // JSON bundle ({ access_token, ... }); legacy OAuth connects store the raw token string.
      return response.SecretString == null ? null : unwrapShopifyTokenValue(response.SecretString);
    } catch (err) {
      throw new Error(
        `[AwsSecretsManager] Failed to fetch Shopify token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async deleteShopifyToken(secretArn: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteSecretCommand({
          SecretId: secretArn,
          // Force immediate deletion (no 30-day recovery window for OAuth tokens).
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (err) {
      throw new Error(
        `[AwsSecretsManager] Failed to delete Shopify token "${secretArn}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
