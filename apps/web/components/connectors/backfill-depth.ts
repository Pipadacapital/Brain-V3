/**
 * backfill-depth.ts — pure helpers for the "Pull historical data" depth picker (BackfillControl).
 *
 * The trigger endpoint accepts an OPTIONAL BackfillTriggerRequest.requested_window_ms (0127); the
 * claimers clamp it to each provider manifest's maxBackfillWindowMs. These helpers build the
 * picker's option list per provider: fixed 30-day-month depths (3/6/12/24 mo) filtered to the
 * provider's max, plus a "Max" option (omit the window → provider max, the pre-0127 behaviour).
 *
 * PROVIDER_MAX_BACKFILL_MONTHS is a UI MIRROR of the ingestion manifests' maxBackfillWindowMs
 * (packages/shopify-mapper + @brain/connector-core manifests). It cannot be imported here — the
 * manifest barrels pull server-only modules into the client bundle — so parity is enforced by
 * backfill-depth.test.ts, which imports the real manifests (node-side) and asserts this map
 * matches floor(maxBackfillWindowMs / MONTH_MS) per provider. Keep in lock-step via that test.
 *
 * Pure (no React) so the helpers are unit-testable in isolation (storefront-exclusivity pattern).
 */

/** One 30-day month in ms — matches the claimers' month convention (computeAchievedDepthLabel). */
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Provider → max historical depth in whole 30-day months (floor of the manifest window).
 * ga4 is the only sub-24-month platform (GA4 API retention ≈ 14 months / 420 days).
 * Parity with the real manifests is test-enforced (see module doc).
 */
export const PROVIDER_MAX_BACKFILL_MONTHS: Readonly<Record<string, number>> = {
  shopify: 24,
  meta: 24,
  google_ads: 24,
  razorpay: 24,
  shiprocket: 24,
  ga4: 14,
};

/** Fallback for a provider missing from the map (Brain's default 2-year target). */
const DEFAULT_MAX_MONTHS = 24;

/** One selectable depth. `requestedWindowMs` undefined = "Max" (omit the body → provider max). */
export interface BackfillDepthOption {
  /** Stable option key for <select> values / testids. */
  readonly value: string;
  /** Human label, e.g. "Last 6 months" / "Max (24 months)". */
  readonly label: string;
  /** The window to send as requested_window_ms; undefined = provider max (no body). */
  readonly requestedWindowMs?: number;
}

/** The fixed month depths offered below the provider max. */
const FIXED_MONTH_STEPS = [3, 6, 12, 24] as const;

/** Max depth (whole 30-day months) for a provider — DEFAULT_MAX_MONTHS when unknown. */
export function providerMaxBackfillMonths(provider: string): number {
  return PROVIDER_MAX_BACKFILL_MONTHS[provider] ?? DEFAULT_MAX_MONTHS;
}

/**
 * Build the depth options for one provider: every fixed step STRICTLY below the provider max
 * (a step equal to or above the max is redundant — that's what "Max" is), then the "Max" option
 * labeled with the provider's real ceiling so the user is never promised depth the platform
 * cannot serve (honesty invariant).
 */
export function backfillDepthOptions(provider: string): readonly BackfillDepthOption[] {
  const maxMonths = providerMaxBackfillMonths(provider);
  const fixed: BackfillDepthOption[] = FIXED_MONTH_STEPS.filter((m) => m < maxMonths).map((m) => ({
    value: `${m}mo`,
    label: `Last ${m} months`,
    requestedWindowMs: m * MONTH_MS,
  }));
  return [...fixed, { value: 'max', label: `Max (${maxMonths} months)` }];
}

/** Resolve a picker value back to its requested window (undefined for 'max'/unknown). */
export function requestedWindowMsForValue(
  provider: string,
  value: string,
): number | undefined {
  return backfillDepthOptions(provider).find((o) => o.value === value)?.requestedWindowMs;
}
