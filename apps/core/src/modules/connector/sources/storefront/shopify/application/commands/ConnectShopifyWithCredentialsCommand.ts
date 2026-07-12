/**
 * ConnectShopifyWithCredentialsCommand — the GENERIC per-brand Shopify connect path
 * (owner requirement 2026-07-12).
 *
 * Every brand connects THEIR OWN store by entering the Client ID + Client Secret of a
 * custom app created in their own Shopify admin (Settings → Apps and sales channels →
 * Develop apps) plus the store URL. NO browser OAuth redirect: the server exchanges the
 * credentials via the CLIENT-CREDENTIALS grant —
 *
 *   POST https://{shop}.myshopify.com/admin/oauth/access_token
 *   { grant_type: 'client_credentials', client_id, client_secret }
 *
 * → an Admin API access token that EXPIRES IN 24 HOURS (no refresh token — renewal is a
 * re-exchange, done by the stream-worker `shopify-token-refresh` cron; see
 * apps/stream-worker/src/jobs/shopify-token-refresh/).
 *
 * Flow (mirrors the OAuth callback's post-exchange steps — NN-2/I-S09 preserved):
 *   1. Normalize + validate the shop domain (*.myshopify.com; full URLs accepted).
 *   2. Storefront exclusivity — 409 STOREFRONT_ALREADY_CONNECTED for a different storefront.
 *   3. Client-credentials exchange (bad creds → SHOPIFY_CREDENTIALS_INVALID, user-facing).
 *   4. Verify the token with a cheap GET /admin/api/<version>/shop.json.
 *   5. Store the app creds per-brand (Secrets Manager `brain/connector/shopify_app/<brandId>`
 *      via oauth-app-creds) — the SAME bundle the webhook HMAC resolver + refresh cron read,
 *      so per-brand webhook verification works with zero extra wiring.
 *   6. Store the token BUNDLE per-brand+shop (Secrets Manager) — JSON with
 *      { access_token, shop_domain, auth_method:'client_credentials',
 *        access_token_issued_at, access_token_expires_at }. Readers unwrap via the
 *      bundle-aware getShopifyToken (connector-secrets).
 *   7. Create/activate the connector_instance (secret_ref = ARN only, NN-2).
 *   8. RegisterWebhooksCommand with the new token (fail-safe — never blocks the connect).
 *   9. connector_sync_status row + connector.connected event.
 *
 * I-S09: client_secret and access_token are NEVER logged and never returned to the caller.
 */
import { randomUUID } from 'node:crypto';
import type {
  IConnectorInstanceRepository,
  IConnectorSyncStatusRepository,
} from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import { assertSingleStorefront } from '../../../storefront-exclusivity.js';
import {
  isValidShopDomain,
  createShopifyConnectorInstance,
} from '../../domain/ShopifyHostPolicy.js';
import { storeBrandOAuthAppCreds } from '../../../../../oauth-app-creds.js';
import { RegisterWebhooksCommand } from './RegisterWebhooksCommand.js';
import { log } from '../../../../../../../log.js';

/** Admin API version for the connect-time token verification call. */
const SHOPIFY_API_VERSION = '2025-07' as const;

