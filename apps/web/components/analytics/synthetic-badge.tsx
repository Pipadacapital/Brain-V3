'use client';

/**
 * SyntheticBadge — the honest "Synthetic (dev)" label (DEV-HONESTY, arch plan §4).
 *
 * Rendered on any CoD/RTO panel backed by synthetic-sourced data (GoKwik AWB lifecycle
 * + RTO-Predict are real-shape/synthetic-source in dev; settlement/fees + EMI/loyalty are
 * synthetic-only). NEVER presented as "live". A real partner sandbox is a stated platform
 * follow-up — when it lands, the BFF returns data_source='live' and this badge disappears
 * with no UI change.
 *
 * A11y (accessibility skill §status-never-colour-only):
 *   - icon (FlaskConical) + text label, never colour alone.
 *   - role="note" + aria-label carrying the full meaning for screen readers.
 *   - amber tokens: -700 text on -50 fill (4.5:1 contrast), never -500 on -50.
 */

import { FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SyntheticBadgeProps {
  /** Optional override of the explanatory aria-label / title. */
  reason?: string;
  className?: string;
  'data-testid'?: string;
}

const DEFAULT_REASON =
  'Synthetic development data — real shape, synthetic source. A real partner sandbox is a platform follow-up. This is never live data.';

export function SyntheticBadge({
  reason = DEFAULT_REASON,
  className,
  'data-testid': testId = 'synthetic-badge',
}: SyntheticBadgeProps) {
  return (
    <span
      role="note"
      aria-label={`Synthetic (dev). ${reason}`}
      title={reason}
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
        'bg-status-amber-50 text-status-amber-700 border-status-amber-200',
        className,
      )}
    >
      <FlaskConical className="h-3 w-3" aria-hidden="true" />
      Synthetic (dev)
    </span>
  );
}
