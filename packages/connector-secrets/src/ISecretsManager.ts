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

/**
 * Sanitize a secret-name sub-key to a valid Secrets Manager name segment.
 *
 * A secret name may only contain alphanumerics + `-/_+=.@!`. Sub-keys often carry raw values like a
 * WooCommerce site_url (`https://ulinen.com/`) whose `:` (and scheme/slashes) make the name invalid
 * ("Invalid name. Must be a valid name containing alphanumeric characters, or any of: -/_+=.@!").
 * We collapse anything outside `[A-Za-z0-9._-]` to `-`, squeeze repeats, and trim — yielding a flat,
 * stable, valid segment (e.g. `https-ulinen.com`). The full original value is still kept as the
 * connector_instance account_key, so uniqueness is preserved there; the secret is fetched by ARN, so
 * the exact name never needs to be reconstructed.
 */
export function sanitizeSecretSubKey(subKey: string): string {
  return subKey
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * Unwrap a stored Shopify token secret value to the bare access token.
 *
 * Two storage shapes coexist (both read via getShopifyToken(secret_ref)):
 *   - LEGACY (authorization-code OAuth connect): the SecretString IS the raw token.
 *   - BUNDLE (generic per-brand client-credentials connect, 2026-07): a JSON object
 *     `{ access_token, shop_domain, auth_method, access_token_issued_at, access_token_expires_at }`
 *     — the metadata lets the shopify-token-refresh cron re-exchange the 24h token.
 *
 * Callers MUST NOT log the returned value (I-S09).
 */
export function unwrapShopifyTokenValue(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(s) as { access_token?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.access_token === 'string' && parsed.access_token.length > 0) {
      return parsed.access_token;
    }
  } catch {
    /* not JSON — fall through to raw */
  }
  return raw;
}

export interface ISecretsManager {
  // ── Generic methods (ADR-CM-4 / D-3) ────────────────────────────────────────
  // Used by the generic connect seam. Shopify-specific methods below are kept
  // for back-compat but not called by new code.

  /**
   * Store (UPSERT) a connector credential generically.
   * Creates the secret if it does not exist; updates the value if it does (no throw on
   * ResourceExistsException / reconnect). In prod: every write uses KmsKeyId (D-7).
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
   * Update the value of an existing secret by ARN (PutSecretValue semantics).
   * Used when the ARN is already known (e.g. token rotation write-back) and the caller
   * must NOT change the secret's metadata (tags, KMS key, name). Fails if the secret
   * does not exist — callers that need create-or-update should use storeSecret instead.
   *
   * I-S09: credential values MUST NOT be logged by callers.
   *
   * @param secretArn  ARN stored in connector_instance.secret_ref.
   * @param credential Key-value credential map (replaces the stored secret string).
   */
  putSecretValue(
    secretArn: string,
    credential: Record<string, string>,
  ): Promise<void>;

  /**
   * Retrieve a stored connector credential by its ARN **or** its friendly name (AWS GetSecretValue
   * and LocalSecretsManager both accept either as the SecretId — e.g. the per-brand OAuth-app creds
   * are looked up by the deterministic name `brain/connector/<provider>_app/<brandId>`, no ARN needed).
   * Callers MUST NOT log or persist the value (I-S09).
   *
   * @param secretNameOrArn  The ARN stored in connector_instance.secret_ref, or a friendly secret name.
   */
  getSecret(secretNameOrArn: string): Promise<Record<string, string> | null>;

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
