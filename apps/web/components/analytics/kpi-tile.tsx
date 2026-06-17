'use client';

/**
 * KpiTile — single KPI display tile with label, big value, optional delta.
 *
 * A11y:
 *   - Status is text+icon, never color alone (accessibility skill §status-never-colour-only).
 *   - The tile has role="region" + aria-label carrying the full verdict.
 *   - Skeleton loading state has aria-busy.
 * Money: values passed as pre-formatted strings (minor units formatted at hook layer).
 * Empty: renders honest "No data" when value is null — never fabricates 0.
 */

import * as React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type DeltaDirection = 'up' | 'down' | 'flat';

export interface KpiTileProps {
  label: string;
  /** Pre-formatted value string — e.g. "₹25,43,258.75" or "3,892" or "4.2%" */
  value: string | null;
  /** Optional: pre-formatted delta string — e.g. "+12.3%" */
  delta?: string | null;
  deltaDirection?: DeltaDirection;
  /** If true, down is good (e.g. RTO Rate) */
  lowerIsBetter?: boolean;
  isLoading?: boolean;
  /** Supplemental context label */
  sublabel?: string;
  'data-testid'?: string;
  className?: string;
}

export function KpiTile({
  label,
  value,
  delta,
  deltaDirection,
  lowerIsBetter = false,
  isLoading = false,
  sublabel,
  'data-testid': testId,
  className,
}: KpiTileProps) {
  if (isLoading) {
    return (
      <Card
        className={cn('p-5', className)}
        aria-busy="true"
        aria-label={`${label} — loading`}
      >
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-3 w-16" />
        </div>
      </Card>
    );
  }

  const DeltaIcon =
    deltaDirection === 'up'
      ? TrendingUp
      : deltaDirection === 'down'
        ? TrendingDown
        : Minus;

  // A direction that is "good" vs "bad" — for color hinting (paired with icon+text)
  const deltaIsPositive =
    deltaDirection === 'up' ? !lowerIsBetter : deltaDirection === 'down' ? lowerIsBetter : null;

  const deltaColorClass =
    deltaIsPositive === true
      ? 'text-status-green-700'
      : deltaIsPositive === false
        ? 'text-status-red-700'
        : 'text-muted-foreground';

  const deltaLabel =
    deltaDirection === 'up'
      ? 'trending up'
      : deltaDirection === 'down'
        ? 'trending down'
        : 'no change';

  return (
    <Card
      className={cn('p-5', className)}
      data-testid={testId}
      role="region"
      aria-label={`${label}: ${value ?? 'no data'}`}
    >
      <CardContent className="p-0 space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </p>

        {value === null ? (
          <p className="text-sm text-muted-foreground italic" aria-live="polite">
            No data yet
          </p>
        ) : (
          <p
            className="text-2xl font-bold text-foreground tabular-nums leading-tight"
            aria-live="polite"
          >
            {value}
          </p>
        )}

        {sublabel && (
          <p className="text-xs text-muted-foreground">{sublabel}</p>
        )}

        {delta && deltaDirection && (
          <div
            className={cn('flex items-center gap-1 text-xs font-medium', deltaColorClass)}
            aria-label={`${delta} — ${deltaLabel}`}
          >
            <DeltaIcon className="h-3 w-3" aria-hidden="true" />
            <span>{delta}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
