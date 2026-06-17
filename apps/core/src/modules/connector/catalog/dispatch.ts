/**
 * catalog/dispatch.ts — static OAuth dispatch table (ADR-CM-2 / Int-C3).
 *
 * RULE: static record, NOT a plugin registry / IConnector base class.
 * Unknown type ⇒ lookup returns null (caller must 400, never 500).
 * The existing ShopifyInitiateOAuthCommand is REGISTERED here, not reimplemented.
 *
 * meta/google_ads are NOT registered this slice — they are coming_soon → 422 before dispatch.
 */

export interface OAuthDispatch {
  /**
   * Initiate the OAuth flow for this connector type.
   * Returns the oauth_url to redirect the user to.
   */
  initiate(input: {
    brandId: string;
    shopDomain?: string;
    callbackUrl: string;
  }): Promise<{ oauth_url: string }>;
}

/**
 * The dispatch table registry (type → OAuthDispatch).
 * Entries are registered at startup by registerOAuthDispatch().
 * Mutable at init, then treated as read-only at request time.
 */
const OAUTH_DISPATCH_TABLE: Map<string, OAuthDispatch> = new Map();

/**
 * Register an OAuthDispatch handler for a connector type.
 * Called once at startup in the composition root (main.ts).
 * Idempotent — re-registering the same type overwrites (safe for test reuse).
 */
export function registerOAuthDispatch(type: string, handler: OAuthDispatch): void {
  OAUTH_DISPATCH_TABLE.set(type, handler);
}

/**
 * Look up the OAuth dispatch handler for a connector type.
 * Returns null if not registered (caller must handle — unknown type ⇒ 400 or 422).
 */
export function getOAuthDispatch(type: string): OAuthDispatch | null {
  return OAUTH_DISPATCH_TABLE.get(type) ?? null;
}
