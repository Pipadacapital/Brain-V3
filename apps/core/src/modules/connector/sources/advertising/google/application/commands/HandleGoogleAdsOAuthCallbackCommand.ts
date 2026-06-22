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
 * Invariants (identical to Meta):
 *   - NO HMAC. The state nonce IS the auth. brand_id from consumeAndGetBrandId(state) ONLY (D-1).
 *   - The refresh token NEVER touches Postgres (NN-2 / I-S09) — only the ARN is stored.
 *   - provider='google_ads', shopDomain=''.
 */
import { randomUUID } from 'node:crypto';
import { ConnectorInstance } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../../../../storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import type { SetAdAccountIdFn } from '../../../meta/application/commands/HandleMetaOAuthCallbackCommand.js';

export interface GoogleAdsOAuthCallbackInput {
  query: Record<string, string | string[] | undefined>;
  idempotencyKey: string;
}

export interface GoogleAdsOAuthCallbackResult {
  connectorInstanceId: string;
  brandId: string;
  /** Google Ads customer id (digits only), or null if not resolvable (honest). */
  adAccountId: string | null;
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
    const { refreshToken, accessToken } = await this.exchangeCodeForTokens(code);

    // ── Step 3: Resolve customer id (best-effort; null is honest) ─────────────
    const adAccountId = await this.resolveCustomerId(accessToken);

    // ── Step 4: Store the bundle in Secrets Manager → ARN (NN-2 / I-S09) ───────
    // Bundle: { refresh_token, ad_account_id }. The refresh token is the durable secret.
    const bundle: Record<string, string> = { refresh_token: refreshToken };
    if (adAccountId) bundle['ad_account_id'] = adAccountId;
    const { arn: secretRef } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'google_ads', subKey: adAccountId ?? undefined },
      bundle,
    );
    // refreshToken + accessToken are now discarded — only secretRef proceeds.

    // ── Step 5: Write connector_instance ──────────────────────────────────────
    const instanceId = randomUUID();
    const now = new Date();
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
    });
    const savedInstance = await this.connectorRepo.save(instance);

    if (adAccountId && this.setAdAccountId) {
      await this.setAdAccountId(brandId, savedInstance.id, adAccountId);
    }

    // ── Step 6: connector_sync_status ─────────────────────────────────────────
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

    // ── Step 7: emit connector.connected (NO token, NO secret_ref) ────────────
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: savedInstance.id,
      provider: 'google_ads',
      ad_account_id: adAccountId,
      idempotency_key: idempotencyKey,
    });

    return {
      connectorInstanceId: savedInstance.id,
      brandId,
      adAccountId,
      status: 'connected',
    };
  }

  /** Exchange the authorization code for {refresh_token, access_token} via Google's token endpoint. */
  private async exchangeCodeForTokens(
    code: string,
  ): Promise<{ refreshToken: string; accessToken: string }> {
    const clientId = process.env['GOOGLE_ADS_CLIENT_ID'];
    const clientSecret = process.env['GOOGLE_ADS_CLIENT_SECRET'];
    const callbackUrl = process.env['GOOGLE_ADS_CALLBACK_URL'];
    if (!clientId || !clientSecret) {
      throw new Error(
        '[HandleGoogleAdsOAuthCallbackCommand] GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET not configured',
      );
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      ...(callbackUrl ? { redirect_uri: callbackUrl } : {}),
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000), // T2-9: bound the token exchange so the OAuth callback can't hang.
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
   * Best-effort resolution of the first accessible customer id via
   * customers:listAccessibleCustomers. Returns null on any failure (honest).
   * Requires a developer token; in dev (no approved token) this returns null and the
   * connector still connects (the repull job resolves the customer at run time).
   */
  private async resolveCustomerId(accessToken: string): Promise<string | null> {
    const devToken = process.env['GOOGLE_ADS_DEVELOPER_TOKEN'];
    if (!accessToken || !devToken) return null;
    try {
      const response = await fetch(
        'https://googleads.googleapis.com/v24/customers:listAccessibleCustomers',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': devToken,
          },
          signal: AbortSignal.timeout(15_000), // T2-9: bound the best-effort customer resolution.
        },
      );
      if (!response.ok) return null;
      const data = (await response.json()) as { resourceNames?: string[] };
      const first = data.resourceNames?.[0]; // "customers/1234567890"
      const id = first?.split('/')[1];
      return id ?? null;
    } catch {
      return null;
    }
  }
}
