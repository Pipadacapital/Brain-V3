'use client';

import { TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useRealizedRevenue } from '@/lib/hooks/use-dashboard';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

/**
 * Realized Revenue Card — §4 API contract, D-1..D-7, D-12.
 *
 * States:
 *   loading    → Skeleton (matches card layout)
 *   error      → ErrorCard (surfaces request_id for support — trace context)
 *   no_data    → EmptyState "No data yet" (D-2: NEVER a fake/0 number)
 *   has_data   → realized amounts per currency (Realized Revenue)
 *               → provisional amounts alongside, labeled distinctly (D-4: NEVER blended)
 *
 * A11y:
 *   - Status is conveyed via text + icon, never colour alone.
 *   - Card has aria-label. Values have aria-labels with currency context.
 *   - data-testids per D-12: realized-revenue-card, realized-revenue-value,
 *     provisional-revenue-value, realized-revenue-no-data.
 *
 * Money: formatMoneyDisplay(minorString, currencyCode) — no parseFloat, no /100 (D-7).
 * Provisional: rendered in a sibling block with explicit "Provisional / Settling" label.
 *              If no provisional data, renders "No provisional data".
 *              NEVER summed with realized (D-4).
 */
export function RealizedRevenueCard() {
  const { data, isLoading, error, refetch } = useRealizedRevenue();

  if (isLoading) {
    return (
      <Card aria-label="Realized Revenue — loading">
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-32" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card aria-label="Realized Revenue — error">
        <CardContent className="pt-6">
          <ErrorCard error={error} retry={refetch} />
        </CardContent>
      </Card>
    );
  }

  // state === 'no_data' OR data is unexpectedly absent — render honest empty state (D-2).
  // NEVER render a 0 or fabricated number on no_data.
  if (!data || data.state === 'no_data') {
    return (
      <Card data-testid="realized-revenue-card" aria-label="Realized Revenue — no data yet">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" aria-hidden="true" />
            Realized Revenue
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            data-testid="realized-revenue-no-data"
            title="No data yet"
            description="Finalized orders will appear here once your first ledger entries are settled."
            icon={<TrendingUp className="h-8 w-8" />}
          />
          {/* Explicit testid on the inner element for Playwright (D-12) */}
          <span
            data-testid="realized-revenue-no-data"
            className="sr-only"
            aria-live="polite"
          >
            No realized revenue data yet
          </span>
        </CardContent>
      </Card>
    );
  }

  // state === 'has_data' — render real numbers only.
  const { realized, provisional, as_of } = data;

  // Per D-1: realized entries are per currency_code, values are minor-unit strings.
  const realizedEntries = realized ? Object.entries(realized) : [];
  const provisionalEntries = provisional ? Object.entries(provisional) : [];

  return (
    <Card data-testid="realized-revenue-card" aria-label="Realized Revenue">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <TrendingUp className="h-4 w-4" aria-hidden="true" />
          Realized Revenue
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Realized block ────────────────────────────────────────────────── */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Realized
          </p>
          {realizedEntries.length > 0 ? (
            <ul className="space-y-1" aria-label="Realized revenue amounts">
              {realizedEntries.map(([currency, minorStr]) => (
                <li key={currency}>
                  <span
                    data-testid="realized-revenue-value"
                    data-currency={currency}
                    className="text-2xl font-bold text-foreground tabular-nums"
                    aria-label={`Realized revenue: ${formatMoneyDisplay(minorStr, currency as CurrencyCode)} as of ${as_of}`}
                  >
                    {formatMoneyDisplay(minorStr, currency as CurrencyCode)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              No realized data
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            As of{' '}
            <time dateTime={as_of}>
              {new Date(as_of).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
            </time>
          </p>
        </div>

        {/* ── Provisional block — sibling, never blended with realized (D-4) ── */}
        <div
          className="rounded-md border border-border bg-muted/30 p-3"
          aria-label="Provisional revenue — not yet confirmed"
        >
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Provisional / Settling — not yet confirmed
          </p>
          {provisionalEntries.length > 0 ? (
            <ul className="space-y-1" aria-label="Provisional revenue amounts">
              {provisionalEntries.map(([currency, minorStr]) => (
                <li key={currency}>
                  <span
                    data-testid="provisional-revenue-value"
                    data-currency={currency}
                    className="text-lg font-semibold text-muted-foreground tabular-nums"
                    aria-label={`Provisional revenue: ${formatMoneyDisplay(minorStr, currency as CurrencyCode)} — not yet confirmed`}
                  >
                    {formatMoneyDisplay(minorStr, currency as CurrencyCode)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              No provisional data
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
