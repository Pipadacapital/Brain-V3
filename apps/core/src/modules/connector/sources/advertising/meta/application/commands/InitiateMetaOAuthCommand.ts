/**
 * InitiateMetaOAuthCommand — generates the Meta (Facebook) Ads OAuth install URL.
 *
 * feat-ad-connectors Track 1 (ADR-AD-2). Clones the Shopify InitiateOAuthCommand
 * shape with one divergence: there is NO shopDomain — Meta authorize is a fixed
 * graph host. The state nonce IS the authentication (NN-4): generated with
 * crypto.randomBytes(16), stored server-side keyed to (brandId, state), 15-min TTL,
 * single-use. The brand is bound INTO the nonce record at initiation so the callback
 * derives it server-side, NEVER from the query body (ADR-AD-2 / D-1).
 *
 * Meta scope = `ads_read` (read-only spend/insights — least privilege).
 * Graph API pinned to v25.0 (verified current Feb-2026; resolve latest-stable at build).
 *
 * The Meta App Secret is NOT needed at initiation — only at callback token exchange.
 */
import { loadCoreConfig } from '@brain/config';
import type { IOAuthStateStore } from '../../../../storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import { OAuthStateNonce } from '../../../../storefront/shopify/domain/value-objects/OAuthStateNonce.js';

export interface InitiateMetaOAuthInput {
  brandId: string;
  /** Public HTTPS callback URL (dev: localhost; prod: a real public callback — platform follow-up). */
  callbackUrl: string;
  /** Per-brand BYO-app client_id (resolved by the connect handler); falls back to env. */
  clientId?: string;
}

export interface InitiateMetaOAuthResult {
  installUrl: string;
  state: string; // echoed so the caller can redirect
}

/** Graph API version — pinned (ADR-AD-3 build-note). */
export const META_GRAPH_API_VERSION = 'v25.0';

/** Least-privilege read-only scope for ad spend/insights. */
const META_SCOPES = 'ads_read';

export class InitiateMetaOAuthCommand {
  constructor(private readonly stateStore: IOAuthStateStore) {}

  async execute(input: InitiateMetaOAuthInput): Promise<InitiateMetaOAuthResult> {
    const { brandId, callbackUrl } = input;

    const clientId = input.clientId ?? loadCoreConfig().META_APP_ID;
    if (!clientId) {
      // Dev boundary: real Meta OAuth needs a configured app (META_APP_ID + secret + a
      // public callback). Surface a graceful, typed error the route maps to a friendly
      // 503 instead of a raw 500.
      const err = new Error(
        'Meta Ads connection isn’t configured in this environment yet. ' +
          'Add the Meta app credentials (META_APP_ID) to enable it.',
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
      scope: META_SCOPES,
      state: nonce.value,
      response_type: 'code',
    });

    const installUrl = `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;

    return { installUrl, state: nonce.value };
  }
}
