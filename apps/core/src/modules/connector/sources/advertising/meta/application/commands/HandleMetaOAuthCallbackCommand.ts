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
 * Gap B (multi-account-per-provider, migration 0092):
 *   - resolveAllAdAccountIds returns ALL ad accounts (not just the first).
 *   - One ConnectorInstance is created per ad account, keyed by account_id.
 *   - Falls back to a single __default__ instance if no accounts are resolvable.
 *
 * ENFORCEMENT ORDER:
 *   1. State nonce validation — consume server-stored nonce → derive brandId (single-use, ≤15-min).
 *   2. Token exchange with Meta (graph.facebook.com).
 *   3. Resolve all ad_account_ids (best-effort /me/adaccounts; empty → single __default__ instance).
 *   4. Store token in Secrets Manager → get ARN. Token discarded.
 *   5. Write connector_instance per account (secret_ref = ARN only) + provider_config.
 *   6. Write connector_sync_status per instance.
 *   7. Emit connector.connected event (NO token, NO secret_ref in payload).
 */
import { randomUUID } from 'node:crypto';
import { ConnectorInstance, DEFAULT_ACCOUNT_KEY } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../../../../storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import { META_GRAPH_API_VERSION } from './InitiateMetaOAuthCommand.js';
import { resolveBrandOAuthAppCreds } from '../../../../../oauth-app-creds.js';

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
  /** All resolved ad account ids (Gap B). Empty = single __default__ instance created. */
  adAccountIds: string[];
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
    const shortLivedToken = await this.exchangeCodeForToken(code, brandId);
    // Exchange the short-lived (~1-2h) user token for a LONG-LIVED (~60-day) one IMMEDIATELY, so the
    // connection survives past the hour. The prior behaviour stored the short-lived token and relied
    // on the proactive meta-token-refresh job to re-exchange — but if that job hasn't run yet (or at
    // all in dev), the token expires in ~1-2h and the spend re-pull dies with TokenExpired /
    // RECONNECT_REQUIRED. Best-effort: falls back to the short-lived token on any exchange failure.
    const accessToken = await this.exchangeForLongLivedToken(shortLivedToken, brandId);

    // ── Step 3: Resolve ALL ad accounts (Gap B) — best-effort; empty → __default__ ──
    // Each carries id + human name (e.g. "Acme Store — Meta") so the UI can label the
    // per-account sub-cards instead of showing a raw act_<id> (the merchant connects many
    // accounts and needs to tell them apart).
    const adAccounts = await this.resolveAllAdAccounts(accessToken);
    const adAccountIds = adAccounts.map((a) => a.id);
    // Back-compat: expose first account id as adAccountId (or null if none).
    const adAccountId = adAccountIds[0] ?? null;

    // ── Step 4: Store token in Secrets Manager → ARN (NN-2 / I-S09) ───────────
    const { arn: secretRef } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'meta', subKey: adAccountId ?? undefined },
      // access_token_issued_at stamps the token's age so the proactive meta-token-refresh job
      // (fb_exchange_token) knows when to re-exchange before the ~60-day expiry.
      { access_token: accessToken, access_token_issued_at: new Date().toISOString() },
    );
    // accessToken is now discarded — only secretRef (ARN) proceeds.

    // ── Step 5: Write one ConnectorInstance per account (Gap B) ─────────────────
    // If no accounts resolved, create one __default__ instance.
    const accountsToCreate: Array<{ id: string; name: string | null } | null> =
      adAccounts.length > 0 ? adAccounts : [null];

    const now = new Date();
    let firstInstanceId = '';

    // 0106 ad-account activation: discovered accounts are NOT ingested until the user picks one
    // (else an agency login pollutes the brand with every account's spend). EXCEPTION: when exactly
    // one account exists there is nothing to choose, so auto-activate it. Multiple → all NULL → the
    // UI prompts the user to select one before any meta spend ingests.
    const autoActivate = accountsToCreate.length === 1;

    for (const account of accountsToCreate) {
      const accountId = account?.id ?? null;
      const accountName = account?.name ?? null;
      const instanceId = randomUUID();
      if (!firstInstanceId) firstInstanceId = instanceId;

      const instance = ConnectorInstance.create({
        id: instanceId,
        brandId,
        provider: 'meta',
        shopDomain: '',
        secretRef,
        status: 'connected',
        healthState: 'Healthy',
        safetyRating: 'safe',
        connectedAt: now,
        disconnectedAt: null,
        createdAt: now,
        updatedAt: now,
        accountKey: accountId ?? DEFAULT_ACCOUNT_KEY,
        // ad_account_name = the human label the UI shows for this account's sub-card
        // (falls back to the act_<id> when Meta doesn't return a name).
        providerConfig: accountId
          ? { ad_account_id: accountId, ...(accountName ? { ad_account_name: accountName } : {}) }
          : {},
        // 0106: auto-activate only when there's a single account; otherwise wait for selection.
        activatedAt: autoActivate ? now : null,
      });
      const savedInstance = await this.connectorRepo.save(instance);

      if (accountId && this.setAdAccountId) {
        await this.setAdAccountId(brandId, savedInstance.id, accountId);
      }

      // ── Step 6: connector_sync_status per instance ──────────────────────────
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
    }

    // ── Step 7: Emit connector.connected (NO token, NO secret_ref) ────────────
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: firstInstanceId,
      provider: 'meta',
      ad_account_id: adAccountId, // back-compat: first account
      ad_account_ids: adAccountIds, // Gap B: all accounts
      idempotency_key: idempotencyKey,
    });

    return {
      connectorInstanceId: firstInstanceId,
      brandId,
      adAccountId,
      adAccountIds,
      status: 'connected',
    };
  }

  /** Exchange the authorization code for an access token via Meta's token endpoint. */
  private async exchangeCodeForToken(code: string, brandId: string): Promise<string> {
    const creds = await resolveBrandOAuthAppCreds(this.secretsManager, 'meta', brandId, {
      clientId: process.env['META_APP_ID'] ?? '',
      clientSecret: process.env['META_APP_SECRET'] ?? '',
    });
    const callbackUrl = process.env['META_CALLBACK_URL'];
    if (!creds?.clientId || !creds?.clientSecret) {
      throw new Error('[HandleMetaOAuthCallbackCommand] META_APP_ID / META_APP_SECRET not configured');
    }

    const params = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
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
        signal: AbortSignal.timeout(15_000),
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
   * Exchange a short-lived Meta user token for a LONG-LIVED one (~60 days) via
   * grant_type=fb_exchange_token. Without this the code-exchange token (~1-2h) expires within the
   * hour and the spend re-pull fails RECONNECT_REQUIRED. Best-effort: on any failure we return the
   * short-lived token so connect still succeeds (the refresh job can re-exchange later).
   * SEC-AD-H1: client_secret rides the BODY, never the URL.
   */
  private async exchangeForLongLivedToken(shortLivedToken: string, brandId: string): Promise<string> {
    const creds = await resolveBrandOAuthAppCreds(this.secretsManager, 'meta', brandId, {
      clientId: process.env['META_APP_ID'] ?? '',
      clientSecret: process.env['META_APP_SECRET'] ?? '',
    });
    if (!creds?.clientId || !creds?.clientSecret) return shortLivedToken;
    const params = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      fb_exchange_token: shortLivedToken,
    });
    try {
      const response = await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) return shortLivedToken;
      const data = (await response.json()) as { access_token?: string };
      return data.access_token ?? shortLivedToken;
    } catch {
      return shortLivedToken;
    }
  }

  /**
   * Resolve ALL accessible ad accounts via /me/adaccounts (Gap B), each with its human name.
   * Returns e.g. [{ id: 'act_123', name: 'Acme Store' }, …]. `name` is null when Meta omits it.
   * Returns empty array on any failure — caller falls back to a single __default__ instance.
   */
  private async resolveAllAdAccounts(
    accessToken: string,
  ): Promise<Array<{ id: string; name: string | null }>> {
    try {
      // SEC-AD-M1: the access_token rides the Authorization header, never the URL query string.
      // `name` is requested so the UI can label each account sub-card (not just act_<id>).
      const response = await fetch(
        `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/adaccounts?fields=account_id,name`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) return [];
      const data = (await response.json()) as {
        data?: Array<{ account_id?: string; id?: string; name?: string }>;
      };
      return (data.data ?? [])
        .map((entry) => {
          const id = entry.id ?? (entry.account_id ? `act_${entry.account_id}` : null);
          return id ? { id, name: entry.name ?? null } : null;
        })
        .filter((e): e is { id: string; name: string | null } => e !== null);
    } catch {
      return [];
    }
  }
}
