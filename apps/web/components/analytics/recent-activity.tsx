'use client';

/**
 * RecentActivity — feed of latest ledger events.
 *
 * A11y:
 *   - List with role="list" + aria-label.
 *   - Each item has an aria-label carrying the full event context.
 *   - Event types distinguished by icon + text label, never color alone.
 *   - Focus visible on all interactive elements.
 * Money: formatMoneyDisplay (minor units → locale string). Never inline math.
 */

import * as React from 'react';
import { CheckCircle, Clock, AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { AnalyticsRecentActivityResponse } from '@/lib/api/types';
import { cn } from '@/lib/utils';

interface RecentActivityProps {
  data: AnalyticsRecentActivityResponse | undefined;
  isLoading: boolean;
  className?: string;
}

const EVENT_CONFIG = {
  provisional_recognition: {
    label: 'Provisional',
    icon: Clock,
    iconClass: 'text-status-amber-700',
    bgClass: 'bg-status-amber-50',
    abbr: 'P',
  },
  finalization: {
    label: 'Finalized',
    icon: CheckCircle,
    iconClass: 'text-status-green-700',
    bgClass: 'bg-status-green-50',
    abbr: 'F',
  },
  rto_reversal: {
    label: 'RTO',
    icon: AlertTriangle,
    iconClass: 'text-status-red-700',
    bgClass: 'bg-status-red-50',
    abbr: 'R',
  },
} as const;

function formatRelativeTime(isoStr: string): string {
  const d = new Date(isoStr);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

export function RecentActivity({ data, isLoading, className }: RecentActivityProps) {
  if (isLoading) {
    return (
      <div className={cn('space-y-2', className)} aria-busy="true" aria-label="Recent activity — loading">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const rows = data?.rows ?? [];

  if (rows.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No recent activity"
          description="Ledger events will appear here."
          icon={<Clock className="h-8 w-8" />}
        />
      </div>
    );
  }

  return (
    <ul
      className={cn('space-y-2', className)}
      role="list"
      aria-label="Recent ledger activity"
    >
      {rows.map((row, i) => {
        const cfg = EVENT_CONFIG[row.event_type];
        const Icon = cfg.icon;
        const formattedAmount = formatMoneyDisplay(row.amount_minor, row.currency_code as CurrencyCode);
        const relTime = formatRelativeTime(row.occurred_at);
        const shortOrder = row.order_id.slice(-8);

        return (
          <li
            key={`${row.order_id}-${row.event_type}-${i}`}
            className="flex items-start gap-3 py-1"
            aria-label={`${cfg.label}: ${formattedAmount} for order #${shortOrder} — ${relTime}`}
          >
            {/* Icon with non-color redundancy: icon shape + abbr text */}
            <span
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                cfg.bgClass,
                cfg.iconClass,
              )}
              aria-hidden="true"
              title={cfg.label}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>

            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-foreground truncate">
                  <span className="sr-only">{cfg.label}: </span>
                  <span aria-hidden="true" className="text-xs font-semibold mr-1">
                    {cfg.abbr}
                  </span>
                  Order #{shortOrder}
                </p>
                <span className="text-sm font-semibold tabular-nums text-foreground shrink-0">
                  {formattedAmount}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                <span aria-hidden="true">{cfg.label}</span>
                {' · '}
                <time dateTime={row.occurred_at}>{relTime}</time>
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
