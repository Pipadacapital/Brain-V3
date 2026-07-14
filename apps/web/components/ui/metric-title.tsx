'use client';

import * as React from 'react';
import { HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from './tooltip';

/**
 * MetricTitle — a metric label with a "?" help affordance (plain-language rule 2:
 * EVERY metric title carries a one-sentence explanation) and an optional
 * "Estimated" badge (rule 1: partial-data numbers are labelled, never faked).
 *
 * Inline-flex — drops into MetricCard's `label` and SectionCard's `title`
 * (both already accept ReactNode) without layout breakage.
 *
 * A11y: the "?" is a real <button> (focusable — tooltip shows on hover AND
 * keyboard focus via Radix) with an aria-label carrying the help sentence, so
 * screen readers get the explanation even without the tooltip.
 */
export interface MetricTitleProps {
  /** The metric's human name (e.g. "Revenue", "Repeat rate"). */
  label: React.ReactNode;
  /** ONE plain-language sentence explaining what this metric means. */
  help: string;
  /** Marks the number as calculated from partial data. */
  estimated?: boolean;
  className?: string;
}

const ESTIMATED_HELP =
  'This number is calculated from partial data and may change as more data arrives.';

export function MetricTitle({ label, help, estimated = false, className }: MetricTitleProps) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span className="truncate">{label}</span>

      {estimated && (
        <Tooltip content={ESTIMATED_HELP}>
          <span
            role="note"
            aria-label={`Estimated. ${ESTIMATED_HELP}`}
            className="inline-flex shrink-0 items-center rounded-full border border-transparent bg-info-subtle px-2 py-0.5 text-xs font-medium text-info-subtle-foreground"
          >
            Estimated
          </span>
        </Tooltip>
      )}

      <Tooltip content={help}>
        <button
          type="button"
          aria-label={`What is this? ${help}`}
          className="inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle className="size-3.5" aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  );
}
