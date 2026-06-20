'use client';

/**
 * Ask Brain result primitives — the honesty UX made visible (Phase 8, requirement §6).
 *
 * The four guarantees rendered here:
 *   1. BINDING — the resolved metric is shown explicitly ("realized_revenue v1"). The model
 *      SELECTED this from the registry; it did not invent it.
 *   2. CERTIFIED NUMBER — computed by the metric-engine (I-ST01). Money is bigint-minor strings
 *      + currency_code, rendered with formatMoneyDisplay (never /100, never BigInt(undefined)).
 *   3. CONFIDENCE — the Trusted/Estimated/Untrusted banner from Phase 7 (getMetricTrust). It is
 *      NEVER colour-only: icon + text label + an aria-label carrying the full verdict (WCAG 1.4.1).
 *   4. PROVENANCE — metric_id + version + snapshot_id: "computed, not generated." Reproducible.
 *
 * A refusal renders NO number — the honest "no certified metric answers this" card.
 */

import * as React from 'react';
import { CheckCircle2, ShieldAlert, Sparkles, Hash, Database } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type {
  AskMetricId,
  AskComputedNumber,
  AskTrustTier,
  AskConfidenceGrade,
  AskBinding,
} from '@/lib/api/types';

// ── Registry metric_id → human label (display only; the binding string is authoritative) ──

const METRIC_LABELS: Record<AskMetricId, string> = {
  realized_revenue: 'Realized revenue',
  provisional_revenue: 'Provisional revenue',
  ad_spend: 'Ad spend',
  blended_roas: 'Blended ROAS',
  cod_rto_rate: 'CoD RTO rate',
  cod_mix: 'CoD mix',
  checkout_funnel: 'Checkout funnel',
  order_status_mix: 'Order-status mix',
  journey_first_touch_mix: 'First-touch channel mix',
  journey_stitch_rate: 'Journey stitch rate',
  journey_timeline: 'Journey timeline',
  attribution_credit: 'Attributed revenue',
  attribution_reconciliation_rate: 'Attribution reconciliation rate',
  attribution_confidence: 'Attribution confidence',
  cost_confidence: 'Cost confidence',
  effective_confidence: 'Effective confidence',
};

function metricLabel(id: string): string {
  return METRIC_LABELS[id as AskMetricId] ?? id;
}

// ── Binding badge — the resolved metric made visible ─────────────────────────

export function AskBindingBadge({ binding }: { binding: AskBinding }) {
  const label = metricLabel(binding.metric_id);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      aria-label={`Resolved metric: ${label}, binding ${binding.metric_id} ${binding.metric_version}`}
      data-testid="ask-binding"
    >
      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="text-foreground">{label}</span>
      <span className="tabular-nums">
        {binding.metric_id}&nbsp;{binding.metric_version}
      </span>
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
      This metric is certified, but its figure isn&apos;t surfaced here yet. The binding and
      snapshot below let it be computed on demand — no number is invented.
    </p>
  );
}

// ── Trust banner — Trusted / Estimated / Untrusted (icon + label, NEVER colour-only) ──

interface AskTrustBannerProps {
  tier: AskTrustTier;
  grade: AskConfidenceGrade;
  className?: string;
}

export function AskTrustBanner({ tier, grade, className }: AskTrustBannerProps) {
  if (tier === 'Trusted') {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={`Trusted answer, confidence grade ${grade}`}
        className={cn(
          'flex items-start gap-2 rounded-lg border border-status-green-700/30 bg-status-green-50 p-3 text-sm text-status-green-700',
          className,
        )}
        data-testid="ask-trust-banner-trusted"
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <strong className="font-semibold">Trusted (grade {grade}).</strong>{' '}
          This number is certified by the metric-engine and meets the data-quality bar.
        </span>
      </div>
    );
  }

  const isUntrusted = tier === 'Untrusted';
  return (
    <div
      role="alert"
      aria-label={`${isUntrusted ? 'Untrusted' : 'Estimated'} answer, confidence grade ${grade}`}
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
        <strong className="font-semibold">
          {isUntrusted ? 'Untrusted' : 'Estimated'} (grade {grade}).
        </strong>{' '}
        The metric-engine computed this number, but the underlying data quality is{' '}
        {isUntrusted ? 'not trustworthy' : 'below the trusted bar'} — treat it as{' '}
        {isUntrusted ? 'indicative only' : 'an estimate'} until data quality recovers.
      </span>
    </div>
  );
}

// ── Provenance footer — "computed, not generated." (metric_id + version + snapshot_id) ──

interface AskProvenanceProps {
  binding: AskBinding;
  snapshotId: string;
  grade?: AskConfidenceGrade;
}

export function AskProvenance({ binding, snapshotId, grade }: AskProvenanceProps) {
  return (
    <div
      className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
      aria-label={`Provenance: metric ${binding.metric_id} version ${binding.metric_version}, snapshot ${snapshotId}${grade ? `, confidence ${grade}` : ''}. Computed, not generated.`}
      data-testid="ask-provenance"
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1">
          <Database className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="font-medium text-foreground">{binding.metric_id}</span>
          <span className="tabular-nums">{binding.metric_version}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Hash className="h-3.5 w-3.5" aria-hidden="true" />
          snapshot <span className="font-mono tabular-nums" data-testid="ask-snapshot">{snapshotId}</span>
        </span>
        {grade && <span>confidence {grade}</span>}
      </p>
      <p className="mt-1.5 italic">
        Computed by the metric-engine from this snapshot — not generated by a model. Re-running
        this binding at the snapshot reproduces the same number.
      </p>
    </div>
  );
}
