import * as React from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from './card';
import { Skeleton } from './skeleton';

/**
 * MetricCard — a single headline KPI.
 *
 * Locale/currency-agnostic: callers pass an already-formatted `value` string
 * (formatted via the app's money/number formatter). This primitive never
 * formats numbers itself.
 *
 * Trust: `freshness` and `confidence` slots sit directly under the value so the
 * reader sees how fresh + how trustworthy a number is at the point of reading it.
 * While loading, render `loading` (a Skeleton) — never show 0 as if it were real.
 */
export interface MetricCardProps {
  label: React.ReactNode;
  /** Pre-formatted display value (e.g. "₹1,24,500", "3.2%", "1,204"). */
  value?: React.ReactNode;
  /** Small unit/context after the value (e.g. "orders", "/ 30d"). */
  unit?: React.ReactNode;
  /** Period-over-period delta. Direction sets colour + icon. */
  delta?: {
    value: React.ReactNode;
    direction?: 'up' | 'down' | 'neutral';
    /** When true, a "down" delta is good (e.g. churn, CAC). Flips colour only. */
    invert?: boolean;
  };
  /** FreshnessIndicator goes here. */
  freshness?: React.ReactNode;
  /** ConfidenceMeter / estimated badge goes here. */
  confidence?: React.ReactNode;
  icon?: React.ReactNode;
  loading?: boolean;
  className?: string;
}

export function MetricCard({
  label,
  value,
  unit,
  delta,
  freshness,
  confidence,
  icon,
  loading = false,
  className,
}: MetricCardProps) {
  const dir = delta?.direction ?? 'neutral';
  const positive = delta?.invert ? dir === 'down' : dir === 'up';
  const negative = delta?.invert ? dir === 'up' : dir === 'down';
  const DeltaIcon = dir === 'up' ? ArrowUpRight : dir === 'down' ? ArrowDownRight : Minus;

  return (
    <Card className={cn('p-5', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-muted-foreground">{label}</p>
        {icon && <span className="text-muted-foreground [&_svg]:size-4" aria-hidden="true">{icon}</span>}
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <span className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
              {value ?? '—'}
            </span>
            {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
          </>
        )}
      </div>

      {!loading && delta && (
        <div
          className={cn(
            'mt-1.5 inline-flex items-center gap-1 text-xs font-medium',
            positive && 'text-success-subtle-foreground',
            negative && 'text-destructive-subtle-foreground',
            !positive && !negative && 'text-muted-foreground',
          )}
        >
          <DeltaIcon className="size-3.5" aria-hidden="true" />
          <span className="tabular-nums">{delta.value}</span>
        </div>
      )}

      {(freshness || confidence) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          {freshness}
          {confidence}
        </div>
      )}
    </Card>
  );
}
