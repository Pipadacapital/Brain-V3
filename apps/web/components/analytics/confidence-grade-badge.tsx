'use client';

/**
 * ConfidenceGradeBadge — the deterministic attribution_confidence grade
 * (strong / partial / weak) as an icon + text badge.
 *
 * The grade is a DETERMINISTIC FLOOR over a journey's touch-resolution quality
 * (stitched + deterministic channels → strong/1.000; stitched + a cookieless/direct
 * residual → partial/0.700; unstitched/synthetic → weak/0.400). It is NOT a model
 * number — it is stamped at credit time in the engine and carried verbatim to clawback.
 *
 * A11y (accessibility skill §status-never-colour-only):
 *   - icon (ShieldCheck / Shield / ShieldAlert) + text label, NEVER colour alone.
 *   - role="status" + aria-label carrying the full verdict for screen readers.
 *   - status tokens: -700 text on -50 fill (4.5:1 contrast), never -500 on -50.
 *   - greyscale-safe: the three grades are distinguishable by glyph + label after the
 *     colour is removed.
 */

import { ShieldCheck, Shield, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AttributionConfidenceGrade } from '@/lib/api/types';

const GRADE_META: Record<
  AttributionConfidenceGrade,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    cls: string;
    explain: string;
  }
> = {
  strong: {
    label: 'Strong',
    icon: ShieldCheck,
    cls: 'bg-status-green-50 text-status-green-700 border-status-green-200',
    explain:
      'Deterministically stitched journey, every credited touch on a deterministic channel (click-id or UTM medium). Confidence 1.000.',
  },
  partial: {
    label: 'Partial',
    icon: Shield,
    cls: 'bg-status-amber-50 text-status-amber-700 border-status-amber-200',
    explain:
      'Stitched journey, but at least one credited touch is the cookieless / direct residual. Confidence 0.700 — rendered as estimated.',
  },
  weak: {
    label: 'Weak',
    icon: ShieldAlert,
    cls: 'bg-status-red-50 text-status-red-700 border-status-red-200',
    explain:
      'Unstitched or synthetic-enriched coverage (the dev-thin path). Confidence 0.400 — treat as estimated.',
  },
};

interface ConfidenceGradeBadgeProps {
  grade: AttributionConfidenceGrade;
  className?: string;
  'data-testid'?: string;
}

export function ConfidenceGradeBadge({
  grade,
  className,
  'data-testid': testId = 'confidence-grade-badge',
}: ConfidenceGradeBadgeProps) {
  const meta = GRADE_META[grade] ?? GRADE_META.weak;
  const Icon = meta.icon;
  return (
    <span
      role="status"
      aria-label={`Attribution confidence: ${meta.label}. ${meta.explain}`}
      title={meta.explain}
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium',
        meta.cls,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {meta.label}
    </span>
  );
}
