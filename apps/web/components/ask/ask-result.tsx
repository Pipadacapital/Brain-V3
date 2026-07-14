'use client';

/**
 * Ask Brain result primitives — the honesty UX made visible (Phase 8, requirement §6).
 *
 * The four guarantees rendered here:
 *   1. BINDING — the resolved metric is shown in PLAIN language ("Realized revenue"). The model
 *      SELECTED this from the registry; it did not invent it. The raw metric_id/version live
 *      only inside the "Technical details" disclosure (never leaked as jargon into the headline).
 *   2. CERTIFIED NUMBER — computed by the metric-engine (I-ST01). Money is bigint-minor strings
 *      + currency_code, rendered with formatMoneyDisplay (never /100, never BigInt(undefined)).
 *   3. CONFIDENCE — a PLAIN Trusted/Estimated/Not-yet-reliable banner (icon + text label + an
 *      aria-label carrying the full verdict; never colour-only, WCAG 1.4.1). The raw grade letter
 *      is tucked into the disclosure, not shouted in the banner.
 *   4. PROVENANCE — metric_id + version + data snapshot behind a "Technical details" disclosure:
 *      "computed, not generated." Reproducible, but not in the shopkeeper's face.
 *
 * A refusal renders NO number — the honest "no certified metric answers this" card.
 */

import * as React from 'react';
import { CheckCircle2, ShieldAlert, Sparkles, Hash, Database, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { plainConfidence } from '@/lib/format/plain-language';
import type { CurrencyCode } from '@brain/money';
import type {
  AskMetricId,
  AskComputedNumber,
  AskTrustTier,
  AskConfidenceGrade,
  AskBinding,
} from '@/lib/api/types';

// ── Registry metric_id → PLAIN human label (no acronyms reach the DOM) ────────

const METRIC_LABELS: Record<AskMetricId, string> = {
  realized_revenue: 'Realized revenue',
  provisional_revenue: 'Provisional revenue',
  ad_spend: 'Ad spend',
  blended_roas: 'Return on ad spend',
  cod_rto_rate: 'Cash-on-delivery return rate',
  cod_mix: 'Cash-on-delivery share of orders',
  checkout_funnel: 'Checkout funnel',
  order_status_mix: 'Order-status mix',
  journey_first_touch_mix: 'First-touch channel mix',
  journey_stitch_rate: 'Journeys we could connect',
  journey_timeline: 'Journey timeline',
  attribution_credit: 'Attributed revenue',
  attribution_reconciliation_rate: 'Attribution match rate',
  attribution_confidence: 'Attribution confidence',
  cost_confidence: 'Cost confidence',
  effective_confidence: 'Overall confidence',
};

export function metricLabel(id: string): string {
  return METRIC_LABELS[id as AskMetricId] ?? id;
}

// ── metric_id → the closest existing drill (records behind the number) ─────────

const METRIC_DRILL: Record<AskMetricId, { href: string; label: string }> = {
  realized_revenue: { href: '/analytics/revenue', label: 'See the revenue records behind this' },
  provisional_revenue: { href: '/analytics/revenue', label: 'See the revenue records behind this' },
  ad_spend: { href: '/analytics/spend', label: 'See the ad-spend records behind this' },
  blended_roas: { href: '/analytics/spend', label: 'See the spend & revenue behind this' },
  cod_rto_rate: { href: '/analytics/cod-rto', label: 'See the cash-on-delivery orders behind this' },
  cod_mix: { href: '/analytics/cod-rto', label: 'See the cash-on-delivery orders behind this' },
  checkout_funnel: { href: '/analytics/checkout', label: 'See the checkout steps behind this' },
  order_status_mix: { href: '/analytics/order-status', label: 'See the orders behind this' },
  journey_first_touch_mix: { href: '/analytics/journey', label: 'See the customer journeys behind this' },
  journey_stitch_rate: { href: '/analytics/journey', label: 'See the customer journeys behind this' },
  journey_timeline: { href: '/journeys', label: 'See the customer journeys behind this' },
  attribution_credit: { href: '/analytics/attribution', label: 'See the attribution breakdown behind this' },
  attribution_reconciliation_rate: {
    href: '/analytics/attribution',
    label: 'See the attribution breakdown behind this',
  },
  attribution_confidence: { href: '/analytics/attribution', label: 'See the attribution breakdown behind this' },
  cost_confidence: { href: '/analytics/spend', label: 'See the ad-spend records behind this' },
  effective_confidence: { href: '/analytics/attribution', label: 'See the attribution breakdown behind this' },
};

/** The closest existing records-drill for a metric (never invents an endpoint). */
export function askMetricDrill(id: string): { href: string; label: string } {
  return METRIC_DRILL[id as AskMetricId] ?? { href: '/data', label: 'See your data' };
}

// ── Binding badge — the resolved metric in PLAIN language (no raw code) ────────

export function AskBindingBadge({ binding }: { binding: AskBinding }) {
  const label = metricLabel(binding.metric_id);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
      aria-label={`Matched to the certified metric: ${label}`}
      data-testid="ask-binding"
    >
      <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

// ── Certified number — money via formatMoneyDisplay; never a fabricated value ──

/** Known render currencies (matches money-display MINOR_DIVISORS). Guard before formatting. */
const RENDER_CURRENCIES = new Set<string>(['INR', 'AED', 'SAR']);

/**
 * AskCertifiedNumber — renders core's ComputedNumber. Money is the per-currency `money` map
 * (bigint-minor strings). figure_kind:'none' = a valid binding whose figure path isn't wired
 * (honest, no number). Empty/null money is rendered as an em dash — never a fabricated 0.
 */
export function AskCertifiedNumber({ number }: { number: AskComputedNumber }) {
  // Honest empty — the brand has no data for this metric yet. Never a fabricated 0.
  if (number.no_data) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="ask-number-no-data">
        No data for this metric yet — as your orders, spend, and connectors fill in, the certified
        number appears here.
      </p>
    );
  }

  // Non-money scalar (ratio / percent) — the engine's exact decimal, formatted for display.
  if ((number.figure_kind === 'ratio' || number.figure_kind === 'percent') && number.scalar) {
    return (
      <p className="text-3xl font-bold text-foreground leading-tight tabular-nums" data-testid="ask-number">
        {number.scalar.display}
        {number.scalar.currency_code ? (
          <span className="ml-2 align-middle text-sm font-normal text-muted-foreground">
            {number.scalar.currency_code}
          </span>
        ) : null}
      </p>
    );
  }

  if (number.figure_kind === 'money' && number.money) {
    const entries = Object.entries(number.money);
    if (entries.length === 0) {
      // Honest: the engine returned no currency rows. Never fabricate a 0.
      return (
        <p className="text-3xl font-bold text-foreground" data-testid="ask-number">
          —
        </p>
      );
    }
    return (
      <div className="space-y-1" data-testid="ask-number">
        {entries.map(([ccy, minor]) => (
          <p key={ccy} className="text-3xl font-bold text-foreground leading-tight tabular-nums">
            {/* Guard: only BigInt(minor) when present + currency is renderable (no BigInt(undefined)). */}
            {minor != null && RENDER_CURRENCIES.has(ccy)
              ? formatMoneyDisplay(minor, ccy as CurrencyCode)
              : `${ccy} ${minor ?? '—'}`}
          </p>
        ))}
      </div>
    );
  }

  // figure_kind:'none' (or money null without no_data) — a certified binding with no surfaced
  // number in this slice. Honest: we say so, never show a fabricated figure.
  return (
    <p
      className="text-sm text-muted-foreground"
      data-testid="ask-number-unavailable"
    >
      This metric is certified, but its full picture lives on its own dashboard rather than as a
      single number. Open the records below to see it — no number is invented here.
    </p>
  );
}

