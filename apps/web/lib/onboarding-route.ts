/**
 * Onboarding route resolver — the single source of truth for forward-only wizard routing
 * (feat-onboarding-ux, Deliverable 5).
 *
 * `onboarding_status` lives in `organization.onboarding_status` (server-authoritative,
 * survives crash/refresh/new-device) and advances forward-only via the DB guard
 * (`advanceOnboardingStatus`, WHERE onboarding_step < $2). This resolver maps that status
 * → the route the user belongs on, so:
 *
 *   - On entry to any wizard page, the OnboardingGate forward-redirects when the user is
 *     PAST that page's step (browser Back to a completed step never re-shows a created form).
 *   - The merged create step + tracking interstitial + integrations + done all resolve from
 *     one table — no parallel status machine, no localStorage, no history manipulation.
 *
 * Step map (post-merge, 3 user-facing steps):
 *   Step 1  /onboarding/start         — merged create workspace + brand (Deliverable 3/4)
 *   (interstitial) /onboarding/tracking — pixel-ready / add-website (feat-onboarding-website)
 *   Step 2  /onboarding/integrations  — connect integrations
 *   Step 3  /onboarding/done          — done → /dashboard
 *
 * Both org_created and brand_created complete inside Step 1's single transaction; the
 * tracking interstitial is reached by the merged form pushing /onboarding/tracking?w=X
 * directly, and `brand_created` resolves forward to /onboarding/integrations from there.
 */

import type { OnboardingStatus } from '@/lib/api/types';

/** Wizard entry — the merged create step. Used by register/auto-login + login fallback. */
export const ONBOARDING_START = '/onboarding/start';

/**
 * Deterministic lookup: onboarding_status → the route the user belongs on.
 * Covers every enum value + null (no org membership yet → start).
 */
const ONBOARDING_RESUME: Record<OnboardingStatus | 'null', string> = {
  pending: ONBOARDING_START,
  org_created: ONBOARDING_START, // org exists but brand not yet → finish Step 1
  brand_created: '/onboarding/integrations',
  integration_selected: '/onboarding/done',
  complete: '/dashboard',
  null: ONBOARDING_START,
};

/** Ordinal position of each status — used by the gate to decide "is the user PAST this step?". */
const STATUS_ORDER: Record<OnboardingStatus | 'null', number> = {
  null: 0,
  pending: 0,
  org_created: 1,
  brand_created: 2,
  integration_selected: 3,
  complete: 4,
};

export function resolveOnboardingRoute(status: OnboardingStatus | null): string {
  if (status === null) return ONBOARDING_RESUME['null'];
  return ONBOARDING_RESUME[status] ?? '/dashboard';
}

/** Numeric rank of a status (null/pending = 0). Higher = further along. */
export function onboardingRank(status: OnboardingStatus | null): number {
  if (status === null) return STATUS_ORDER['null'];
  return STATUS_ORDER[status] ?? 0;
}
