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
import {
  Receipt,
  Lock,
  ShieldCheck,
  FileClock,
  AlertTriangle,
  FileText,
  FileCheck2,
  FileMinus,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  useBillingPeriods,
  useSealPeriod,
  useBill,
  useInvoice,
  useIssueInvoice,
  useIssueCreditNote,
} from '@/lib/hooks/use-billing';
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

/** Basis points → percent string (150 bps → '1.50%'). Integer math, no float drift on the bps. */
function ratePct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Human label for a ledger event_type (the composition line). */
function eventLabel(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The issued GST invoice for a period — issue button when not issued, else the immutable doc. */
function InvoiceSection({ period, currency }: { period: string; currency: string }) {
  const { data, isLoading, error, refetch } = useInvoice(period);
  const issue = useIssueInvoice();

  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (error) return <ErrorCard error={error} retry={() => void refetch()} />;
  if (!data) return null;

  if (data.state === 'not_issued') {
    return (
      <div className="rounded-lg border border-dashed p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            No invoice issued for {period} yet. Issuing assigns a gapless number and locks the
            figures (immutable).
          </div>
          <Button
            size="sm"
            disabled={issue.isPending}
            onClick={() => issue.mutate(period)}
          >
            <FileCheck2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {issue.isPending ? 'Issuing…' : 'Issue invoice'}
          </Button>
        </div>
        {issue.isError && (
          <div aria-live="polite" className="mt-2 text-sm text-destructive">
            Could not issue the invoice. The period must be sealed first.
          </div>
        )}
      </div>
    );
  }

  const intraState = data.regime === 'cgst_sgst';
  const hasCredits = data.credit_notes.length > 0;

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          <span className="font-medium">Invoice {data.invoice_number}</span>
          <span className="text-xs text-muted-foreground">
            issued {new Date(data.issued_at).toLocaleDateString()}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">GSTIN {data.seller_gstin}</span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase text-muted-foreground">Taxable (fee)</dt>
          <dd className="tabular-nums">{money(data.fee_minor, currency)}</dd>
        </div>
        {intraState ? (
          <>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">CGST ({ratePct(data.tax_rate_bps / 2)})</dt>
              <dd className="tabular-nums">{money(data.cgst_minor, currency)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">SGST ({ratePct(data.tax_rate_bps / 2)})</dt>
              <dd className="tabular-nums">{money(data.sgst_minor, currency)}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt className="text-xs uppercase text-muted-foreground">IGST ({ratePct(data.tax_rate_bps)})</dt>
            <dd className="tabular-nums">{money(data.igst_minor, currency)}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs uppercase text-muted-foreground">Total</dt>
          <dd className="font-semibold tabular-nums">{money(data.total_minor, currency)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">SAC / regime</dt>
          <dd>
            {data.sac_hsn_code} · {data.regime.toUpperCase().replace('_', '+')}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">Place of supply</dt>
          <dd>{data.place_of_supply}</dd>
        </div>
      </dl>

      {hasCredits && (
        <div className="mt-3 border-t pt-3">
          <div className="text-xs font-medium uppercase text-muted-foreground">Credit notes</div>
          <ul className="mt-1.5 space-y-1">
            {data.credit_notes.map((cn) => (
              <li key={cn.credit_note_id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <FileMinus className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                  <span className="font-medium">{cn.credit_note_number}</span>
                  <span className="text-muted-foreground">— {cn.reason}</span>
                </span>
                <span className="tabular-nums text-amber-700">−{money(cn.total_minor, currency)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-baseline justify-between border-t pt-2 text-sm">
            <span className="font-medium">Net payable</span>
            <span className="font-semibold tabular-nums">{money(data.net_total_minor, currency)}</span>
          </div>
        </div>
      )}

      <CreditNoteAction period={period} />
    </div>
  );
}

/** Issue an immutable credit note against the period's invoice — full reversal with a stated reason. */
function CreditNoteAction({ period }: { period: string }) {
  const credit = useIssueCreditNote();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');

  if (!open) {
    return (
      <div className="mt-3 border-t pt-3">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <FileMinus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Issue credit note
        </Button>
      </div>
    );
  }

  return (
    <form
      className="mt-3 space-y-2 border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason.trim()) return;
        credit.mutate(
          { period, reason: reason.trim() },
          { onSuccess: () => { setOpen(false); setReason(''); } },
        );
      }}
    >
      <label htmlFor="cn-reason" className="block text-xs font-medium uppercase text-muted-foreground">
        Reason for credit (full reversal)
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="cn-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. billing correction — duplicate charge"
          className="max-w-md"
        />
        <Button type="submit" size="sm" disabled={credit.isPending || !reason.trim()}>
          {credit.isPending ? 'Issuing…' : 'Confirm'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {credit.isError && (
        <p className="text-sm text-destructive" role="alert">
          Could not issue the credit note. It may exceed the invoice total.
        </p>
      )}
      {credit.data?.state === 'rejected' && (
        <p className="text-sm text-destructive" role="alert">
          Rejected: {credit.data.reason.replace(/_/g, ' ')}.
        </p>
      )}
    </form>
  );
}

/** The inspectable bill for one sealed period — basis → rate → fee, with composition + reconcile. */
function BillDetail({ period }: { period: string }) {
  const { data, isLoading, error, refetch } = useBill(period);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
      </div>
    );
  }
  if (error) return <ErrorCard error={error} retry={() => void refetch()} />;
  if (!data) return null;
  if (data.state === 'not_sealed') {
    return (
      <EmptyState
        icon={<FileClock className="h-6 w-6" aria-hidden="true" />}
        title={`${period} is not sealed yet`}
        description="Seal the period above to compute its bill."
      />
    );
  }

  const c = data.currency_code;
  const reconciled = data.reconciliation.reconciles;

  return (
    <div className="space-y-4">
      {/* Derivation: basis × rate → fee */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border p-3">
          <div className="text-xs uppercase text-muted-foreground">Realized GMV basis</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {money(data.basis.metered_gmv_minor, c)}
          </div>
          <div className="text-xs text-muted-foreground">as of {data.basis.as_of_date}</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-xs uppercase text-muted-foreground">Billing rate</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{ratePct(data.rate.rate_bps)}</div>
          <div className="text-xs text-muted-foreground">
            {data.rate.source === 'plan' ? 'from billing plan' : 'platform default'}
          </div>
        </div>
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div className="text-xs uppercase text-muted-foreground">Billable fee</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{money(data.fee_minor, c)}</div>
          <div className="text-xs text-muted-foreground">
            basis × rate{' '}
            {data.rounding_adjustment_minor !== '0' && (
              <>(rounding {money(data.rounding_adjustment_minor, c)})</>
            )}
          </div>
        </div>
      </div>

      {/* Composition — the realized rows that make up the basis */}
      <div>
        <div className="mb-1.5 text-sm font-medium">How the basis is composed</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Realized GMV composition by event type for {period}</caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">Recognition event</th>
                <th scope="col" className="py-2 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.event_type} className="border-b last:border-0">
                  <th scope="row" className="py-2 pr-4 font-normal">{eventLabel(l.event_type)}</th>
                  <td className="py-2 text-right tabular-nums">{money(l.amount_minor, c)}</td>
                </tr>
              ))}
              <tr className="border-t-2">
                <th scope="row" className="py-2 pr-4 font-semibold">
                  Composition total (live, as of {data.basis.as_of_date})
                </th>
                <td className="py-2 text-right font-semibold tabular-nums">
                  {money(data.reconciliation.live_composition_minor, c)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Reconciliation — does the live composition still equal the sealed basis? */}
      {reconciled ? (
        <div className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-sm text-emerald-700">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Reconciles — the live composition equals the sealed basis.
        </div>
      ) : (
        <div className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Backdated rows landed after sealing: the live composition is{' '}
            <strong>{money(data.reconciliation.drift_minor, c)}</strong> off the sealed basis. You
            are billed on the <strong>sealed</strong> figure ({money(data.basis.metered_gmv_minor, c)}) —
            the drift carries into a later period.
          </span>
        </div>
      )}

      {/* Issued invoice (slice 3) */}
      <InvoiceSection period={period} currency={c} />
    </div>
  );
}

export function BillingContent() {
  const [period, setPeriod] = React.useState(currentPeriod());
  const [selectedPeriod, setSelectedPeriod] = React.useState<string | null>(null);
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
                    <th scope="col" className="py-2 pr-4 font-medium">Sealed</th>
                    <th scope="col" className="py-2 font-medium sr-only">Bill</th>
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
                      <td className="py-2 pr-4 text-muted-foreground">
                        {new Date(p.sealed_at).toLocaleDateString()}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-pressed={selectedPeriod === p.billing_period}
                          onClick={() =>
                            setSelectedPeriod(
                              selectedPeriod === p.billing_period ? null : p.billing_period,
                            )
                          }
                        >
                          <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                          {selectedPeriod === p.billing_period ? 'Hide bill' : 'View bill'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Inspectable bill (slice 2) ───────────────────────────────────── */}
      {selectedPeriod && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Bill for {selectedPeriod}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BillDetail period={selectedPeriod} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
