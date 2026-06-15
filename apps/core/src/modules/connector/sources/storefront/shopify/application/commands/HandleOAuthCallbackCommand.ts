/**
 * HandleOAuthCallbackCommand — processes the Shopify OAuth callback.
 *
 * NN-4 ENFORCEMENT ORDER (non-negotiable):
 *   1. HMAC validation FIRST — any failure → reject (no further processing).
 *   2. State nonce validation — consume server-stored nonce (brand-bound, single-use, ≤15-min).
 *   3. Shop domain validation (*.myshopify.com format).
 *   4. Token exchange with Shopify.
 *   5. Store token in Secrets Manager → get ARN.
 *   6. Write connector_instance row (secret_ref = ARN only, NN-2).
 *   7. Write connector_sync_status row (waiting_for_data).
 *   8. Emit connector.connected event.
 *
 * NN-2: The OAuth access token NEVER touches Postgres. Only the Secrets Manager ARN
 * is stored in connector_instance.secret_ref.
 */
import { randomUUID } from 'node:crypto';
import { ShopifyHmac } from '../../domain/value-objects/ShopifyHmac.js';
import { ConnectorInstance } from '../../domain/entities/ConnectorInstance.js';
import { ConnectorSyncStatus } from '../../domain/entities/ConnectorSyncStatus.js';
import type { IConnectorInstanceRepository } from '../../domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../../domain/repositories/IConnectorSyncStatusRepository.js';
import type { ISecretsManager } from '../../infrastructure/secrets/ISecretsManager.js';
import type { IOAuthStateStore } from '../../infrastructure/state/IOAuthStateStore.js';

export interface OAuthCallbackInput {
  /** All query parameters from the Shopify callback URL. */
  query: Record<string, string | string[] | undefined>;
  /**
   * Idempotency key from request header (I-ST04).
   * NOTE: brandId is intentionally NOT here — it is derived from the server-side
   * state record (MED-CALLBACK-01). Callers must NOT pass brandId from query params.
   */
  idempotencyKey: string;
}

export interface OAuthCallbackResult {
  connectorInstanceId: string;
  shopDomain: string;
  /** Secret Manager ARN — stored as secret_ref (NN-2 confirmation). */
  secretRef: string;
  status: 'connected';
}

export class HmacValidationError extends Error {
  constructor(message = 'HMAC validation failed') {
    super(message);
    this.name = 'HmacValidationError';
  }
}

export class StateNonceError extends Error {
  constructor(message = 'State nonce invalid or expired') {
    super(message);
    this.name = 'StateNonceError';
  }
}

export class ShopDomainError extends Error {
  constructor(shopDomain: string) {
    super(`Invalid shop domain: "${shopDomain}" — must match *.myshopify.com`);
    this.name = 'ShopDomainError';
  }
}

export class HandleOAuthCallbackCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly stateStore: IOAuthStateStore,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
  ) {}

  async execute(input: OAuthCallbackInput): Promise<OAuthCallbackResult> {
    const { query, idempotencyKey } = input;

    // ── Step 1: HMAC validation — ABSOLUTE FIRST (NN-4) ──────────────────────
    // Any failure immediately rejects. No other processing before this passes.
    const clientSecret = await this.secretsManager.getShopifyClientSecret();
    const hmacValid = ShopifyHmac.validateOAuthCallback(query, clientSecret);
    if (!hmacValid) {
      throw new HmacValidationError();
    }

    // ── Step 2: State nonce validation + brand_id derivation ─────────────────
    // MED-CALLBACK-01: brandId is derived from the server-side state record, NOT
    // from the query string. The query's `state` param is the lookup key; the
    // server-stored record holds the authoritative brandId bound at install time.
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    if (!state) {
      throw new StateNonceError('State parameter missing');
    }
    const stateRecord = await this.stateStore.consumeAndGetBrandId(state);
    if (!stateRecord) {
      throw new StateNonceError('State nonce not found, expired, or already used');
    }
    // brandId is now server-trusted — never from query param
    const brandId = stateRecord.brandId;

    // ── Step 3: Shop domain validation ────────────────────────────────────────
    const shopDomain = typeof query['shop'] === 'string' ? query['shop'] : '';
    if (!ConnectorInstance.isValidShopDomain(shopDomain)) {
      throw new ShopDomainError(shopDomain);
    }

    // ── Step 4: Token exchange with Shopify ───────────────────────────────────
    const code = typeof query['code'] === 'string' ? query['code'] : '';
    const accessToken = await this.exchangeCodeForToken(shopDomain, code, clientSecret);

    // ── Step 5: Store token in Secrets Manager → get ARN (NN-2) ──────────────
    const { arn: secretRef } = await this.secretsManager.storeShopifyToken(
      brandId,
      shopDomain,
      accessToken,
    );
    // accessToken is now discarded — only secretRef (ARN) proceeds.

    // ── Step 6: Write connector_instance (secret_ref only — NN-2) ────────────
    const instanceId = randomUUID();
    const now = new Date();
    const instance = ConnectorInstance.create({
      id: instanceId,
      brandId,
      provider: 'shopify',
      shopDomain,
      secretRef,
      status: 'connected',
      connectedAt: now,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const savedInstance = await this.connectorRepo.save(instance);

    // ── Step 7: Write connector_sync_status ───────────────────────────────────
    const syncStatus = ConnectorSyncStatus.create({
      id: randomUUID(),
      brandId,
      connectorInstanceId: savedInstance.id,
      state: 'waiting_for_data',
      lastSyncAt: null,
      lastError: null,
      updatedAt: now,
    });
    await this.syncStatusRepo.save(syncStatus);

    // ── Step 8: Emit connector.connected event ────────────────────────────────
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: savedInstance.id,
      provider: 'shopify',
      shop_domain: shopDomain,
      // secret_ref is intentionally NOT included in the event payload (I-S09)
      idempotency_key: idempotencyKey,
    });

    return {
      connectorInstanceId: savedInstance.id,
      shopDomain: savedInstance.shopDomain,
      secretRef: savedInstance.secretRef,
      status: 'connected',
    };
  }

  /** Exchange the authorization code for an access token via Shopify's token endpoint. */
  private async exchangeCodeForToken(
    shopDomain: string,
    code: string,
    clientSecret: string,
  ): Promise<string> {
    const clientId = process.env['SHOPIFY_CLIENT_ID'];
    if (!clientId) {
      throw new Error('[HandleOAuthCallbackCommand] SHOPIFY_CLIENT_ID not configured');
    }

    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `[HandleOAuthCallbackCommand] Token exchange failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error('[HandleOAuthCallbackCommand] Token exchange: access_token missing in response');
    }

    return data.access_token;
  }
}
