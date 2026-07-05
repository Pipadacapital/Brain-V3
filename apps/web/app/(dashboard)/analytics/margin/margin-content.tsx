'use client';

/**
 * MarginContent — Contribution Margin (CM1/CM2) + the cost-input form (feat-cm2-cost-inputs).
 *
 * Entering costs lifts cost_confidence off 'Insufficient' and makes CM2 trustworthy (it's what the
 * billing cap reads). DISCIPLINE: all money is bigint minor-unit strings → formatMoneyDisplay; never
 * /100. Honest loading/error/no_data; cost_confidence shown as an explicit badge.
 */
import { useState } from 'react';
import { Coins, TrendingUp, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { TableSearch, matchesQuery } from '@/components/ui/table-search';
import { useContributionMargin, useCostInputs, useUpsertCostInput } from '@/lib/hooks/use-analytics';
import { MetricTitle } from '@/components/ui/metric-title';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';

const COST_TYPES = [
  { value: 'cogs', label: 'COGS' },
  { value: 'shipping', label: 'Shipping' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'payment_fee', label: 'Payment fee' },
  { value: 'marketplace_fee', label: 'Marketplace fee' },
] as const;

function ConfidenceBadge({ c }: { c: 'Trusted' | 'Estimated' | 'Insufficient' }) {
  if (c === 'Trusted')
    return (
      <StatusBadge tone="success" hideDot>
        <ShieldCheck className="h-3 w-3" /> Trusted
      </StatusBadge>
    );
  if (c === 'Estimated')
    return (
      <StatusBadge tone="info" hideDot>
        <ShieldAlert className="h-3 w-3" /> Estimated
      </StatusBadge>
    );
  return (
    <StatusBadge tone="warning" hideDot>
      <ShieldAlert className="h-3 w-3" /> Insufficient
    </StatusBadge>
  );
}

export function MarginContent() {
  const margin = useContributionMargin();
  const costs = useCostInputs();
  const upsert = useUpsertCostInput();

  const [costType, setCostType] = useState<(typeof COST_TYPES)[number]['value']>('cogs');
  const [pct, setPct] = useState('');
  const [costQ, setCostQ] = useState('');

  const m = margin.data?.state === 'has_data' ? margin.data.margin : null;
  const ccy = (m?.currency_code ?? 'INR') as CurrencyCode;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Margin & Costs"
        description="How much profit is left after costs (contribution margin). Enter your cost rates below to make the numbers trustworthy."
      />

      {margin.error && <ErrorCard error={margin.error} />}

      {margin.isLoading && <Skeleton className="h-40 w-full" />}

      {!margin.isLoading && margin.data?.state === 'no_data' && (
        <EmptyState icon={<TrendingUp className="h-6 w-6" />} title="No revenue yet" description="Contribution margin appears once orders flow through and you enter your costs." />
      )}

      {m && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2"><TrendingUp className="h-4 w-4" /> Contribution margin</CardTitle>
            <ConfidenceBadge c={m.cost_confidence} />
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:max-w-md">
              <dt className="text-muted-foreground">
                <MetricTitle label="Net revenue" help="Money from confirmed orders after refunds and cancellations." />
              </dt>
              <dd className="text-right">{formatMoneyDisplay(m.net_revenue_minor, ccy)}</dd>
              <dt className="text-muted-foreground">
                <MetricTitle label="− COGS" help="Cost of goods sold — what the products themselves cost you." />
              </dt>
              <dd className="text-right text-warning">{formatMoneyDisplay(m.cogs_minor, ccy)}</dd>
              <dt className="text-muted-foreground">
                <MetricTitle label="− Variable costs" help="Per-order costs like shipping, packaging, and payment fees." />
              </dt>
              <dd className="text-right text-warning">{formatMoneyDisplay(m.variable_cost_minor, ccy)}</dd>
              <dt className="border-t pt-2 font-medium">
                <MetricTitle label="CM1" help="Profit after product and per-order costs, before marketing." />
              </dt>
              <dd className="border-t pt-2 text-right font-semibold">{formatMoneyDisplay(m.cm1_minor, ccy)}</dd>
              <dt className="text-muted-foreground">
                <MetricTitle label="− Marketing" help="What you spent on ads and marketing in the same period." />
              </dt>
              <dd className="text-right text-warning">{formatMoneyDisplay(m.marketing_minor, ccy)}</dd>
              <dt className="border-t pt-2 font-medium">
                <MetricTitle label="CM2" help="Profit left after product, per-order, and marketing costs." />
              </dt>
              <dd className="border-t pt-2 text-right text-lg font-bold text-success">{formatMoneyDisplay(m.cm2_minor, ccy)}</dd>
            </dl>
            {m.cost_confidence === 'Insufficient' && (
              <p className="mt-3 text-xs text-warning">Enter at least a COGS rate (what your products cost you, as a % of revenue) below to make CM2 trustworthy — it also caps your bill.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Cost inputs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Coins className="h-4 w-4" /> Cost structure</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const bps = Math.round(parseFloat(pct) * 100); // percent → basis points
              if (!Number.isFinite(bps) || bps < 0) return;
              upsert.mutate(
                { scope: 'global', cost_type: costType, pct_bps: bps, currency_code: ccy, cost_confidence: 'Trusted' },
                { onSuccess: () => setPct('') },
              );
            }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Cost</span>
              <select value={costType} onChange={(e) => setCostType(e.target.value as typeof costType)} className="h-9 rounded-md border bg-card px-2 text-sm">
                {COST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">% of revenue</span>
              <input type="number" step="0.1" min="0" max="100" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="e.g. 40" className="h-9 w-28 rounded-md border bg-card px-2 text-sm" />
            </label>
            <button type="submit" disabled={!pct || upsert.isPending} className="h-9 rounded-md border bg-secondary px-3 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50">
              {upsert.isPending ? 'Saving…' : 'Save'}
            </button>
          </form>

          {costs.isLoading && <Skeleton className="h-16 w-full" />}
          {costs.data && costs.data.cost_inputs.length > 0 && (() => {
            const allInputs = costs.data.cost_inputs;
            const labelFor = (ct: string) => COST_TYPES.find((t) => t.value === ct)?.label ?? ct;
            const visible = allInputs.filter((c) =>
              matchesQuery(costQ, labelFor(c.cost_type), c.scope, c.scope_ref ?? null),
            );
            return (
              <div className="space-y-2">
                <div className="flex justify-end">
                  <TableSearch
                    value={costQ}
                    onChange={setCostQ}
                    placeholder="Search costs…"
                    aria-label="Search cost inputs"
                  />
                </div>
                <table className="w-full text-sm">
                  <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                    <tr><th className="py-2 font-medium">Cost</th><th className="py-2 font-medium">Scope</th><th className="py-2 text-right font-medium">Rate</th><th className="py-2 text-right font-medium">Confidence</th></tr>
                  </thead>
                  <tbody>
                    {visible.map((c) => (
                      <tr key={`${c.cost_type}-${c.scope}-${c.scope_ref}`} className="border-b last:border-0">
                        <td className="py-2">{labelFor(c.cost_type)}</td>
                        <td className="py-2 text-muted-foreground">{c.scope}{c.scope_ref ? `:${c.scope_ref}` : ''}</td>
                        <td className="py-2 text-right">{c.pct_bps !== null ? `${(c.pct_bps / 100).toFixed(2)}%` : formatMoneyDisplay(c.amount_minor ?? '0', c.currency_code as CurrencyCode)}</td>
                        <td className="py-2 text-right"><ConfidenceBadge c={c.cost_confidence} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {costQ && visible.length === 0 && (
                  <p className="py-2 text-center text-sm text-muted-foreground" role="status">
                    No matches for &ldquo;{costQ}&rdquo;
                  </p>
                )}
              </div>
            );
          })()}
          {costs.data && costs.data.cost_inputs.length === 0 && (
            <p className="text-sm text-muted-foreground">No costs entered yet. Add your COGS % above to compute true margin.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
