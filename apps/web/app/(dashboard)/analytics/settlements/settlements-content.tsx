'use client';

/**
 * SettlementsContent — Razorpay net-of-fees settlement surface (Track C).
 *
 * Shows GROSS recognized revenue, the fee/tax/reserve/reversal deductions, and the
 * resulting NET settled amount, all computed by the metric engine (computeSettlementSummary)
 * from the realized_revenue_ledger settlement event_types.
 *
 * Money discipline (I-S07 / D-7): every amount is a bigint-serialized minor-unit string
 * rendered via formatMoneyDisplay(minorString, currency_code) — NO /100, NO parseFloat.
 * fees[].amount_minor is a POSITIVE magnitude; the UI renders each as a "− ₹X" deduction.
 *
 * Honest states: loading skeleton (aria-busy), ErrorCard with request_id on error, and
 * an honest "No settlement data yet" empty state (state==='no_data') that links to
 * /settings/connectors so the brand can connect Razorpay — never a fabricated zero.
 */

import Link from 'next/link';
import { Receipt, ArrowRight, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SettlementsWaterfall } from '@/components/analytics/settlements-waterfall';
import { useSettlements } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { AnalyticsSettlementsResponse, SettlementFeeType } from '@/lib/api/types';

type SettlementsHasData = Extract<AnalyticsSettlementsResponse, { state: 'has_data' }>;

const FEE_LABELS: Record<SettlementFeeType, string> = {
  payment_fee: 'Processing fee (MDR)',
  settlement_tax: 'GST on fee (18%)',
  rolling_reserve_deduction: 'Rolling reserve held',
  settlement_reversal: 'Refunds & chargebacks',
};

function SettlementsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading settlements…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function SettlementsContent() {
  const { data, isLoading, error, refetch } = useSettlements();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settlements"
        description="What Razorpay actually paid out to you — your revenue after processing fees, taxes, reserves, and reversals."
      />

      {isLoading && <SettlementsSkeleton />}

      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {/* Honest empty state — no settlement rows yet for this brand. */}
      {!isLoading && !error && data?.state === 'no_data' && (
        <Card data-testid="settlements-empty">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Receipt className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <div>
              <p className="font-medium text-foreground">No settlement data yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Connect Razorpay to see your net-of-fees settled revenue. Settlement
                data appears once Razorpay sends its first settlement.
              </p>
            </div>
            <Link href="/settings/connectors">
              <Button variant="outline" size="sm" data-testid="settlements-connect-cta">
                Connect Razorpay
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && data?.state === 'has_data' && (
        <SettlementsData data={data} />
      )}
    </div>
  );
}

function SettlementsData({ data }: { data: SettlementsHasData }) {
  const ccy = data.currency_code as CurrencyCode;
  const gross = formatMoneyDisplay(data.gross_minor, ccy);
  const net = formatMoneyDisplay(data.net_minor, ccy);

  // Total fees = gross − net (all in minor units; bigint subtraction, no float).
  const totalFeesMinor = BigInt(data.gross_minor) - BigInt(data.net_minor);
  const totalFees = formatMoneyDisplay(String(totalFeesMinor), ccy);

  return (
    <>
      <section aria-label="Settlement totals">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Gross Revenue"
            help="The full payment amount collected from customers, before any deductions."
            value={gross}
            sublabel="before fees"
            data-testid="settlement-kpi-gross"
          />
          <KpiTile
            label="Total Deductions"
            help="Everything taken out before payout — processing fees, tax on fees, money held in reserve, and refunds or chargebacks."
            value={`− ${totalFees}`}
            sublabel="fees, tax, reserve & reversals"
            data-testid="settlement-kpi-fees"
          />
          <KpiTile
            label="Net Settled"
            help="The amount actually paid into your account after all deductions."
            value={net}
            sublabel="after fees"
            data-testid="settlement-kpi-net"
          />
        </div>
      </section>

      {/* Gross → −fees → Net waterfall (the "show our work" surface). */}
      <section aria-label="Settlement waterfall">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Gross to Net
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SettlementsWaterfall
              grossMinor={data.gross_minor}
              netMinor={data.net_minor}
              fees={data.fees}
              currencyCode={data.currency_code}
            />
          </CardContent>
        </Card>
      </section>

      <section aria-label="Fee breakdown">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Minus className="h-4 w-4" aria-hidden="true" />
              Fee Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.fees.length === 0 ? (
              <p className="text-sm text-muted-foreground italic" role="status">
                No fees deducted in this period.
              </p>
            ) : (
              <table className="w-full text-sm" aria-label="Settlement fee breakdown">
                <thead>
                  <tr className="border-b">
                    <th scope="col" className="text-left font-medium text-muted-foreground pb-2">
                      Deduction
                    </th>
                    <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.fees.map((fee) => (
                    <tr key={fee.type} className="border-b last:border-0">
                      <td className="py-2">{FEE_LABELS[fee.type]}</td>
                      <td className="py-2 text-right tabular-nums font-medium text-destructive">
                        − {formatMoneyDisplay(fee.amount_minor, ccy)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2">
                    <td className="py-2 font-semibold">Net Settled</td>
                    <td className="py-2 text-right tabular-nums font-bold">{net}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </section>
    </>
  );
}
