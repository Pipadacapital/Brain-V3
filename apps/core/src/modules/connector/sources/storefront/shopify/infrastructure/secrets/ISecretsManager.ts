/**
 * ISecretsManager — interface for Secrets Manager operations.
 *
 * I-S09: The Shopify OAuth token MUST be stored in Secrets Manager.
 * The returned ARN is the only value stored in connector_instance.secret_ref (NN-2).
 *
 * In production: backed by AWS Secrets Manager.
 * In dev: backed by a LocalStack-compatible stub that returns a fake ARN.
 */

export interface SecretWriteResult {
  /** AWS Secrets Manager ARN — stored in connector_instance.secret_ref (NN-2). */
  arn: string;
  /** Secret name (human-readable; not stored in DB). */
  name: string;
}

export interface ISecretsManager {
  /**
   * Store a Shopify OAuth access token for a brand.
   * Returns the ARN to store in connector_instance.secret_ref.
   * The token value NEVER reaches the caller after this call.
   *
   * @param brandId     Brand UUID (used to namespace the secret name).
   * @param shopDomain  Shopify shop domain (e.g. mystore.myshopify.com).
   * @param accessToken The OAuth access token. Must NOT be logged (I-S09).
   */
  storeShopifyToken(
    brandId: string,
    shopDomain: string,
    accessToken: string,
  ): Promise<SecretWriteResult>;

  /**
   * Retrieve the Shopify client secret from Secrets Manager.
   * Client secret is never stored in env vars or code (NN-4 / I-S09).
   */
  getShopifyClientSecret(): Promise<string>;

  /**
   * Delete a brand's Shopify token (called on disconnect).
   * @param secretArn  The ARN stored in connector_instance.secret_ref.
   */
  deleteShopifyToken(secretArn: string): Promise<void>;
}
