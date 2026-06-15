/**
 * InitiateOAuthCommand — generates the Shopify OAuth install URL.
 *
 * NN-4: state nonce is generated with crypto.randomBytes(16), stored server-side
 * keyed to (brandId, state), with 15-min TTL. Single-use: consumed on callback.
 *
 * Shopify client secret is fetched from Secrets Manager (never from env in prod).
 */
import type { ISecretsManager } from '../../infrastructure/secrets/ISecretsManager.js';
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

/** Required Shopify OAuth scopes for Brain M1. */
const SHOPIFY_SCOPES = 'read_orders,read_products,read_customers';

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
