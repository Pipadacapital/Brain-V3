'use client';

/**
 * BillingContent — the realized-GMV billing meter surface (P1, slice 1).
 *
 * BFF-ONLY (I-ST01): reads GET /api/v1/billing/periods and POSTs /api/v1/billing/periods/seal.
 * It NEVER queries Postgres directly; brand scope is applied server-side from the session (RLS).
 *
 * What it shows: the brand's SEALED billing periods — the immutable basis Brain bills on
 * (%-of-realized-GMV). Each row is a period's metered realized GMV (minor-units string, never
 * float — I-S07), the as-of date, the # of ledger rows behind it (provenance), and when it was
 * sealed. Sealing a period is idempotent: a sealed period's figure can never silently change.
 *
 * Honest states: no_data → an explicit "not metered yet" empty state (not a misleading empty
 * table). A11y: the seal form has a labelled month input; the result region is aria-live.
 */

import * as React from 'react';
import { Receipt, Lock, ShieldCheck, FileClock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useBillingPeriods, useSealPeriod } from '@/lib/hooks/use-billing';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

/** Current month as 'YYYY-MM' (the natural default period to meter). */
function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function money(minor: string, currency: string): string {
  try {
    return formatMoneyDisplay(minor, currency as CurrencyCode);
  } catch {
    // Unknown currency — render the raw minor string rather than crash the table.
    return `${minor} ${currency}`;
  }
}

export function BillingContent() {
  const [period, setPeriod] = React.useState(currentPeriod());
  const { data, isLoading, error, refetch } = useBillingPeriods();
  const seal = useSealPeriod();

  function onSeal(e: React.FormEvent) {
    e.preventDefault();
    seal.mutate(period);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Brain bills on a share of <strong>realized GMV</strong>. Each billing period is sealed
          into an immutable snapshot — the figure you&apos;re billed on is reproducible from the
          ledger and can never silently change.
        </p>
      </div>

      {/* ── Meter a period ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Seal a billing period
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSeal} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <label htmlFor="billing-period" className="text-sm font-medium">
                Period (month)
              </label>
              <Input
                id="billing-period"
                type="month"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="w-48"
              />
            </div>
            <Button type="submit" disabled={seal.isPending || !/^\d{4}-\d{2}$/.test(period)}>
              {seal.isPending ? 'Sealing…' : 'Meter & seal'}
            </Button>
          </form>

          <div aria-live="polite" className="mt-3 text-sm">
            {seal.isError && (
              <span className="text-destructive">
                Could not seal that period. Please try again.
              </span>
            )}
            {seal.isSuccess && seal.data && (
              <span className="inline-flex items-center gap-1.5 text-emerald-600">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                {seal.data.sealed ? 'Sealed' : 'Already sealed'} {seal.data.billing_period}:{' '}
                <strong>{money(seal.data.metered_gmv_minor, seal.data.currency_code)}</strong>{' '}
                realized GMV (as of {seal.data.as_of_date}).
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Sealed periods ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Sealed periods
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : error ? (
            <ErrorCard error={error} retry={() => void refetch()} />
          ) : !data || data.state === 'no_data' ? (
            <EmptyState
              icon={<FileClock className="h-6 w-6" aria-hidden="true" />}
              title="No periods sealed yet"
              description="Seal a billing period above to meter this brand's realized GMV. Once a period is sealed its figure is immutable."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Sealed billing periods for the active brand</caption>
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="py-2 pr-4 font-medium">Period</th>
                    <th scope="col" className="py-2 pr-4 font-medium text-right">Realized GMV</th>
                    <th scope="col" className="py-2 pr-4 font-medium">As of</th>
                    <th scope="col" className="py-2 pr-4 font-medium text-right">Ledger rows</th>
                    <th scope="col" className="py-2 font-medium">Sealed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.periods.map((p) => (
                    <tr key={p.billing_period} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-4 font-medium">
                        <span className="inline-flex items-center gap-1.5">
                          <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                          {p.billing_period}
                        </span>
                      </th>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {money(p.metered_gmv_minor, p.currency_code)}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">{p.as_of_date}</td>
                      <td className="py-2 pr-4 text-right tabular-nums text-muted-foreground">
                        {p.ledger_row_count.toLocaleString()}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {new Date(p.sealed_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
