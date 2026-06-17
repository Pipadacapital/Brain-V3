'use client';

import { useState } from 'react';
import { TrendingUp, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useRealizedRevenue } from '@/lib/hooks/use-dashboard';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

/**
 * Realized Revenue Card — §4 API contract, D-1..D-7, D-11, D-12.
 *
 * States:
 *   loading    → Skeleton (matches card layout)
 *   error      → ErrorCard (surfaces request_id for support — trace context)
 *   no_data    → EmptyState "No data yet" (D-2: NEVER a fake/0 number)
 *   has_data   → realized amounts per currency, labeled "Gross Revenue (ex-fees)" (D-11/MC-2)
 *               → provisional amounts alongside, labeled distinctly (D-4: NEVER blended)
 *
 * D-11 (ADR-BF-12): The realized figure is gross of Razorpay settlement fees until the
 *   Razorpay settlement slice ships. The card labels it "Gross Revenue (ex-fees)" with a
 *   tooltip "Settlement fees not yet applied." Showing a gross number as "Net Revenue"
 *   or without a gross-qualifier is an honesty violation — see CTO review MC-2.
 *
 * A11y:
 *   - Status is conveyed via text + icon, never colour alone.
 *   - Card has aria-label. Values have aria-labels with currency context.
 *   - Tooltip button has aria-label; tooltip content is visually hidden but screen-reader
 *     accessible via aria-describedby.
 *   - data-testids per D-12 + D-11: realized-revenue-card, realized-revenue-value,
 *     provisional-revenue-value, realized-revenue-no-data, realized-revenue-gross-label.
 *
 * Money: formatMoneyDisplay(minorString, currencyCode) — no parseFloat, no /100 (D-7).
 * Provisional: rendered in a sibling block with explicit "Provisional / Settling" label.
 *              If no provisional data, renders "No provisional data".
 *              NEVER summed with realized (D-4).
 */

/**
 * GrossRevenueTooltip — inline (i) tooltip disclosing that settlement fees are not yet applied.
 * D-11 / ADR-BF-12 requirement: "Settlement fees not yet applied" tooltip on the label.
 * A11y: keyboard focusable; tooltip text exposed via aria-describedby on the trigger.
 * Not colour-only: the Info icon is decorative; the visible text is the disclosure.
 */
function GrossRevenueTooltip() {
  const [open, setOpen] = useState(false);
  const tooltipId = 'gross-revenue-tooltip';

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="What does ex-fees mean?"
        aria-describedby={tooltipId}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 text-muted-foreground hover:text-foreground transition-colors"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          className="absolute left-5 top-0 z-50 w-52 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
          aria-live="polite"
        >
          Settlement fees not yet applied. This figure represents gross revenue from
          Shopify orders. Net revenue will be shown once the Razorpay settlement
          data is connected.
        </span>
      )}
    </span>
  );
}

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
      <Card data-testid="realized-revenue-card" aria-label="Gross Revenue (ex-fees) — no data yet">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" aria-hidden="true" />
            <span data-testid="realized-revenue-gross-label">Gross Revenue (ex-fees)</span>
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
    <Card data-testid="realized-revenue-card" aria-label="Gross Revenue (ex-fees)">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <TrendingUp className="h-4 w-4" aria-hidden="true" />
          {/* D-11 / ADR-BF-12: label as gross until Razorpay settlement slice ships */}
          <span data-testid="realized-revenue-gross-label">Gross Revenue (ex-fees)</span>
          {/* Tooltip: explains "Settlement fees not yet applied" (D-11 requirement) */}
          <GrossRevenueTooltip />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Realized block ────────────────────────────────────────────────── */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Gross Realized
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
