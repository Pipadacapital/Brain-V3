/**
 * HandleGoogleAdsOAuthCallbackCommand — processes the Google Ads OAuth callback.
 *
 * feat-ad-connectors Track 1 (ADR-AD-2). Same shape as the Meta callback with two
 * divergences specific to Google:
 *   - Google issues short-lived access tokens; we persist the REFRESH token (offline
 *     access) so the repull job can mint access tokens at run start. The secret is a
 *     JSON bundle `{ refresh_token, ad_account_id }` (same multi-cred-bundle pattern as
 *     the Razorpay credential bundle).
 *   - ad_account_id here is the Google Ads customer id (digits only, no dashes). It is
 *     stored INSIDE the bundle (the repull client needs it) AND on the connector_instance
 *     row (for enumeration / webhook-free brand resolution).
 *
 * Gap B (multi-account-per-provider, migration 0092):
 *   - resolveAllCustomerIds returns ALL accessible customer ids (not just the first).
 *   - One ConnectorInstance is created per customer id, keyed by customer_id.
 *   - Falls back to a single __default__ instance if no customers are resolvable.
 *
 * Invariants (identical to Meta):
 *   - NO HMAC. The state nonce IS the auth. brand_id from consumeAndGetBrandId(state) ONLY (D-1).
 *   - The refresh token NEVER touches Postgres (NN-2 / I-S09) — only the ARN is stored.
 *   - provider='google_ads', shopDomain=''.
 */
import { randomUUID } from 'node:crypto';
import { ConnectorInstance, DEFAULT_ACCOUNT_KEY } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../../../../storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import type { SetAdAccountIdFn } from '../../../meta/application/commands/HandleMetaOAuthCallbackCommand.js';
import { resolveBrandOAuthAppCreds } from '../../../../../oauth-app-creds.js';

export interface GoogleAdsOAuthCallbackInput {
  query: Record<string, string | string[] | undefined>;
  idempotencyKey: string;
}

export interface GoogleAdsOAuthCallbackResult {
  connectorInstanceId: string;
  brandId: string;
  /** Google Ads customer id (digits only), or null if not resolvable (honest). */
  adAccountId: string | null;
  /** All resolved Google Ads customer ids (Gap B). */
  adAccountIds: string[];
  status: 'connected';
}

export class GoogleAdsStateNonceError extends Error {
  constructor(message = 'State nonce invalid or expired') {
    super(message);
    this.name = 'GoogleAdsStateNonceError';
  }
}

export class GoogleAdsOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAdsOAuthError';
  }
}

export class HandleGoogleAdsOAuthCallbackCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly stateStore: IOAuthStateStore,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
    private readonly setAdAccountId?: SetAdAccountIdFn,
  ) {}

  async execute(input: GoogleAdsOAuthCallbackInput): Promise<GoogleAdsOAuthCallbackResult> {
    const { query, idempotencyKey } = input;

    // ── Step 1: State nonce → brand_id (D-1) ──────────────────────────────────
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    if (!state) {
      throw new GoogleAdsStateNonceError('State parameter missing');
    }
    const stateRecord = await this.stateStore.consumeAndGetBrandId(state);
    if (!stateRecord) {
      throw new GoogleAdsStateNonceError('State nonce not found, expired, or already used');
    }
    const brandId = stateRecord.brandId; // server-trusted — never from query

    // ── Step 2: Token exchange → refresh_token ────────────────────────────────
    const code = typeof query['code'] === 'string' ? query['code'] : '';
    if (!code) {
      throw new GoogleAdsOAuthError('Authorization code missing from callback');
    }
    const { refreshToken, accessToken } = await this.exchangeCodeForTokens(code, brandId);

    // ── Step 3: Resolve ALL customer ids (Gap B) — best-effort; empty → __default__ ──
    const adAccountIds = await this.resolveAllCustomerIds(accessToken);
    const adAccountId = adAccountIds[0] ?? null;

    // ── Step 4: Store the bundle in Secrets Manager → ARN (NN-2 / I-S09) ───────
    const bundle: Record<string, string> = { refresh_token: refreshToken };
    if (adAccountId) bundle['ad_account_id'] = adAccountId;
    const { arn: secretRef } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'google_ads', subKey: adAccountId ?? undefined },
      bundle,
    );
    // refreshToken + accessToken are now discarded — only secretRef proceeds.

    // ── Step 5: Write one ConnectorInstance per customer (Gap B) ─────────────
    const accountsToCreate: Array<string | null> = adAccountIds.length > 0
      ? adAccountIds
      : [null];

    const now = new Date();
    let firstInstanceId = '';

    // 0106 ad-account activation: an MCC login exposes every accessible customer id (often other
    // brands'). Don't ingest any until the user picks ONE. EXCEPTION: a single account is
    // auto-activated (nothing to choose). Multiple → all NULL → the UI prompts for a selection.
    const autoActivate = accountsToCreate.length === 1;

    for (const accountId of accountsToCreate) {
      const instanceId = randomUUID();
      if (!firstInstanceId) firstInstanceId = instanceId;

      const instance = ConnectorInstance.create({
        id: instanceId,
        brandId,
        provider: 'google_ads',
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
        providerConfig: accountId ? { google_ads_customer_id: accountId } : {},
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

    // ── Step 7: emit connector.connected (NO token, NO secret_ref) ────────────
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: firstInstanceId,
      provider: 'google_ads',
      ad_account_id: adAccountId,
      ad_account_ids: adAccountIds,
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

  /** Exchange the authorization code for {refresh_token, access_token} via Google's token endpoint. */
  private async exchangeCodeForTokens(
    code: string,
    brandId: string,
  ): Promise<{ refreshToken: string; accessToken: string }> {
    const creds = await resolveBrandOAuthAppCreds(this.secretsManager, 'google_ads', brandId, {
      clientId: process.env['GOOGLE_ADS_CLIENT_ID'] ?? '',
      clientSecret: process.env['GOOGLE_ADS_CLIENT_SECRET'] ?? '',
    });
    const callbackUrl = process.env['GOOGLE_ADS_CALLBACK_URL'];
    if (!creds?.clientId || !creds?.clientSecret) {
      throw new Error(
        '[HandleGoogleAdsOAuthCallbackCommand] GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET not configured',
      );
    }

    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      ...(callbackUrl ? { redirect_uri: callbackUrl } : {}),
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new GoogleAdsOAuthError(`Token exchange failed (${response.status})`);
    }

    const data = (await response.json()) as { refresh_token?: string; access_token?: string };
    if (!data.refresh_token) {
      // No refresh token = offline access was not granted (user previously consented without
      // prompt=consent). Surface honestly — without it the repull cannot mint access tokens.
      throw new GoogleAdsOAuthError(
        'Token exchange: refresh_token missing (offline access not granted — re-consent required)',
      );
    }
    return { refreshToken: data.refresh_token, accessToken: data.access_token ?? '' };
  }

  /**
   * Resolve ALL accessible Google Ads customer ids via customers:listAccessibleCustomers (Gap B).
   * Returns an array of customer ids (digits only, e.g. ['1234567890', '9876543210']).
   * Returns empty array on any failure — caller falls back to __default__ instance.
   */
  private async resolveAllCustomerIds(accessToken: string): Promise<string[]> {
    const devToken = process.env['GOOGLE_ADS_DEVELOPER_TOKEN'];
    if (!accessToken || !devToken) return [];
    try {
      const response = await fetch(
        'https://googleads.googleapis.com/v24/customers:listAccessibleCustomers',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': devToken,
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) return [];
      const data = (await response.json()) as { resourceNames?: string[] };
      return (data.resourceNames ?? [])
        .map((name) => name.split('/')[1])
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch {
      return [];
    }
  }
}
