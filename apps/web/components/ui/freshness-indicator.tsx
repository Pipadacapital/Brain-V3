import * as React from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * FreshnessIndicator — states how recently the underlying data was updated.
 *
 * Brain rule: freshness must be visible. Surface this on every data panel near
 * the value it describes. The caller passes an already-formatted relative label
 * (e.g. "2 min ago", "synced 1h ago") — this primitive does NOT format time, so
 * it stays locale-agnostic.
 *
 * Tone signals staleness:
 *  - 'fresh'  : within SLA (muted, quiet — the calm default)
 *  - 'stale'  : past the freshness SLA (warning)
 *  - 'unknown': no timestamp available
 */
export type FreshnessTone = 'fresh' | 'stale' | 'unknown';

const toneClass: Record<FreshnessTone, string> = {
  fresh: 'text-muted-foreground',
  stale: 'text-warning-subtle-foreground',
  unknown: 'text-muted-foreground/70',
};

export interface FreshnessIndicatorProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Pre-formatted relative label, e.g. "2 min ago". */
  label: React.ReactNode;
  tone?: FreshnessTone;
  /** Override the prefix word. Default "Updated". */
  prefix?: string;
}

export const FreshnessIndicator = React.forwardRef<HTMLSpanElement, FreshnessIndicatorProps>(
  ({ label, tone = 'fresh', prefix = 'Updated', className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn('inline-flex items-center gap-1 text-xs', toneClass[tone], className)}
      title={tone === 'stale' ? 'This data is past its freshness window.' : undefined}
      {...props}
    >
      <Clock className="size-3" aria-hidden="true" />
      <span>
        {prefix} {label}
      </span>
    </span>
  ),
);
FreshnessIndicator.displayName = 'FreshnessIndicator';