// ── Trust banner — PLAIN Trusted / Estimated / Not-yet-reliable (icon + label) ──

interface AskTrustBannerProps {
  tier: AskTrustTier;
  grade: AskConfidenceGrade;
  className?: string;
}

export function AskTrustBanner({ tier, grade, className }: AskTrustBannerProps) {
  if (tier === 'Trusted') {
    const conf = plainConfidence(grade) || "We're confident";
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={`Trusted answer. ${conf}. Data-quality grade ${grade}.`}
        className={cn(
          'flex items-start gap-2 rounded-lg border border-status-green-700/30 bg-status-green-50 p-3 text-sm text-status-green-700',
          className,
        )}
        data-testid="ask-trust-banner-trusted"
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <strong className="font-semibold">Trusted.</strong> {conf} — this number is certified
          from your own data and meets Brain&apos;s quality bar.
        </span>
      </div>
    );
  }

  const isUntrusted = tier === 'Untrusted';
  const conf = plainConfidence(grade) || 'Rough estimate';
  return (
    <div
      role="alert"
      aria-label={`${isUntrusted ? 'Not yet reliable' : 'Estimated'} answer. ${conf}. Data-quality grade ${grade}.`}
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-sm',
        isUntrusted
          ? 'border-status-red-700/30 bg-status-red-50 text-status-red-700'
          : 'border-status-amber-700/30 bg-status-amber-50 text-status-amber-700',
        className,
      )}
      data-testid="ask-trust-banner-estimated"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        <strong className="font-semibold">{isUntrusted ? 'Not yet reliable.' : 'Estimated.'}</strong>{' '}
        Brain calculated this number, but the data behind it is{' '}
        {isUntrusted ? 'low quality' : 'below the trusted bar'} — treat it as{' '}
        {isUntrusted ? 'indicative only' : 'an estimate'} until your data quality recovers.
      </span>
    </div>
  );
}

// ── Provenance — "computed, not generated." behind a Technical-details disclosure ──

interface AskProvenanceProps {
  binding: AskBinding;
  snapshotId: string;
  grade?: AskConfidenceGrade;
}

export function AskProvenance({ binding, snapshotId, grade }: AskProvenanceProps) {
  return (
    <details
      className="group rounded-md border border-border bg-muted/40 text-xs text-muted-foreground [&_summary::-webkit-details-marker]:hidden"
      data-testid="ask-provenance"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-2 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
        <span>Technical details — how this was computed</span>
      </summary>
      <div className="space-y-1.5 border-t border-border px-3 py-2">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <Database className="h-3.5 w-3.5" aria-hidden="true" />
            metric{' '}
            <span className="font-medium text-foreground">{binding.metric_id}</span>
            <span className="tabular-nums">{binding.metric_version}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Hash className="h-3.5 w-3.5" aria-hidden="true" />
            data snapshot{' '}
            <span className="font-mono tabular-nums" data-testid="ask-snapshot">
              {snapshotId}
            </span>
          </span>
          {grade && <span>data-quality grade {grade}</span>}
        </p>
        <p className="italic">
          Computed by Brain&apos;s metric engine from this data snapshot — not written by AI.
          Re-running this same metric against the same snapshot reproduces the exact number.
        </p>
      </div>
    </details>
  );
}