/** Client-credentials tokens expire after 24h; used when Shopify omits expires_in. */
const DEFAULT_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * Normalize a merchant-entered store URL/domain to the bare `<store>.myshopify.com` host.
 * Accepts `my-store.myshopify.com`, `https://my-store.myshopify.com/`,
 * `http://my-store.myshopify.com/admin`, with any casing/whitespace. Returns the
 * lowercased host (validation against *.myshopify.com is the caller's next step).
 */
export function normalizeShopDomain(input: string): string {
  let s = (input ?? '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, ''); // scheme
  s = s.replace(/[/?#].*$/, ''); // path / query / fragment
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/\.+$/, ''); // trailing dots
  return s;
}

export class InvalidShopDomainError extends Error {
  public readonly code = 'INVALID_SHOP_DOMAIN';
  public readonly statusCode = 400;
  constructor(shopDomain: string) {
    super(
      `"${shopDomain}" is not a valid Shopify store domain — enter your *.myshopify.com URL ` +
        `(e.g. my-store.myshopify.com).`,
    );
    this.name = 'InvalidShopDomainError';
  }
}

export class ShopifyCredentialsInvalidError extends Error {
  public readonly code = 'SHOPIFY_CREDENTIALS_INVALID';
  public readonly statusCode = 422;
  constructor(detail?: string) {
    super(
      'Shopify rejected these app credentials. Check the Client ID and Client Secret of the ' +
        'custom app in your Shopify admin (Settings → Apps and sales channels → Develop apps) ' +
        `and make sure the app is installed on this store.${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'ShopifyCredentialsInvalidError';
  }
}

export interface ConnectShopifyWithCredentialsInput {
  /** Server-resolved brand (session), never client input (MT-1). */
  brandId: string;
  /** Merchant-entered store URL or domain (normalized here). */
  shopDomain: string;
  /** The brand's custom-app Client ID (non-secret identifier). */
  clientId: string;
  /** The brand's custom-app Client Secret — NEVER logged (I-S09). */
  clientSecret: string;
  /** Idempotency key from the request header. */
  idempotencyKey: string;
}

export interface ConnectShopifyWithCredentialsResult {
  connectorInstanceId: string;
  brandId: string;
  shopDomain: string;
  /** The per-tenant webhook delivery URL (registered automatically; surfaced for reference). */
  webhookUrl: string;
  status: 'connected';
}

/** Best-effort public webhook-callback origin (same fallback chain as the OAuth callback). */
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

export class ConnectShopifyWithCredentialsCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
    private readonly appEnv: string =
      process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? 'development',
    private readonly webhookCallbackBaseUrl: string = defaultWebhookCallbackBaseUrl(),
    /** Injectable for deterministic tests. */
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    input: ConnectShopifyWithCredentialsInput,
  ): Promise<ConnectShopifyWithCredentialsResult> {
    const { brandId, clientId, clientSecret, idempotencyKey } = input;

    // ── 1. Normalize + validate the shop domain ───────────────────────────────
    const shopDomain = normalizeShopDomain(input.shopDomain);
    if (!isValidShopDomain(shopDomain)) {
      throw new InvalidShopDomainError(input.shopDomain);
    }

    // ── 2. One storefront per brand (409 before any Shopify call) ────────────
    await assertSingleStorefront(this.connectorRepo, brandId, 'shopify');

    // ── 3. Client-credentials exchange (immediate credential validation) ─────
    const { accessToken, expiresInSeconds } = await this.exchangeClientCredentials(
      shopDomain,
      clientId,
      clientSecret,
    );

    // ── 4. Verify the token actually works (cheap shop.json read) ────────────
    await this.verifyToken(shopDomain, accessToken);

    // ── 5. Store the brand's app creds (webhook HMAC + refresh cron read these) ─
    // Same bundle the OAuth BYO-app path writes — the ShopifyWebhookStrategy resolver
    // (registerWebhookRoutes) and the token-refresh re-exchange resolve it per brand.
    await storeBrandOAuthAppCreds(this.secretsManager, 'shopify', brandId, {
      clientId,
      clientSecret,
    });

    // ── 6. Store the access-token BUNDLE (NN-2: only the ARN leaves this scope) ─
    const nowDate = this.now();
    const expiresAt = new Date(
      nowDate.getTime() + (expiresInSeconds ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000,
    );
    const { arn: secretRef } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'shopify', subKey: shopDomain },
      {
        access_token: accessToken,
        shop_domain: shopDomain,
        auth_method: 'client_credentials',
        access_token_issued_at: nowDate.toISOString(),
        access_token_expires_at: expiresAt.toISOString(),
      },
    );

    // ── 7. connector_instance (ADR-CM-5 connect ⇒ Healthy/safe) ──────────────
    const instanceId = randomUUID();
    const instance = createShopifyConnectorInstance({
      id: instanceId,
      brandId,
      provider: 'shopify',
      shopDomain,
      secretRef,
      status: 'connected',
      healthState: 'Healthy',
      safetyRating: 'safe',
      connectedAt: nowDate,
      disconnectedAt: null,
      createdAt: nowDate,
      updatedAt: nowDate,
      accountKey: shopDomain,
      providerConfig: { shop_domain: shopDomain, auth_method: 'client_credentials' },
    });
    const savedInstance = await this.connectorRepo.save(instance);

    // ── 8. Register live webhooks with the new token (fail-safe) ─────────────
    // Idempotent + dev-gated inside the command. Never blocks the connect: the token +
    // instance are already persisted; a reconnect or the reaper retries registration.
    try {
      const registrar = new RegisterWebhooksCommand(this.secretsManager, this.appEnv);
      const result = await registrar.execute({
        shopDomain,
        secretRef,
        callbackBaseUrl: this.webhookCallbackBaseUrl,
      });
      log.info(
        `[ConnectShopifyWithCredentials] webhook registration: registered=${result.registered} topics=${result.topicCount} shop=${shopDomain}`,
      );
    } catch (err) {
      log.warn(
        `[ConnectShopifyWithCredentials] webhook registration failed (connect still succeeds) shop=${shopDomain}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 9. sync status + connector.connected event ────────────────────────────
    const syncStatus = ConnectorSyncStatus.create({
      id: randomUUID(),
      brandId,
      connectorInstanceId: savedInstance.id,
      state: 'waiting_for_data',
      lastSyncAt: null,
      lastError: null,
      updatedAt: nowDate,
    });
    await this.syncStatusRepo.save(syncStatus);

    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: savedInstance.id,
      provider: 'shopify',
      shop_domain: shopDomain,
      auth_method: 'client_credentials',
      // secret_ref / credentials intentionally NOT in the event payload (I-S09)
      idempotency_key: idempotencyKey,
    });

    return {
      connectorInstanceId: savedInstance.id,
      brandId,
      shopDomain: savedInstance.shopDomain,
      webhookUrl: `${this.webhookCallbackBaseUrl.replace(/\/+$/, '')}/api/v1/webhooks/shopify`,
      status: 'connected',
    };
  }

  /**
   * CLIENT-CREDENTIALS grant — POST /admin/oauth/access_token with grant_type=client_credentials.
   * The token expires in ~24h (expires_in); renewal is a re-exchange (no refresh token).
   * 4xx ⇒ SHOPIFY_CREDENTIALS_INVALID (user-facing); other failures propagate as 5xx-class.
   */
  private async exchangeClientCredentials(
    shopDomain: string,
    clientId: string,
    clientSecret: string,
  ): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${shopDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Network / DNS failure — most commonly a mistyped store that doesn't exist.
      throw new InvalidShopDomainError(shopDomain);
    }

    if (!response.ok) {
      // MED-02: never include the Shopify response body in errors/logs (may carry shop context).
      if (response.status >= 400 && response.status < 500) {
        throw new ShopifyCredentialsInvalidError(`Shopify returned ${response.status}`);
      }
      throw new Error(
        `[ConnectShopifyWithCredentials] token exchange failed (${response.status})`,
      );
    }

    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new ShopifyCredentialsInvalidError('no access token in the exchange response');
    }
    return {
      accessToken: data.access_token,
      expiresInSeconds:
        typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
          ? data.expires_in
          : null,
    };
  }

  /** Cheap read to prove the token works (and the app has basic Admin API access). */
  private async verifyToken(shopDomain: string, accessToken: string): Promise<void> {
    const response = await this.fetchImpl(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      {
        method: 'GET',
        headers: { 'X-Shopify-Access-Token': accessToken },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ShopifyCredentialsInvalidError(
          `the issued token was rejected (${response.status}) — check the app's Admin API scopes`,
        );
      }
      throw new Error(
        `[ConnectShopifyWithCredentials] token verification failed (${response.status})`,
      );
    }
  }
}
