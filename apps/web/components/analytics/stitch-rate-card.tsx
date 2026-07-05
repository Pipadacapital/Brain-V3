'use client';

/**
 * StitchRateCard — the "Identified visitors" KPI (§14.1 plain-language rename of the
 * deterministic cart-stitch hit-rate; export name unchanged — the identity page consumes it).
 *
 * Identified visitors = distinct anonymous browsers deterministically linked to a known
 * customer (the identifier is read BACK from the order — NEVER inferred, D-5), out of all
 * distinct anonymous browsers. Computed in the metric-engine journey seam (I-ST01).
 * hit_pct is a 2dp string from the engine or null when the denominator is 0 — the card
 * then shows an honest "No visitors identified yet", never a fabricated 0%.
 *
 * A11y (accessibility skill §status-never-colour-only):
 *   - the linkage signal is a StatusPill (glyph shape differs per state, never colour alone).
 *   - the card is a labelled region carrying the full verdict for screen readers.
 *   - the "?" help tooltip comes from MetricTitle (hover + keyboard focus).
 * Counts: bigint strings (BigInt-parsed); rendered with toLocaleString — no float math.
 */

import { Card, CardContent } from '@/components/ui/card';
import { MetricTitle } from '@/components/ui/metric-title';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';

interface StitchRateCardProps {
  /** 2dp string from the engine (e.g. '37.50'), or null when total = 0 (honest). */
  hitPct: string | null;
  /** bigint string — distinct anonymous browsers linked to a known customer. */
  stitched: string;
  /** bigint string — all distinct anonymous browsers (the denominator). */
  total: string;
  className?: string;
  'data-testid'?: string;
}

const HELP =
  'We only link an anonymous visitor to a known customer when we see a definitive identifier (like an email used at checkout).';

const SUBTEXT =
  'This number grows as visitors log in or make a purchase. It reflects the fraction of anonymous browsers we can prove belong to a known customer — we never guess.';

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
  const noJourneys = hitPct === null; // denominator 0 — honest null state

  const valueLine = `${stitchedN.toLocaleString('en-IN')} identified visitor${
    stitchedN === 1 ? '' : 's'
  } (out of ${totalN.toLocaleString('en-IN')} total anonymous browser${totalN === 1 ? '' : 's'})`;

  return (
    <Card
      className={cn('p-5', className)}
      data-testid={testId}
      role="region"
      aria-label={
        noJourneys
          ? 'Identified visitors: no visitors identified yet.'
          : `Identified visitors: ${valueLine}.`
      }
    >
      <CardContent className="p-0 space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          <MetricTitle label="Identified visitors" help={HELP} />
        </p>

        {noJourneys ? (
          <p className="text-sm text-muted-foreground italic" aria-live="polite">
            No visitors identified yet
          </p>
        ) : (
          <>
            <p
              className="text-2xl font-bold text-foreground tabular-nums leading-tight"
              aria-live="polite"
            >
              {stitchedN.toLocaleString('en-IN')}
              <span className="ml-1.5 text-sm font-medium text-muted-foreground">
                identified visitor{stitchedN === 1 ? '' : 's'}
              </span>
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              out of {totalN.toLocaleString('en-IN')} total anonymous browser
              {totalN === 1 ? '' : 's'}
            </p>
          </>
        )}

        {/* Non-colour-only linkage signal: glyph shape differs per state. */}
        <StatusPill
          status={anyStitched ? 'healthy' : 'waiting'}
          label={anyStitched ? 'Linked to known customers' : 'No visitors identified yet'}
        />

        <p className="text-[11px] text-muted-foreground/80 pt-0.5">{SUBTEXT}</p>
      </CardContent>
    </Card>
  );
}
