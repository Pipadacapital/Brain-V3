/**
 * entitlements.ts — readiness-driven progressive unlock (P2).
 *
 * Brain's rule: "progressive unlocks must depend on actual data readiness." A center or a connector
 * category is only unlocked once the data foundation can actually support it — so a brand never lands
 * on an empty/misleading surface, and the next thing to do is always clear. This is the SERVER's
 * source of truth for eligibility (the UI consumes it; gating is never hardcoded in the client).
 *
 * CONNECTOR-GENERAL: rules are keyed on the connector CATEGORY (storefront, ads, payments, logistics,
 * messaging, crm, analytics) — Shopify is just one storefront app of many. Adding a new integration
 * slots into its category and inherits that category's unlock rule; no per-app gating to maintain.
 *
 * PURE: takes the foundation tier + signals, returns the eligibility entries. The BFF gathers the
 * signals (composing the existing health reads) and calls this. Fail-closed: a center/category is
 * locked until its requirement is positively met.
 */

import type { FoundationTier, FoundationSignals } from './foundation-health.js';

export interface EntitlementEntry {
  /** Center key (identity|journey|attribution|decision) or connector category (storefront|ads|…). */
  key: string;
  /** True → unlocked/usable. False → locked until the requirement is met. */
  eligible: boolean;
  /** Why it's locked (null when eligible). */
  reason: string | null;
  /** What the brand must do to unlock it (null when eligible). */
  unlockHint: string | null;
}

export interface Entitlements {
  /** Eligibility for the gated product centers. */
  centers: EntitlementEntry[];
  /** Data-readiness eligibility per connector category (combined with static availability by the UI). */
  connectorCategories: EntitlementEntry[];
}

export interface EntitlementInput {
  tier: FoundationTier;
  signals: FoundationSignals;
}

/** A requirement = a predicate over the readiness state + the user-facing hint when unmet. */
interface Requirement {
  key: string;
  met: (i: EntitlementInput) => boolean;
  reason: string;
  unlockHint: string;
}

// ── Readiness predicates (composable, foundation-general) ─────────────────────
const storefrontConnected = (i: EntitlementInput): boolean => i.signals.commerceConnected;
const foundationEstablished = (i: EntitlementInput): boolean =>
  i.signals.commerceConnected && i.signals.pixelInstalled && i.signals.firstEventReceived;
const foundationReady = (i: EntitlementInput): boolean => i.tier === 'ready' || i.tier === 'healthy';

// ── Center unlock matrix ──────────────────────────────────────────────────────
const CENTER_REQUIREMENTS: readonly Requirement[] = [
  {
    key: 'identity',
    met: (i) => i.signals.firstEventReceived,
    reason: 'No data has arrived yet, so there are no identities to resolve.',
    unlockHint: 'Install the Brain Pixel and start receiving events.',
  },
  {
    key: 'journey',
    met: (i) => i.signals.pixelInstalled && i.signals.firstEventReceived,
    reason: 'Journeys are reconstructed from pixel events, which are not flowing yet.',
    unlockHint: 'Install the Brain Pixel and start receiving events.',
  },
  {
    key: 'attribution',
    met: foundationReady,
    reason: 'Attribution needs journeys + revenue truth from a ready data foundation.',
    unlockHint: 'Unlocks once your store is connected, the pixel is firing, and data is flowing.',
  },
  {
    key: 'decision',
    met: foundationReady,
    reason: 'Decisions require a ready data foundation so recommendations are trustworthy.',
    unlockHint: 'Unlocks once your store is connected, the pixel is firing, and data is flowing.',
  },
];

// ── Connector-category unlock matrix (data-readiness gate; availability is separate) ──
const CONNECT_STOREFRONT_FIRST = 'Connect a storefront first — it anchors revenue truth.';
const CATEGORY_REQUIREMENTS: readonly Requirement[] = [
  // storefront has no readiness gate — it IS the foundation root (always eligible).
  {
    key: 'payments',
    met: storefrontConnected,
    reason: 'Payment settlements reconcile against your store orders.',
    unlockHint: CONNECT_STOREFRONT_FIRST,
  },
  {
    key: 'logistics',
    met: storefrontConnected,
    reason: 'Logistics outcomes (RTO/delivery) attach to your store orders.',
    unlockHint: CONNECT_STOREFRONT_FIRST,
  },
  {
    key: 'ads',
    met: foundationEstablished,
    reason: 'Ad ROAS needs revenue truth + journeys from an established foundation.',
    unlockHint: 'Connect a storefront, install the pixel, and start receiving data.',
  },
  {
    key: 'messaging',
    met: foundationReady,
    reason: 'Outreach requires a ready, trusted data foundation (and consent).',
    unlockHint: 'Unlocks once your store is connected and data is flowing.',
  },
];

/** All connector categories — those without a readiness requirement are always eligible. */
const ALL_CATEGORIES = [
  'storefront',
  'ads',
  'payments',
  'logistics',
  'messaging',
  'crm',
  'analytics',
] as const;

function evaluate(reqs: readonly Requirement[], input: EntitlementInput): Map<string, EntitlementEntry> {
  const out = new Map<string, EntitlementEntry>();
  for (const r of reqs) {
    const eligible = r.met(input);
    out.set(r.key, {
      key: r.key,
      eligible,
      reason: eligible ? null : r.reason,
      unlockHint: eligible ? null : r.unlockHint,
    });
  }
  return out;
}

/** computeEntitlements — PURE readiness-driven eligibility for centers + connector categories. */
export function computeEntitlements(input: EntitlementInput): Entitlements {
  const centers = [...evaluate(CENTER_REQUIREMENTS, input).values()];

  const catEval = evaluate(CATEGORY_REQUIREMENTS, input);
  const connectorCategories: EntitlementEntry[] = ALL_CATEGORIES.map(
    (key) => catEval.get(key) ?? { key, eligible: true, reason: null, unlockHint: null },
  );

  return { centers, connectorCategories };
}
