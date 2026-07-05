'use client';

/**
 * DQ status primitives — grade badge, freshness-SLA badge, trust-tier banner.
 *
 * A11y (accessibility skill §status-never-colour-only):
 *   - Every status carries icon + text label, NEVER colour alone (WCAG 1.4.1).
 *   - Status text uses -700 on -50 fill (4.5:1 contrast); badges expose an aria-label
 *     carrying the full verdict for screen readers.
 *   - The grade matrix cells (DqGradeBadge) pair the letter with a pass/fail glyph +
 *     an aria-label so the verdict is conveyed by text + shape, not the fill colour.
 *
 * These render values the metric-engine/BFF computed — the UI never derives a grade
 * or queries dq_check_result.
 */

import * as React from 'react';
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  DqLetterGrade,
  DqFreshnessSlaStatus,
  DqTrustTier,
} from '@/lib/api/types';

// ── Letter grade → trust band (display only; the gate decision is server-computed) ──

/** Map a letter grade to a colour band for the matrix cell (trusted vs estimated). */
function gradeBand(grade: DqLetterGrade): 'good' | 'warn' | 'bad' {
  switch (grade) {
    case 'A+':
    case 'A':
    case 'B':
      return 'good';
    case 'C':
      return 'warn';
    case 'D':
    default:
      return 'bad';
  }
}

const GRADE_BAND_CLS: Record<'good' | 'warn' | 'bad', string> = {
  good: 'bg-status-green-50 text-status-green-700 border-status-green-700/20',
  warn: 'bg-status-amber-50 text-status-amber-700 border-status-amber-700/20',
  bad: 'bg-status-red-50 text-status-red-700 border-status-red-700/20',
};

interface DqGradeBadgeProps {
  grade: DqLetterGrade;
  /** Whether the underlying check passed (drives the glyph — text/shape, not colour). */
  passing?: boolean;
  className?: string;
}

/**
 * DqGradeBadge — a frozen letter grade rendered with a pass/fail glyph + label.
 * Non-colour-only: the letter itself + the ✓/✗ glyph convey the verdict.
 */
export function DqGradeBadge({ grade, passing, className }: DqGradeBadgeProps) {
  const band = gradeBand(grade);
  const Icon = passing === false ? XCircle : band === 'good' ? CheckCircle2 : AlertTriangle;
  const verdict = passing === false ? 'failing' : 'passing';
  return (
    <span
      role="status"
      aria-label={`Grade ${grade}, ${verdict}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-bold tabular-nums',
        GRADE_BAND_CLS[band],
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{grade}</span>
    </span>
  );
}

// ── Freshness-SLA status badge ──────────────────────────────────────────────

const SLA_META: Record<
  DqFreshnessSlaStatus,
  { icon: React.ComponentType<{ className?: string }>; label: string; cls: string }
> = {
  green: {
    icon: CheckCircle2,
    label: 'On time',
    cls: 'bg-status-green-50 text-status-green-700',
  },
  at_risk: {
    icon: AlertTriangle,
    label: 'Falling behind',
    cls: 'bg-status-amber-50 text-status-amber-700',
  },
  breached: {
    icon: XCircle,
    label: 'Too old',
    cls: 'bg-status-red-50 text-status-red-700',
  },
};

interface FreshnessSlaBadgeProps {
  status: DqFreshnessSlaStatus;
  className?: string;
}

/** FreshnessSlaBadge — green / at-risk / breached, icon + label (never colour-only). */
export function FreshnessSlaBadge({ status, className }: FreshnessSlaBadgeProps) {
  const m = SLA_META[status] ?? {
    icon: HelpCircle,
    label: 'Unknown',
    cls: 'bg-muted text-muted-foreground',
  };
  const Icon = m.icon;
  return (
    <span
      role="status"
      aria-label={`Data freshness: ${m.label}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        m.cls,
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{m.label}</span>
    </span>
  );
}

// ── Trust-tier banner — "Estimated — excluded from billing/MMM" ──────────────

interface DqTrustBannerProps {
  tier: DqTrustTier;
  effectiveConfidence: DqLetterGrade;
  className?: string;
}

/**
 * DqTrustBanner — the explicit gate verdict. Only renders a warning when the metric
 * is Estimated/Untrusted (the honest "excluded from billing/MMM" callout). For Trusted
 * it renders a quiet confirmation so the verdict is never silent.
 */
export function DqTrustBanner({ tier, effectiveConfidence, className }: DqTrustBannerProps) {
  if (tier === 'trusted') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'flex items-start gap-2 rounded-lg border border-status-green-700/30 bg-status-green-50 p-3 text-sm text-status-green-700',
          className,
        )}
        data-testid="dq-trust-banner-trusted"
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <strong className="font-semibold">Trusted (grade {effectiveConfidence}).</strong>{' '}
          These numbers are reliable enough to bill against, feed your long-term marketing
          analysis, and power your recommendations.
        </span>
      </div>
    );
  }

  const isUntrusted = tier === 'untrusted';
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-sm',
        isUntrusted
          ? 'border-status-red-700/30 bg-status-red-50 text-status-red-700'
          : 'border-status-amber-700/30 bg-status-amber-50 text-status-amber-700',
        className,
      )}
      data-testid="dq-trust-banner-gated"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        <strong className="font-semibold">
          {isUntrusted ? 'Not yet reliable' : 'Estimated'} (grade {effectiveConfidence})
        </strong>{' '}
        {isUntrusted
          ? "— there isn't enough verified data to rely on these numbers yet."
          : '— treat these numbers as estimates, not verified totals.'}{' '}
        They won&apos;t count toward billing or your long-term marketing analysis, and
        higher-risk recommendations stay paused until your data quality improves.
      </span>
    </div>
  );
}
