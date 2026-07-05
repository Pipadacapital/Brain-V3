import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * StatusPill — a three-state health chip: ● green (healthy) / ○ amber (waiting) /
 * ✕ red (error). Matches Badge/StatusBadge chip styling (rounded-full, subtle
 * semantic tokens).
 *
 * Status is NEVER colour-only (accessibility): the glyph SHAPE differs per state
 * (filled dot / hollow dot / cross) and the text label carries the meaning.
 */
export type StatusPillStatus = 'healthy' | 'waiting' | 'error';

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: StatusPillStatus;
  /** Human label carrying the meaning (e.g. "Receiving events", "Waiting for data"). */
  label: React.ReactNode;
}

const statusStyles: Record<StatusPillStatus, string> = {
  healthy: 'bg-success-subtle text-success-subtle-foreground',
  waiting: 'bg-warning-subtle text-warning-subtle-foreground',
  error: 'bg-destructive-subtle text-destructive-subtle-foreground',
};

function StatusGlyph({ status }: { status: StatusPillStatus }) {
  // Shape differs per state so the status reads without colour.
  if (status === 'healthy') {
    return <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />;
  }
  if (status === 'waiting') {
    return (
      <span
        className="size-1.5 shrink-0 rounded-full border border-warning bg-transparent"
        aria-hidden="true"
      />
    );
  }
  return <X className="size-3 shrink-0 text-destructive" aria-hidden="true" strokeWidth={3} />;
}

export const StatusPill = React.forwardRef<HTMLSpanElement, StatusPillProps>(
  ({ status, label, className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        statusStyles[status],
        className,
      )}
      {...props}
    >
      <StatusGlyph status={status} />
      {label}
    </span>
  ),
);
StatusPill.displayName = 'StatusPill';
