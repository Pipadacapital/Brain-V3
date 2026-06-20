/**
 * HandleMetaOAuthCallbackCommand — processes the Meta Ads OAuth callback.
 *
 * feat-ad-connectors Track 1 (ADR-AD-2). Mirrors the Shopify HandleOAuthCallbackCommand
 * with the deliberate divergences:
 *   - NO HMAC step. Meta does not sign the callback like Shopify; the state nonce IS the
 *     authentication. (Removing an entire validation step is intentional and load-bearing —
 *     see ADR-AD-2: "ads providers don't sign the callback".)
 *   - brand_id is derived EXCLUSIVELY from consumeAndGetBrandId(state) — NEVER from the
 *     query body (D-1 / anti-spoof). A forged brand_id query param has no effect.
 *   - The OAuth access token NEVER touches Postgres (NN-2 / I-S09) — only the Secrets
 *     Manager ARN is stored in connector_instance.secret_ref.
 *   - provider='meta', shopDomain='' (ConnectorInstance.create skips shop validation when empty).
 *
 * ENFORCEMENT ORDER:
 *   1. State nonce validation — consume server-stored nonce → derive brandId (single-use, ≤15-min).
 *   2. Token exchange with Meta (graph.facebook.com).
 *   3. Resolve ad_account_id (best-effort /me/adaccounts; null if unavailable — honest).
 *   4. Store token in Secrets Manager → get ARN. Token discarded.
 *   5. Write connector_instance (secret_ref = ARN only) + persist ad_account_id.
 *   6. Write connector_sync_status (waiting_for_data).
 *   7. Emit connector.connected event (NO token, NO secret_ref in payload).
 */
import { randomUUID } from 'node:crypto';
import { ConnectorInstance } from '../../../../storefront/shopify/domain/entities/ConnectorInstance.js';
import { ConnectorSyncStatus } from '../../../../storefront/shopify/domain/entities/ConnectorSyncStatus.js';
import type { IConnectorInstanceRepository } from '../../../../storefront/shopify/domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../../../../storefront/shopify/domain/repositories/IConnectorSyncStatusRepository.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../../../../storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import { META_GRAPH_API_VERSION } from './InitiateMetaOAuthCommand.js';

export interface MetaOAuthCallbackInput {
  /** All query parameters from the Meta callback URL. */
  query: Record<string, string | string[] | undefined>;
  /**
   * Idempotency key (I-ST04). brandId is intentionally NOT here — it is derived from the
   * server-side state record. Callers must NOT pass brandId from query params (D-1).
   */
  idempotencyKey: string;
}

export interface MetaOAuthCallbackResult {
  connectorInstanceId: string;
  /** State-derived brand ID (D-1: NEVER from query param). */
  brandId: string;
  /** Resolved Meta ad account id (e.g. `act_123`), or null if not resolvable (honest). */
  adAccountId: string | null;
  status: 'connected';
}

/**
 * Optional hook to persist ad_account_id onto the connector_instance row (migration 0029
 * column). Kept out of the generic repository (mirrors how razorpay_account_id is set via
 * a direct UPDATE in the composition root). Brand-scoped by the caller.
 */
export type SetAdAccountIdFn = (
  brandId: string,
  connectorInstanceId: string,
  adAccountId: string,
) => Promise<void>;

export class MetaStateNonceError extends Error {
  constructor(message = 'State nonce invalid or expired') {
    super(message);
    this.name = 'MetaStateNonceError';
  }
}

export class MetaOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaOAuthError';
  }
}

export class HandleMetaOAuthCallbackCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly stateStore: IOAuthStateStore,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
    /** Optional — persists ad_account_id after the instance row is saved. */
    private readonly setAdAccountId?: SetAdAccountIdFn,
  ) {}

  async execute(input: MetaOAuthCallbackInput): Promise<MetaOAuthCallbackResult> {
    const { query, idempotencyKey } = input;

    // ── Step 1: State nonce validation + brand_id derivation (D-1) ────────────
    // The nonce IS the auth. brandId comes ONLY from the server-stored record.
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    if (!state) {
      throw new MetaStateNonceError('State parameter missing');
    }
    const stateRecord = await this.stateStore.consumeAndGetBrandId(state);
    if (!stateRecord) {
      throw new MetaStateNonceError('State nonce not found, expired, or already used');
    }
    const brandId = stateRecord.brandId; // server-trusted — never from query

    // ── Step 2: Token exchange with Meta ──────────────────────────────────────
    const code = typeof query['code'] === 'string' ? query['code'] : '';
    if (!code) {
      throw new MetaOAuthError('Authorization code missing from callback');
    }
    const accessToken = await this.exchangeCodeForToken(code);

    // ── Step 3: Resolve ad_account_id (best-effort; null is honest) ───────────
    const adAccountId = await this.resolveAdAccountId(accessToken);

    // ── Step 4: Store token in Secrets Manager → ARN (NN-2 / I-S09) ───────────
    // subKey = adAccountId (operational ref, not a secret) when known.
    const { arn: secretRef } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'meta', subKey: adAccountId ?? undefined },
      { access_token: accessToken },
    );
    // accessToken is now discarded — only secretRef (ARN) proceeds.

    // ── Step 5: Write connector_instance (secret_ref only) ────────────────────
    const instanceId = randomUUID();
    const now = new Date();
    const instance = ConnectorInstance.create({
      id: instanceId,
      brandId,
      provider: 'meta',
      shopDomain: '', // ads connectors have no shop domain (validation skipped when empty)
      secretRef,
      status: 'connected',
      healthState: 'Healthy',
      safetyRating: 'safe',
      connectedAt: now,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const savedInstance = await this.connectorRepo.save(instance);

    if (adAccountId && this.setAdAccountId) {
      await this.setAdAccountId(brandId, savedInstance.id, adAccountId);
    }

    // ── Step 6: Write connector_sync_status ───────────────────────────────────
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

    // ── Step 7: Emit connector.connected (NO token, NO secret_ref) ────────────
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: savedInstance.id,
      provider: 'meta',
      ad_account_id: adAccountId, // operational ref, not PII (I-S02)
      idempotency_key: idempotencyKey,
    });

    return {
      connectorInstanceId: savedInstance.id,
      brandId,
      adAccountId,
      status: 'connected',
    };
  }

  /** Exchange the authorization code for an access token via Meta's token endpoint. */
  private async exchangeCodeForToken(code: string): Promise<string> {
    const clientId = process.env['META_APP_ID'];
    const clientSecret = process.env['META_APP_SECRET'];
    const callbackUrl = process.env['META_CALLBACK_URL'];
    if (!clientId || !clientSecret) {
      throw new Error('[HandleMetaOAuthCallbackCommand] META_APP_ID / META_APP_SECRET not configured');
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      ...(callbackUrl ? { redirect_uri: callbackUrl } : {}),
    });

    // SEC-AD-H1: the client_secret MUST ride the request BODY, never the URL query
    // string — a secret in the URL is captured by every reverse-proxy/ALB/CDN/WAF
    // access log. Meta's /oauth/access_token supports POST + form-urlencoded body
    // (mirrors the Google token exchange). Never switch this back to GET.
    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(15_000), // T2-9: bound the token exchange so the OAuth callback can't hang.
      },
    );

    if (!response.ok) {
      // Do NOT include the Meta response body in the error (may contain context). Status only.
      throw new MetaOAuthError(`Token exchange failed (${response.status})`);
    }

    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new MetaOAuthError('Token exchange: access_token missing in response');
    }
    return data.access_token;
  }

  /**
   * Best-effort resolution of the first ad account id via /me/adaccounts.
   * Returns null on any failure (dev-honest: a connector with no resolvable account
   * still connects; the repull job resolves accounts at run time).
   */
  private async resolveAdAccountId(accessToken: string): Promise<string | null> {
    try {
      // SEC-AD-M1: the access_token rides the Authorization header, never the URL
      // query string (proxy/CDN log exposure), consistent with MetaInsightsClient.
      const response = await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/adaccounts?fields=account_id`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(15_000), // T2-9: bound the best-effort account resolution.
        },
      );
      if (!response.ok) return null;
      const data = (await response.json()) as { data?: Array<{ account_id?: string; id?: string }> };
      const first = data.data?.[0];
      // Prefer the `act_`-prefixed id; fall back to account_id.
      return first?.id ?? (first?.account_id ? `act_${first.account_id}` : null);
    } catch {
      return null;
    }
  }
}
