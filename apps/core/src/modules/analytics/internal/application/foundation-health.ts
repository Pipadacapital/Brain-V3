/**
 * foundation-health.ts — the Data Foundation Health readiness verdict (P1).
 *
 * Brain's spine starts at the data foundation: "everything depends on the data foundation; the user
 * should never reach empty or misleading experiences." Today the underlying signals exist (pixel
 * installed, commerce connected + healthy, sync started, events flowing & fresh, DQ trust tier) but
 * are scattered with no single readiness verdict to gate progression on. This PURE function rolls
 * them into one deterministic, fail-closed verdict + a guided next step.
 *
 * Tiers (never overstate readiness):
 *   blocked  — can't capture truth yet (no commerce connection OR no pixel).
 *   building — capturing, but data isn't flowing/fresh yet (no first event / no sync / stale).
 *   ready    — enough to act with confidence context (data fresh, foundation established).
 *   healthy  — fully trusted (DQ trusted + live freshness + healthy commerce link).
 *
 * PURE: takes signals + `nowMs`, returns the verdict. The BFF gathers the signals (composing the
 * existing getDataHealth / getMetricTrust / pixel + connector reads) and calls this.
 */

export type FoundationTier = 'blocked' | 'building' | 'ready' | 'healthy';
export type Freshness = 'live' | 'lagging' | 'stale' | 'unknown';
export type FoundationDqTier = 'trusted' | 'estimated' | 'untrusted';

export interface FoundationSignals {
  /** Brain Pixel installed (pixel_installation.installed_at IS NOT NULL). */
  pixelInstalled: boolean;
  /** A commerce connector (Shopify) is connected. */
  commerceConnected: boolean;
  /** The commerce connector's health is a working state (not Failed/Disconnected/TokenExpired/Disabled). */
  commerceHealthy: boolean;
  /** A connector sync has been attempted (connector_sync_status row exists). */
  initialSyncStarted: boolean;
  /** At least one Bronze event has been received. */
  firstEventReceived: boolean;
  /** Ingest freshness derived from the last Bronze ingest. */
  freshness: Freshness;
  /** The brand's effective data-quality trust tier (from getMetricTrust). */
  dqTier: FoundationDqTier;
}

export interface FoundationStep {
  key: string;
  label: string;
  done: boolean;
}

export interface NextAction {
  label: string;
  href: string;
}

export interface FoundationHealth {
  tier: FoundationTier;
  /** True when the foundation supports trusted analytics/decisions (tier ready|healthy). */
  ready: boolean;
  /** The ordered progression checklist with done flags. */
  steps: FoundationStep[];
  /** Human-readable list of what's still missing/degraded. */
  gaps: string[];
  /** The single most important next step (null when nothing to do). */
  nextAction: NextAction | null;
  /** A one-line honest headline for the surface. */
  headline: string;
}

const LAGGING_AFTER_HOURS = 6;
const STALE_AFTER_HOURS = 24;

/** Derive ingest freshness from the last Bronze ingest timestamp (mirrors the web thresholds). */
export function freshnessFromIngest(lastIngestAtIso: string | null, nowMs: number): Freshness {
  if (!lastIngestAtIso) return 'unknown';
  const t = Date.parse(lastIngestAtIso);
  if (Number.isNaN(t)) return 'unknown';
  const ageHours = (nowMs - t) / 3_600_000;
  if (ageHours < 0) return 'live'; // clock skew — treat as live, never stale
  if (ageHours < LAGGING_AFTER_HOURS) return 'live';
  if (ageHours < STALE_AFTER_HOURS) return 'lagging';
  return 'stale';
}

const STEP_ACTION: Record<string, NextAction> = {
  commerce: { label: 'Connect your store', href: '/settings/connectors' },
  pixel: { label: 'Install the Brain Pixel', href: '/settings/pixel' },
  first_event: { label: 'Verify the pixel is firing', href: '/settings/pixel' },
  sync: { label: 'Check connector sync', href: '/settings/connectors' },
  fresh: { label: 'Review data health', href: '/data/health' },
  trusted: { label: 'Review data quality', href: '/data/quality' },
};

/** computeFoundationHealth — PURE deterministic readiness verdict. */
export function computeFoundationHealth(s: FoundationSignals): FoundationHealth {
  const freshOk = s.freshness === 'live' || s.freshness === 'lagging';
  const steps: FoundationStep[] = [
    { key: 'commerce', label: 'Connect your store', done: s.commerceConnected },
    { key: 'pixel', label: 'Install the Brain Pixel', done: s.pixelInstalled },
    { key: 'first_event', label: 'First data received', done: s.firstEventReceived },
    { key: 'sync', label: 'Initial sync started', done: s.initialSyncStarted },
    { key: 'fresh', label: 'Data is flowing & fresh', done: freshOk },
    { key: 'trusted', label: 'Data quality trusted', done: s.dqTier === 'trusted' },
  ];

  // Tier — fail-closed (only claim higher readiness when every prerequisite holds).
  let tier: FoundationTier;
  if (!s.commerceConnected || !s.pixelInstalled) {
    tier = 'blocked';
  } else if (!s.firstEventReceived || !s.initialSyncStarted || !freshOk) {
    tier = 'building';
  } else if (s.dqTier === 'trusted' && s.freshness === 'live' && s.commerceHealthy) {
    tier = 'healthy';
  } else {
    tier = 'ready';
  }
  const ready = tier === 'ready' || tier === 'healthy';

  const gaps = steps.filter((st) => !st.done).map((st) => st.label);
  const firstGap = steps.find((st) => !st.done);
  let nextAction: NextAction | null = firstGap ? (STEP_ACTION[firstGap.key] ?? null) : null;

  // A connected-but-unhealthy commerce link is a distinct gap even when the checklist passes.
  if (s.commerceConnected && !s.commerceHealthy && tier !== 'blocked') {
    gaps.unshift('Reconnect your store — the connection is unhealthy');
    nextAction = nextAction ?? STEP_ACTION['commerce']!;
  }

  const headline =
    tier === 'blocked'
      ? 'Set up your data foundation to unlock Brain.'
      : tier === 'building'
        ? 'Your data foundation is building — numbers firm up as data flows in.'
        : tier === 'ready'
          ? 'Your data foundation is ready. Some metrics are still estimated.'
          : 'Your data foundation is healthy and trusted.';

  return { tier, ready, steps, gaps, nextAction, headline };
}
