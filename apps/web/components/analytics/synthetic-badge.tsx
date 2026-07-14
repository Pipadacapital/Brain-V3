'use client';

/**
 * SyntheticBadge — the honest "Estimated" label (DEV-HONESTY, arch plan §4; plain-language rule 1).
 *
 * Rendered on any panel whose numbers are calculated from partial/synthetic-sourced data
 * (GoKwik AWB lifecycle + RTO-Predict are real-shape/synthetic-source in dev; settlement/fees
 * + EMI/loyalty are synthetic-only). NEVER presented as final/live. When the BFF returns
 * data_source='live' this badge disappears with no UI change.
 *
 * Component name/exports/props unchanged (no API break) — only the visible copy changed
 * from "Synthetic (dev)" to the merchant-facing "Estimated".
 *
 * A11y (accessibility skill §status-never-colour-only):
 *   - icon (FlaskConical) + text label, never colour alone.
 *   - role="note" + aria-label carrying the full meaning for screen readers.
 *   - amber tokens: -700 text on -50 fill (4.5:1 contrast), never -500 on -50.
 *   - tooltip (Radix) shows on hover AND keyboard focus; the badge is focusable.
 */

import { FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

interface SyntheticBadgeProps {
  /** Optional override of the explanatory tooltip / aria-label. */
  reason?: string;
  className?: string;
  'data-testid'?: string;
}

const DEFAULT_REASON =
  'This number is calculated from partial data and may change as more data arrives.';

export function SyntheticBadge({
  reason = DEFAULT_REASON,
  className,
  'data-testid': testId = 'synthetic-badge',
}: SyntheticBadgeProps) {
  return (
    <Tooltip content={reason}>
      <span
        role="note"
        aria-label={`Estimated. ${reason}`}
        tabIndex={0}
        data-testid={testId}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
          'bg-status-amber-50 text-status-amber-700 border-status-amber-200',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        <FlaskConical className="h-3 w-3" aria-hidden="true" />
        Estimated
      </span>
    </Tooltip>
  );
}
