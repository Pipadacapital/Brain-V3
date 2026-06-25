/**
 * InitiateGoogleAdsOAuthCommand — generates the Google Ads OAuth install URL.
 *
 * feat-ad-connectors Track 1 (ADR-AD-2). Same shape as the Meta initiate command.
 * The state nonce IS the authentication (NN-4): 128-bit, brand-bound, single-use,
 * 15-min TTL. The brand is bound INTO the nonce record so the callback derives it
 * server-side, NEVER from the query body (D-1).
 *
 * Google scope = `https://www.googleapis.com/auth/adwords` (Ads API access).
 * `access_type=offline` + `prompt=consent` so Google returns a REFRESH token (Google
 * access tokens are short-lived; the repull job exchanges refresh→access at run start).
 */
import { loadCoreConfig } from '@brain/config';
import type { IOAuthStateStore } from '../../../../storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import { OAuthStateNonce } from '../../../../storefront/shopify/domain/value-objects/OAuthStateNonce.js';

export interface InitiateGoogleAdsOAuthInput {
  brandId: string;
  /** Public HTTPS callback URL (dev: localhost; prod: a real public callback — platform follow-up). */
  callbackUrl: string;
  /** Per-brand BYO-app client_id (resolved by the connect handler); falls back to env. */
  clientId?: string;
}

export interface InitiateGoogleAdsOAuthResult {
  installUrl: string;
  state: string;
}

/** Google Ads API access scope. */
const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

export class InitiateGoogleAdsOAuthCommand {
  constructor(private readonly stateStore: IOAuthStateStore) {}

  async execute(input: InitiateGoogleAdsOAuthInput): Promise<InitiateGoogleAdsOAuthResult> {
    const { brandId, callbackUrl } = input;

    const clientId = input.clientId ?? loadCoreConfig().GOOGLE_ADS_CLIENT_ID;
    if (!clientId) {
      // Dev boundary: real Google Ads OAuth needs a configured app (GOOGLE_ADS_CLIENT_ID +
      // secret + a public callback). Surface a graceful, typed error the route maps to a
      // friendly 503 instead of a raw 500.
      const err = new Error(
        'Google Ads connection isn’t configured in this environment yet. ' +
          'Add the Google Ads app credentials (GOOGLE_ADS_CLIENT_ID) to enable it.',
      );
      (err as Error & { code: string; statusCode: number }).code = 'OAUTH_NOT_CONFIGURED';
      (err as Error & { code: string; statusCode: number }).statusCode = 503;
      throw err;
    }

    // NN-4: 128-bit nonce, brand-bound, single-use, ≤15-min TTL.
    const nonce = OAuthStateNonce.generate(brandId);
    await this.stateStore.set(brandId, nonce.value, OAuthStateNonce.TTL_SECONDS);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: GOOGLE_ADS_SCOPE,
      state: nonce.value,
      access_type: 'offline', // request a refresh token
      prompt: 'consent', // force refresh-token issuance on re-consent
      include_granted_scopes: 'true',
    });

    const installUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return { installUrl, state: nonce.value };
  }
}
