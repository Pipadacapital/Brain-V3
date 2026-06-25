import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * StatusBadge — communicates live system/health/sync status with a coloured dot
 * + label. Status is NEVER colour-only (the text label carries the meaning), so
 * it stays accessible to colour-blind users and screen readers.
 *
 * Tones map to Brain's health semantics:
 *  - healthy / connected / verified  -> success
 *  - syncing / pending / estimated   -> info (animated dot)
 *  - degraded / stale / attention    -> warning
 *  - down / failed / error           -> destructive
 *  - idle / not connected / unknown  -> neutral
 */
export type StatusTone = 'success' | 'info' | 'warning' | 'destructive' | 'neutral';

const toneStyles: Record<StatusTone, { chip: string; dot: string }> = {
  success: { chip: 'bg-success-subtle text-success-subtle-foreground', dot: 'bg-success' },
  info: { chip: 'bg-info-subtle text-info-subtle-foreground', dot: 'bg-info' },
  warning: { chip: 'bg-warning-subtle text-warning-subtle-foreground', dot: 'bg-warning' },
  destructive: {
    chip: 'bg-destructive-subtle text-destructive-subtle-foreground',
    dot: 'bg-destructive',
  },
  neutral: { chip: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/60' },
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  /** Pulses the dot — use for in-progress states (syncing, processing). */
  pulse?: boolean;
  /** Hide the dot, label only. */
  hideDot?: boolean;
}

export const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ tone = 'neutral', pulse = false, hideDot = false, className, children, ...props }, ref) => {
    const styles = toneStyles[tone];
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
          styles.chip,
          className,
        )}
        {...props}
      >
        {!hideDot && (
          <span className="relative flex size-1.5" aria-hidden="true">
            {pulse && (
              <span
                className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', styles.dot)}
              />
            )}
            <span className={cn('relative inline-flex size-1.5 rounded-full', styles.dot)} />
          </span>
        )}
        {children}
      </span>
    );
  },
);
StatusBadge.displayName = 'StatusBadge';
