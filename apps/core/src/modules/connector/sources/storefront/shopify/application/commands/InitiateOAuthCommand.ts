/**
 * InitiateOAuthCommand — generates the Shopify OAuth install URL.
 *
 * NN-4: state nonce is generated with crypto.randomBytes(16), stored server-side
 * keyed to (brandId, state), with 15-min TTL. Single-use: consumed on callback.
 *
 * Shopify client secret is fetched from Secrets Manager (never from env in prod).
 */
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../../infrastructure/state/IOAuthStateStore.js';
import { OAuthStateNonce } from '../../domain/value-objects/OAuthStateNonce.js';

export interface InitiateOAuthInput {
  brandId: string;
  shopDomain: string;
  callbackUrl: string; // public HTTPS callback URL (C5: requires staging env for E2E)
  /**
   * Per-brand BYO-app OAuth client_id (resolved by the connect handler: the brand's own app creds,
   * else the env app). When absent, falls back to process.env.SHOPIFY_CLIENT_ID for back-compat.
   */
  clientId?: string;
}

export interface InitiateOAuthResult {
  installUrl: string;
  state: string; // echoed so the caller can redirect
}

/**
 * Required Shopify OAuth scopes.
 *  - read_orders/products/customers — the M1 read-sync ground truth.
 *  - write_script_tags — auto-inject the Brain pixel on the online store (production install path).
 *  - write_pixels + read_customer_events — the Web Pixels API path (checkout + storefront event
 *    coverage) once the web-pixel extension is deployed (feat-pixel-production-install, "laid").
 * NOTE: connections made before these scopes were added must RECONNECT to grant them — the auto
 * install surfaces a clear "reconnect to grant pixel-install permission" error on a 403.
 */
const SHOPIFY_SCOPES =
  'read_orders,read_products,read_customers,write_script_tags,write_pixels,read_customer_events';

export class InitiateOAuthCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly stateStore: IOAuthStateStore,
  ) {}

  async execute(input: InitiateOAuthInput): Promise<InitiateOAuthResult> {
    const { brandId, shopDomain, callbackUrl } = input;

    // Per-brand BYO-app client_id (resolved by the connect handler) → env app (back-compat).
    // The client SECRET is not needed at initiation — only at callback.
    const clientId = input.clientId ?? process.env['SHOPIFY_CLIENT_ID'];
    if (!clientId) {
      throw Object.assign(new Error('no Shopify client_id — provide your app credentials or set SHOPIFY_CLIENT_ID'), {
        code: 'OAUTH_NOT_CONFIGURED',
        statusCode: 503,
      });
    }

    // Generate state nonce (NN-4: crypto.randomBytes(16))
    const nonce = OAuthStateNonce.generate(brandId);

    // Store server-side with TTL (NN-4: brand-bound, single-use, ≤15-min)
    await this.stateStore.set(brandId, nonce.value, OAuthStateNonce.TTL_SECONDS);

    // Build Shopify install URL
    const params = new URLSearchParams({
      client_id: clientId,
      scope: SHOPIFY_SCOPES,
      redirect_uri: callbackUrl,
      state: nonce.value,
      'grant_options[]': 'per-user',
    });

    const installUrl = `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;

    return { installUrl, state: nonce.value };
  }
}
