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
import type {
  IConnectorInstanceRepository,
  IConnectorSyncStatusRepository,
} from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';
import { assertSingleStorefront } from '../../../storefront-exclusivity.js';
import {
  isValidShopDomain,
  createShopifyConnectorInstance,
} from '../../domain/ShopifyHostPolicy.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../../infrastructure/state/IOAuthStateStore.js';
import { resolveBrandOAuthAppCreds } from '../../../../../oauth-app-creds.js';
import { RegisterWebhooksCommand } from './RegisterWebhooksCommand.js';
import { log } from '../../../../../../../log.js';

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
  /** State-derived brand ID (D-1: NEVER from query param). */
  brandId: string;
  shopDomain: string;
  // MED-01: secretRef (ARN) removed — caller does not need it; ARN is persisted
  // to connector_instance.secret_ref by connectorRepo.save(instance) internally.
  status: 'connected';
}

/**
 * Best-effort public webhook-callback origin for RegisterWebhooksCommand when the caller does not inject
 * one: the SHOPIFY_CALLBACK_URL origin (the public host that receives OAuth callbacks) → the configured
 * BRAIN_WEBHOOK_BASE_URL → '' (registration becomes a fail-safe no-op rather than building a bad URL).
 */
function defaultWebhookCallbackBaseUrl(): string {
  const callbackUrl = process.env['SHOPIFY_CALLBACK_URL'];
  if (callbackUrl) {
    try {
      return new URL(callbackUrl).origin;
    } catch {
      /* fall through */
    }
  }
  return process.env['BRAIN_WEBHOOK_BASE_URL'] ?? '';
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
    /**
     * CRIT-3 wiring (both OPTIONAL — defaults keep the existing 5-arg construction + unit tests working):
     *   - appEnv: gates RegisterWebhooksCommand's dev no-op (non-'production' → stubbed, no Shopify call).
     *   - webhookCallbackBaseUrl: the PUBLIC core API origin Shopify delivers webhooks to (the same host
     *     that receives the OAuth callbacks). Falls back to env when omitted.
     */
    private readonly appEnv: string =
      process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? 'development',
    private readonly webhookCallbackBaseUrl: string = defaultWebhookCallbackBaseUrl(),
  ) {}

  async execute(input: OAuthCallbackInput): Promise<OAuthCallbackResult> {
    const { query, idempotencyKey } = input;

    // ── Step 0: Resolve the brand's OAuth app creds (read-only) ──────────────
    // Per-brand BYO-app: Shopify signs the callback HMAC with the brand's OWN client_secret, so we
    // must know the brand to validate HMAC. brandId comes from the server-side state record — PEEKED
    // (read-only, no consume): HMAC must still pass before the single-use consume (NN-4) and before
    // any token exchange. A forged/garbage state peeks to null → rejected, nothing mutated.
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    if (!state) {
      throw new StateNonceError('State parameter missing');
    }
    // Resolve the brand from the state record FIRST (read-only peek). An unknown/forged state returns
    // null here → rejected with only a cheap state-store read, BEFORE any Secrets Manager / KMS access
    // (SEC review MED-1: the common forgery never touches the secret store). Only a state that exists
    // server-side (an unforgeable 128-bit single-use nonce) proceeds to resolve the brand's app secret.
    const peeked = await this.stateStore.peekBrandId(state);
    if (!peeked) {
      throw new StateNonceError('State nonce not found, expired, or already used');
    }
    // The brand's app creds (its own app → env app fallback). Secret used for HMAC + token exchange;
    // never logged (I-S09).
    const appCreds = await resolveBrandOAuthAppCreds(this.secretsManager, 'shopify', peeked.brandId, {
      clientId: process.env['SHOPIFY_CLIENT_ID'] ?? '',
      clientSecret: await this.secretsManager.getShopifyClientSecret(),
    });
    if (!appCreds?.clientSecret) {
      throw new HmacValidationError();
    }

    // ── Step 1: HMAC validation — first GATE (NN-4), using the brand's app secret ──
    // No state consumption / token exchange happens before this passes.
    const hmacValid = ShopifyHmac.validateOAuthCallback(query, appCreds.clientSecret);
    if (!hmacValid) {
      throw new HmacValidationError();
    }

    // ── Step 2: Consume the state nonce (single-use) → authoritative brand_id ─
    // MED-CALLBACK-01: brandId is the server-side record, never the query string.
    const stateRecord = await this.stateStore.consumeAndGetBrandId(state);
    if (!stateRecord) {
      throw new StateNonceError('State nonce not found, expired, or already used');
    }
    const brandId = stateRecord.brandId;

    // ── Step 3: Shop domain validation ────────────────────────────────────────
    const shopDomain = typeof query['shop'] === 'string' ? query['shop'] : '';
    if (!isValidShopDomain(shopDomain)) {
      throw new ShopDomainError(shopDomain);
    }

    // ── Step 4: Token exchange with the brand's app client_id + client_secret ──
    const code = typeof query['code'] === 'string' ? query['code'] : '';
    const accessToken = await this.exchangeCodeForToken(shopDomain, code, appCreds.clientId, appCreds.clientSecret);

    // ── Step 5: Store token in Secrets Manager → get ARN (NN-2) ──────────────
    const { arn: secretRef } = await this.secretsManager.storeShopifyToken(
      brandId,
      shopDomain,
      accessToken,
    );
    // accessToken is now discarded — only secretRef (ARN) proceeds.

    // One-storefront-per-brand (business rule): reject if the brand already has a DIFFERENT
    // connected storefront (e.g. WooCommerce). Reconnecting/adding Shopify stores is allowed
    // (same provider). Checked before the connector_instance write.
    await assertSingleStorefront(this.connectorRepo, brandId, 'shopify');

    // ── Step 6: Write connector_instance (secret_ref only — NN-2) ────────────
    // ADR-CM-5: connect ⇒ health_state='Healthy', safety_rating='safe'
    const instanceId = randomUUID();
    const now = new Date();
    const instance = createShopifyConnectorInstance({
      id: instanceId,
      brandId,
      provider: 'shopify',
      shopDomain,
      secretRef,
      status: 'connected',
      healthState: 'Healthy',
      safetyRating: 'safe',
      connectedAt: now,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
      // Gap B: for Shopify, the shopDomain IS the per-account key (each store is its own account)
      accountKey: shopDomain,
      // Gap A: provider_config carries the shop_domain for the generic repull fn
      providerConfig: { shop_domain: shopDomain },
    });
    const savedInstance = await this.connectorRepo.save(instance);

    // ── Step 6.5: Register live webhook subscriptions (CRIT-3) ────────────────
    // Previously dead code — Shopify never delivered live order/compliance events, so any state change
    // after the connect-time backfill (cancel/refund/COD delivery/RTO) never reached Brain. We now call
    // it post-instance-save with the public callback origin. It is IDEMPOTENT (GETs existing subs /
    // treats 422 as success) and dev-gated (no-op when APP_ENV != production). Registration MUST NOT fail
    // the connect — the token + instance are already persisted — so any error is logged and swallowed;
    // a reconnect (idempotent) or reaper can retry. Includes the Shopify-mandatory compliance topics.
    try {
      const registrar = new RegisterWebhooksCommand(this.secretsManager, this.appEnv);
      const result = await registrar.execute({
        shopDomain,
        secretRef,
        callbackBaseUrl: this.webhookCallbackBaseUrl,
      });
      log.info(
        `[HandleOAuthCallbackCommand] webhook registration: registered=${result.registered} topics=${result.topicCount} shop=${shopDomain}`,
      );
    } catch (err) {
      // Fail-safe: never block a successful connect on webhook registration.
      log.warn(
        `[HandleOAuthCallbackCommand] webhook registration failed (connect still succeeds) shop=${shopDomain}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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
      brandId,
      shopDomain: savedInstance.shopDomain,
      // MED-01: secretRef not returned — ARN persisted internally via connectorRepo.save.
      status: 'connected',
    };
  }

  /** Exchange the authorization code for an access token via Shopify's token endpoint. */
  private async exchangeCodeForToken(
    shopDomain: string,
    code: string,
    clientId: string,
    clientSecret: string,
  ): Promise<string> {
    if (!clientId) {
      throw new Error('[HandleOAuthCallbackCommand] no Shopify client_id for token exchange');
    }

    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      signal: AbortSignal.timeout(15_000), // T2-9: bound the token exchange so the OAuth callback can't hang.
    });

    if (!response.ok) {
      // MED-02: do NOT include the Shopify response body in the error — it may contain
      // shop context. Log status code only; body discarded.
      throw new Error(
        `[HandleOAuthCallbackCommand] Token exchange failed (${response.status})`,
      );
    }

    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error('[HandleOAuthCallbackCommand] Token exchange: access_token missing in response');
    }

    return data.access_token;
  }
}
