import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * ConfidenceMeter — shows how trustworthy a number/decision is.
 *
 * Brain rule: confidence before decisions. Any computed/estimated/modelled value
 * shown to the user should carry a confidence signal. A three-segment bar +
 * label keeps it glanceable and is NOT colour-only (the level word carries it).
 *
 * `level` derives from `value` (0–1) if not given:
 *   >= 0.8 high · >= 0.5 medium · else low.
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

function levelFromValue(value: number): ConfidenceLevel {
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'medium';
  return 'low';
}

const levelMeta: Record<ConfidenceLevel, { label: string; fill: string; bars: number }> = {
  high: { label: 'High confidence', fill: 'bg-success', bars: 3 },
  medium: { label: 'Medium confidence', fill: 'bg-warning', bars: 2 },
  low: { label: 'Low confidence', fill: 'bg-destructive', bars: 1 },
};

export interface ConfidenceMeterProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 0–1 confidence score. Used for the aria value + to derive level if omitted. */
  value?: number;
  level?: ConfidenceLevel;
  /** Hide the text label, show bars only (keep an aria-label for a11y). */
  compact?: boolean;
  /** Override the displayed label text. */
  label?: string;
}

export const ConfidenceMeter = React.forwardRef<HTMLSpanElement, ConfidenceMeterProps>(
  ({ value, level, compact = false, label, className, ...props }, ref) => {
    const resolved = level ?? (value !== undefined ? levelFromValue(value) : 'low');
    const meta = levelMeta[resolved];
    const text = label ?? meta.label;
    return (
      <span
        ref={ref}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={value}
        aria-label={value !== undefined ? `${text} (${Math.round(value * 100)}%)` : text}
        className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}
        {...props}
      >
        <span className="flex items-end gap-0.5" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={cn(
                'w-1 rounded-sm',
                i === 0 ? 'h-2' : i === 1 ? 'h-2.5' : 'h-3',
                i < meta.bars ? meta.fill : 'bg-border',
              )}
            />
          ))}
        </span>
        {!compact && <span>{text}</span>}
      </span>
    );
  },
);
ConfidenceMeter.displayName = 'ConfidenceMeter';
