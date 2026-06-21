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

    // Fetch client ID from Secrets Manager (or env for dev).
    // The client SECRET is not needed at initiation — only at callback.
    const clientId = process.env['SHOPIFY_CLIENT_ID'];
    if (!clientId) {
      throw new Error('[InitiateOAuthCommand] SHOPIFY_CLIENT_ID not configured');
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
