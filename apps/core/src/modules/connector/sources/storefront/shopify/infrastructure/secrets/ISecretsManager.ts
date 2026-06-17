/**
 * ISecretsManager — interface for Secrets Manager operations.
 *
 * I-S09: OAuth tokens MUST be stored in Secrets Manager.
 * The returned ARN is the only value stored in connector_instance.secret_ref (NN-2).
 *
 * In production: backed by AWS Secrets Manager.
 * In dev: backed by a LocalStack-compatible stub that returns a fake ARN.
 *
 * ADR-CM-4 (feat-connector-marketplace A2): generalized with storeSecret / getSecret /
 * deleteSecret keyed by (brandId, connectorRef, payload). Shopify-specific methods kept
 * for back-compat but unused by new generic connect code.
 * D-7: LocalSecretsManager HARD-FAILS if instantiated in production.
 */

export interface SecretWriteResult {
  /** AWS Secrets Manager ARN — stored in connector_instance.secret_ref (NN-2). */
  arn: string;
  /** Secret name (human-readable; not stored in DB). */
  name: string;
}

/** Connector reference for generic secret operations. */
export interface ConnectorSecretRef {
  /** Connector type (e.g. 'shopify', 'meta', 'razorpay'). */
  connectorType: string;
  /** Optional sub-key (e.g. shop domain for Shopify). */
  subKey?: string;
}

export interface ISecretsManager {
  // ── Generic methods (ADR-CM-4 / D-3) ────────────────────────────────────────
  // Used by the generic connect seam. Shopify-specific methods below are kept
  // for back-compat but not called by new code.

  /**
   * Store a connector credential generically.
   * In prod: every write uses EncryptionContext: { brand_id, connector_type } (D-7).
   * Returns the ARN for storage in connector_instance.secret_ref.
   * The credential values NEVER reach the caller after this call (I-S09).
   *
   * @param brandId        Brand UUID (used to namespace + KMS EncryptionContext).
   * @param connectorRef   Connector type + optional sub-key.
   * @param credential     Key-value credential map (e.g. { access_token }, { api_key, api_secret }).
   */
  storeSecret(
    brandId: string,
    connectorRef: ConnectorSecretRef,
    credential: Record<string, string>,
  ): Promise<SecretWriteResult>;

  /**
   * Retrieve a stored connector credential by its ARN.
   * Callers MUST NOT log or persist the value (I-S09).
   *
   * @param secretArn  ARN stored in connector_instance.secret_ref.
   */
  getSecret(secretArn: string): Promise<Record<string, string> | null>;

  /**
   * Delete a connector credential (called on disconnect).
   * @param secretArn  ARN stored in connector_instance.secret_ref.
   */
  deleteSecret(secretArn: string): Promise<void>;

  // ── Shopify-specific methods (kept for back-compat; unused by new generic code) ──

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

  /**
   * Retrieve a stored Shopify OAuth access token by its secret_ref (the ARN held in
   * connector_instance.secret_ref). Returns null if not found.
   *
   * Unlike storeShopifyToken (write-only — the token never returns), this DOES return
   * the token: calling the Shopify Admin API requires it. Callers MUST NOT log or
   * persist the value (I-S09) — use it for the request and discard.
   *
   * @param secretRef  The ARN stored in connector_instance.secret_ref.
   */
  getShopifyToken(secretRef: string): Promise<string | null>;
}
