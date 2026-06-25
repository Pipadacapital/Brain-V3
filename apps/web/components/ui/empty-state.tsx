import * as React from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  /** Optional secondary line (e.g. a "what unlocks this" hint). */
  hint?: React.ReactNode;
  className?: string;
  /** Compact variant for inline/in-card empties. */
  compact?: boolean;
}

/**
 * EmptyState — the honest "no data yet" surface.
 *
 * Brain rule: NO empty charts as a success state, NO fabricated data. When a
 * panel has no real data, render this — explain WHY it's empty and HOW to get
 * data flowing (the `action`). An empty state should build trust, not look broken.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  hint,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-8' : 'py-14',
        className,
      )}
      data-testid="empty-state"
      role="status"
      aria-label={title}
    >
      {icon && (
        <div
          className="mb-4 flex size-11 items-center justify-center rounded-full border border-border bg-muted/60 text-muted-foreground [&_svg]:size-5"
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
      {hint && <p className="mt-3 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
