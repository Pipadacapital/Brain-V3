import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Skeleton — loading placeholder. Use to reserve layout while data loads.
 * Loading is a first-class state in Brain: never show an empty/zeroed chart
 * while data is in flight — show a Skeleton, then real data or an EmptyState.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted/70', className)}
      role="status"
      aria-busy="true"
      aria-live="polite"
      {...props}
    >
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** SkeletonText — n lines of skeleton at body height. */
function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)} role="status" aria-busy="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3.5 animate-pulse rounded bg-muted/70"
          style={{ width: i === lines - 1 ? '60%' : '100%' }}
        />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export { Skeleton, SkeletonText };
