/**
 * ad-platform — the set of advertising providers subject to ad-account activation (migration 0106).
 *
 * An ad-platform OAuth login (an agency / MCC account) exposes MANY ad accounts that may belong to
 * DIFFERENT brands. Brain must ingest only ONE chosen account per (brand, platform) or cross-brand
 * spend pollutes a single brand's ROAS/attribution. This is the SINGLE place that enumerates the
 * ad-platform providers; both the connect callbacks (auto-activate when exactly one account exists)
 * and the activate command/guard consult it. Adding a new ad platform (TikTok, X, …) = add it here
 * AND to the IN-lists in the 0106 enumeration functions.
 *
 * Storefront (shopify/woocommerce) and payment (razorpay/gokwik) providers are NOT ad platforms:
 * they always ingest when status='connected' and ignore activated_at.
 */

/** Advertising providers gated by ad-account activation. Keep in sync with 0106's SQL IN-lists. */
export const AD_PLATFORM_PROVIDERS = ['meta', 'google_ads'] as const;
export type AdPlatformProvider = (typeof AD_PLATFORM_PROVIDERS)[number];

/** True iff the provider is an advertising platform subject to ad-account activation. */
export function isAdPlatformProvider(provider: string): provider is AdPlatformProvider {
  return (AD_PLATFORM_PROVIDERS as readonly string[]).includes(provider);
}
