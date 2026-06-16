/**
 * AwsSecretsManager — production implementation of ISecretsManager.
 *
 * Fetches and stores Shopify OAuth credentials in AWS Secrets Manager using
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
 * FAIL-CLOSED: if any Secrets Manager call fails, the error propagates and
 * the caller must abort the operation (never fall back to a plain env read).
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import type { ISecretsManager, SecretWriteResult } from './ISecretsManager.js';

export class AwsSecretsManager implements ISecretsManager {
  private readonly client: SecretsManagerClient;
  private readonly clientSecretArn: string;

  /**
   * @param region           AWS region (default: AWS_REGION env var or us-east-1).
   * @param clientSecretArn  ARN (or name) of the Shopify client secret in Secrets Manager.
   *                         In production: value of SHOPIFY_CLIENT_SECRET env var.
   */
  constructor(region: string, clientSecretArn: string) {
    // SDK picks up IRSA credentials automatically via web-identity token file.
    this.client = new SecretsManagerClient({ region });
    this.clientSecretArn = clientSecretArn;
  }

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
          // Tags allow cost attribution and audit filtering.
          Tags: [
            { Key: 'brand_id', Value: brandId },
            { Key: 'shop_domain', Value: shopDomain },
            { Key: 'managed_by', Value: 'brain-core' },
          ],
        }),
      );
    } catch (err) {
      // Fail-closed: never fall back. Token is not written if this throws.
      throw new Error(
        `[AwsSecretsManager] Failed to store Shopify token for brand ${brandId}: ${err instanceof Error ? err.message : String(err)}`,
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
      // Value is NEVER logged (I-S09).
      return response.SecretString ?? null;
    } catch (err) {
      throw new Error(
        `[AwsSecretsManager] Failed to fetch Shopify token "${secretRef}": ${err instanceof Error ? err.message : String(err)}`,
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
