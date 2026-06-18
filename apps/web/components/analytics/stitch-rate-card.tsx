'use client';

/**
 * StitchRateCard — the deterministic cart-stitch HIT-RATE KPI (Silver-tier journey).
 *
 * Stitch-rate = distinct anon journeys deterministically linked to a known brain_id
 * (read BACK from the order's note_attributes — NEVER inferred, D-5) ÷ all distinct
 * anon journeys. Computed in the metric-engine journey seam (integer basis-point share,
 * I-ST01 — the UI never queries StarRocks). hit_pct is a 2dp string from the engine or
 * null when the denominator is 0 — never a fabricated 0%.
 *
 * A11y (accessibility skill §status-never-colour-only):
 *   - the coverage signal is an icon (Link2 / Unlink) + text label, never colour alone.
 *   - the card is a labelled region carrying the full verdict for screen readers.
 *   - a visually-hidden line states stitched / total so the ratio is auditable by SR.
 * Counts: bigint strings (BigInt-parsed); rendered with toLocaleString — no float math.
 */

import { Link2, Unlink, FlaskConical } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StitchRateCardProps {
  /** 2dp string from the engine (e.g. '37.50'), or null when total = 0 (honest). */
  hitPct: string | null;
  /** bigint string — distinct anon journeys stitched to a known brain_id. */
  stitched: string;
  /** bigint string — distinct anon journeys (the denominator). */
  total: string;
  className?: string;
  'data-testid'?: string;
}

export function StitchRateCard({
  hitPct,
  stitched,
  total,
  className,
  'data-testid': testId = 'journey-stitch-rate-card',
}: StitchRateCardProps) {
  const stitchedN = Number(BigInt(stitched));
  const totalN = Number(BigInt(total));
  const anyStitched = stitchedN > 0;

  const valueText = hitPct === null ? 'No journeys yet' : `${hitPct}%`;
  const StatusIcon = anyStitched ? Link2 : Unlink;
  const statusLabel = anyStitched ? 'Stitched to known orders' : 'No deterministic stitches yet';

  return (
    <Card
      className={cn('p-5', className)}
      data-testid={testId}
      role="region"
      aria-label={`Cart-stitch hit-rate: ${valueText}. ${stitchedN.toLocaleString(
        'en-IN',
      )} of ${totalN.toLocaleString('en-IN')} anonymous journeys deterministically linked to a known order. ${statusLabel}.`}
    >
      <CardContent className="p-0 space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Cart-stitch hit-rate
        </p>

        {hitPct === null ? (
          <p className="text-sm text-muted-foreground italic" aria-live="polite">
            No journeys yet
          </p>
        ) : (
          <p
            className="text-2xl font-bold text-foreground tabular-nums leading-tight"
            aria-live="polite"
          >
            {hitPct}%
          </p>
        )}

        <p className="text-xs text-muted-foreground tabular-nums">
          {stitchedN.toLocaleString('en-IN')} of {totalN.toLocaleString('en-IN')} anon journeys
        </p>

        {/* Non-colour-only status: icon + text label (never colour alone). */}
        <div
          className={cn(
            'flex items-center gap-1 text-xs font-medium',
            anyStitched ? 'text-status-green-700' : 'text-muted-foreground',
          )}
        >
          <StatusIcon className="h-3 w-3" aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>

        {/* Deterministic-provenance note: read BACK from the order, never inferred. */}
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground/80 pt-0.5">
          <FlaskConical className="h-2.5 w-2.5" aria-hidden="true" />
          Deterministic — brain_anon_id read back from the order (never inferred).
        </p>
      </CardContent>
    </Card>
  );
}
