'use client';

/**
 * CodRtoContent — the CoD / RTO analytics surface (GoKwik + Shopflo Track C).
 *
 * Three views, each via the BFF sole-read-path (metric-engine, ADR-002 — NO ad-hoc
 * SUM/COUNT in the client or routes):
 *   1. RTO% by pincode cohort   — /api/v1/analytics/cod-rto-rates (GoKwik AWB, SYNTHETIC dev)
 *   2. CoD outcome funnel        — /api/v1/analytics/cod-rto       (gold_cod_rto mart, DR-006)
 *   3. CoD-vs-prepaid + CoD CM2  — /api/v1/analytics/cod-mix       (ledger cod_*, SYNTHETIC dev)
 *   4. Checkout-conversion funnel— /api/v1/analytics/checkout-funnel (Shopflo, REAL)
 *
 * Money discipline (I-S07 / D-7): every amount is a bigint-serialized minor-unit string
 * rendered via formatMoneyDisplay(minorString, currency_code) — NO /100, NO parseFloat.
 *
 * DEV-HONESTY (arch plan §4): any panel sourced from synthetic data carries the
 * <SyntheticBadge/> ("Synthetic (dev)"). GoKwik AWB/RTO + CoD ledger are synthetic in dev
 * (real shape, synthetic source — partner sandbox is a platform follow-up). Shopflo
 * checkout_abandoned is REAL → no badge. data_source comes from the BFF, never hardcoded.
 *
 * Honest states: skeletons (aria-busy), ErrorCard with request_id on error, and honest
 * empty states that link to /settings/connectors — never a fabricated zero.
 *
 * A11y: every section is a labelled region; charts carry SR-table fallbacks + role=img;
 * status/synthetic indicators are icon+label (never colour-only); RTO RAG is paired with
 * a verdict label + icon.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Truck, ArrowRight, ShoppingBag, Wallet, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { DataWindowBadge } from '@/components/ui/data-window-badge';
import { TableSearch, filterRows } from '@/components/ui/table-search';
import { VerifyLink } from '@/components/ui/verify-link';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { RtoPincodeChart } from '@/components/analytics/rto-pincode-chart';
import { CodMixChart } from '@/components/analytics/cod-mix-chart';
import { CheckoutFunnelChart } from '@/components/analytics/checkout-funnel-chart';
import { RtoRiskChart } from '@/components/analytics/rto-risk-chart';
import { useCodRtoRates, useCodRto, useCodMix, useCheckoutFunnel, useRtoRiskDistribution } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type {
  AnalyticsCodMixResponse,
  AnalyticsCheckoutFunnelResponse,
  AnalyticsRtoRiskResponse,
  CodRtoCurrencyRow,
} from '@/lib/api/types';

type CodMixHasData = Extract<AnalyticsCodMixResponse, { state: 'has_data' }>;
type CheckoutFunnelHasData = Extract<AnalyticsCheckoutFunnelResponse, { state: 'has_data' }>;
type RtoRiskHasData = Extract<AnalyticsRtoRiskResponse, { state: 'has_data' }>;

/**
 * The checkout-funnel and RTO-risk endpoints aggregate the trailing 30 days (no from/to
 * param — so a DateRangeFilter would be non-functional and dishonest here). We surface the
 * true window via a DataWindowBadge instead; the CoD-mix and RTO-by-pincode reads are
 * brand-wide all-time aggregates, shown honestly as "all time".
 */
const LAST_30D = (() => {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
})();

/** Small helper: safely turn a bigint string into a display number for a badge count. */
function toCount(bigintStr: string): number {
  try {
    return Number(BigInt(bigintStr));
  } catch {
    return 0;
  }
}

function SectionSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label={`Loading ${label}…`}>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

/** Honest empty card with a connect CTA (never a fabricated zero). */
function EmptyConnectCard({
  testId,
  icon,
  title,
  description,
  cta,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  cta: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          {icon}
        </div>
        <div>
          <p className="font-medium text-foreground">{title}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">{description}</p>
        </div>
        <Link href="/settings/connectors">
          <Button variant="outline" size="sm">
            {cta}
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

export function CodRtoContent() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="CoD / RTO"
        description="Cash-on-delivery economics and return-to-origin (RTO) — the India-D2C signal from GoKwik shipments and Shopflo checkout."
      />

      <RtoSection />
      <RtoRiskSection />
      <CodOutcomesSection />
      <CodMixSection />
      <CheckoutFunnelSection />
    </div>
  );
}

// ── 1. RTO% by pincode cohort (GoKwik AWB — synthetic in dev) ──────────────────

function RtoSection() {
  const { data, isLoading, error, refetch } = useCodRtoRates();
  const [pincodeQuery, setPincodeQuery] = useState('');

  const hasData = data && data.state === 'has_data' ? data : null;
  // RTO-by-pincode is a brand-wide all-time aggregate (no date window on the endpoint).
  const cohorts = hasData?.cohorts ?? [];
  const filteredCohorts = filterRows(cohorts, pincodeQuery, ['pincode']);
  // Search only helps when there is a real pincode split to filter (not the single
  // "unknown" cohort shown while partner pincodes are still pending).
  const showSearch = !!hasData && !hasData.pincode_pending && cohorts.length > 1;

  return (
    <section aria-label="Returned-to-origin rate by pincode" data-testid="cod-rto-section">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          Returned-to-origin (RTO) rate by pincode
        </h2>
        {/* Badge shown whenever the data is synthetic-sourced (GoKwik dev). */}
        {hasData && hasData.data_source === 'synthetic' && (
          <SyntheticBadge
            data-testid="cod-rto-synthetic-badge"
            reason="These shipment outcomes come from sample data used during setup — they are replaced once live GoKwik tracking connects."
          />
        )}
        {hasData && (
          <div className="ml-auto flex items-center gap-3">
            <DataWindowBadge
              from={null}
              to={null}
              count={toCount(hasData.total_terminal)}
              label="completed shipments"
              data-testid="cod-rto-window-badge"
            />
            <VerifyLink href="/analytics/logistics" label="See shipments" />
          </div>
        )}
      </div>

      {isLoading && <SectionSkeleton label="RTO by pincode" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {!isLoading && !error && data?.state === 'no_data' && (
        <EmptyConnectCard
          testId="cod-rto-empty"
          icon={<Truck className="h-8 w-8" />}
          title="No RTO data yet"
          description="Connect GoKwik to track return-to-origin by pincode. RTO rate appears once shipments finish their journey (delivered or returned)."
          cta="Connect GoKwik"
        />
      )}

      {!isLoading && !error && data?.state === 'has_data' && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile
              label="Overall RTO Rate"
              help="Of shipments that finished their journey, the share that came back undelivered — lower is better."
              value={data.overall_rto_rate_pct === null ? null : `${data.overall_rto_rate_pct}%`}
              sublabel="returned ÷ completed shipments"
              lowerIsBetter
              data-testid="cod-rto-kpi-overall"
            />
            <KpiTile
              label="RTO Shipments"
              help="Shipments that could not be delivered and came back to you."
              value={Number(BigInt(data.total_rto)).toLocaleString('en-IN')}
              sublabel="returned to origin"
              data-testid="cod-rto-kpi-rto-count"
            />
            <KpiTile
              label="Completed Shipments"
              help="Shipments whose journey has finished — either delivered or returned."
              value={Number(BigInt(data.total_terminal)).toLocaleString('en-IN')}
              sublabel="delivered or returned"
              data-testid="cod-rto-kpi-terminal-count"
            />
          </div>
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  RTO rate by destination pincode
                </CardTitle>
                {showSearch && (
                  <TableSearch
                    value={pincodeQuery}
                    onChange={setPincodeQuery}
                    placeholder="Search pincode…"
                    aria-label="Search pincode cohorts"
                  />
                )}
              </div>
            </CardHeader>
            <CardContent>
              <RtoPincodeChart cohorts={filteredCohorts} pincodePending={data.pincode_pending} />
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}

// ── 2b. COD outcomes & prediction accuracy (gold_cod_rto — DR-006) ─────────────

/** Integer basis points → 2dp percent string for display (bps ≤ 10000; NOT money math). */
function bpsToPct(bps: number): string {
  return (bps / 100).toFixed(2);
}

function CodOutcomesSection() {
  const { data, isLoading, error, refetch } = useCodRto();

  const hasData = data && data.state === 'has_data' ? data : null;
  const totalCodOrders = hasData
    ? hasData.by_currency.reduce((acc, c) => acc + toCount(c.cod_orders), 0)
    : 0;

  return (
    <section aria-label="Cash-on-delivery outcomes and prediction accuracy" data-testid="cod-outcomes-section">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          CoD outcomes &amp; prediction accuracy
        </h2>
        {hasData && (
          <div className="ml-auto flex items-center gap-3">
            {/* Brand-wide all-time mart aggregate — no date window on this endpoint. */}
            <DataWindowBadge
              from={null}
              to={null}
              count={totalCodOrders}
              label="CoD orders"
              data-testid="cod-outcomes-window-badge"
            />
            <VerifyLink href="/analytics/orders" label="See orders" />
          </div>
        )}
      </div>

      {isLoading && <SectionSkeleton label="CoD outcomes" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {!isLoading && !error && data?.state === 'no_data' && (
        <EmptyConnectCard
          testId="cod-outcomes-empty"
          icon={<Wallet className="h-8 w-8" />}
          title="No CoD outcome data yet"
          description="Connect GoKwik so Brain can reconcile your cash-on-delivery orders against their delivery outcomes — then RTO rate and prediction accuracy appear here."
          cta="Connect GoKwik"
        />
      )}

      {!isLoading && !error && data?.state === 'has_data' && (
        <div className="space-y-3">
          {data.by_currency.map((row) => (
            <CodOutcomesCurrency key={row.currency_code} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function CodOutcomesCurrency({ row }: { row: CodRtoCurrencyRow }) {
  const ccy = row.currency_code as CurrencyCode;
  const delivered = toCount(row.actual_delivered);
  const rto = toCount(row.actual_rto);
  const resolved = toCount(row.resolved);
  const evaluated = toCount(row.prediction_evaluated);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid={`cod-outcomes-${row.currency_code}`}>
      <KpiTile
        label="CoD Orders"
        help="Cash-on-delivery orders Brain has reconciled against their shipment outcomes."
        value={toCount(row.cod_orders).toLocaleString('en-IN')}
        sublabel="reconciled orders"
        data-testid="cod-outcomes-kpi-orders"
      />
      <KpiTile
        label="CoD Value"
        help="The cash at risk on these cash-on-delivery orders — collected only if delivered."
        value={formatMoneyDisplay(row.cod_amount_minor, ccy)}
        sublabel="at-risk CoD cash"
        data-testid="cod-outcomes-kpi-value"
      />
      <KpiTile
        label="RTO Rate"
        help="Of CoD orders whose journey has finished, the share that came back undelivered — lower is better."
        value={row.rto_rate_bps === null ? null : `${bpsToPct(row.rto_rate_bps)}%`}
        sublabel={resolved > 0 ? 'of resolved CoD orders' : 'no resolved shipments yet'}
        lowerIsBetter
        data-testid="cod-outcomes-kpi-rto-rate"
      />
      <KpiTile
        label="Delivered vs RTO"
        help="How the resolved CoD orders ended — delivered to the customer, or returned to you."
        value={
          resolved > 0
            ? `${delivered.toLocaleString('en-IN')} / ${rto.toLocaleString('en-IN')}`
            : null
        }
        sublabel={resolved > 0 ? 'delivered / returned' : 'no resolved shipments yet'}
        data-testid="cod-outcomes-kpi-split"
      />
      <KpiTile
        label="Prediction Accuracy"
        help="How often the checkout RTO-risk prediction matched what actually happened to the shipment."
        value={
          evaluated > 0 && row.prediction_accuracy_bps !== null
            ? `${bpsToPct(row.prediction_accuracy_bps)}%`
            : null
        }
        sublabel={
          evaluated > 0
            ? `${evaluated.toLocaleString('en-IN')} predictions evaluated`
            : 'no evaluated predictions yet'
        }
        data-testid="cod-outcomes-kpi-accuracy"
      />
    </div>
  );
}

// ── 2. CoD-vs-prepaid mix + CoD CM2 (ledger cod_* — synthetic in dev) ──────────

function CodMixSection() {
  const { data, isLoading, error, refetch } = useCodMix();

  return (
    <section aria-label="What cash-on-delivery really earns" data-testid="cod-mix-section">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">What cash-on-delivery really earns</h2>
        {/* CoD ledger is fed by the synthetic GoKwik AWB consumer in dev. */}
        <SyntheticBadge
          data-testid="cod-mix-synthetic-badge"
          reason="These cash-on-delivery figures come from sample data used during setup — they are replaced once live GoKwik data connects."
        />
        {data?.state === 'has_data' && (
          <div className="ml-auto flex items-center gap-3">
            {/* Brand-wide all-time ledger aggregate — no date window on this endpoint. */}
            <DataWindowBadge from={null} to={null} data-testid="cod-mix-window-badge" />
            <VerifyLink href="/analytics/orders" label="See orders" />
          </div>
        )}
      </div>

      {isLoading && <SectionSkeleton label="CoD mix" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {!isLoading && !error && data?.state === 'no_data' && (
        <EmptyConnectCard
          testId="cod-mix-empty"
          icon={<Wallet className="h-8 w-8" />}
          title="No CoD data yet"
          description="Connect GoKwik to see your cash-on-delivery vs prepaid mix, and what CoD really earns after undelivered orders are taken back out."
          cta="Connect GoKwik"
        />
      )}

      {!isLoading && !error && data?.state === 'has_data' && (
        <CodMixData data={data} />
      )}
    </section>
  );
}

function CodMixData({ data }: { data: CodMixHasData }) {
  const ccy = data.currency_code as CurrencyCode;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="CoD Delivered"
          help="Cash-on-delivery revenue counted only once the order was actually delivered."
          value={formatMoneyDisplay(data.cod_delivered_minor, ccy)}
          sublabel="counted on delivery"
          data-testid="cod-mix-kpi-delivered"
        />
        <KpiTile
          label="RTO Reversals"
          help="CoD revenue taken back out because the shipment came back undelivered."
          value={`− ${formatMoneyDisplay(data.cod_rto_clawback_minor, ccy)}`}
          sublabel="reversed on return"
          data-testid="cod-mix-kpi-clawback"
        />
        <KpiTile
          label="CoD Net"
          help="What cash-on-delivery actually earned after undelivered orders were taken back out."
          value={formatMoneyDisplay(data.cod_net_minor, ccy)}
          sublabel="after RTO losses"
          data-testid="cod-mix-kpi-net"
        />
        <KpiTile
          label="CoD Share"
          help="How much of your confirmed revenue came from cash-on-delivery orders."
          value={data.cod_share_pct === null ? null : `${data.cod_share_pct}%`}
          sublabel="of confirmed revenue"
          data-testid="cod-mix-kpi-share"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Minus className="h-4 w-4" aria-hidden="true" />
            Confirmed revenue mix
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CodMixChart
            codNetMinor={data.cod_net_minor}
            prepaidMinor={data.prepaid_minor}
            codSharePct={data.cod_share_pct}
            currencyCode={ccy}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// ── 3. Checkout-conversion funnel (Shopflo — REAL, no badge) ───────────────────

function CheckoutFunnelSection() {
  const { data, isLoading, error, refetch } = useCheckoutFunnel();

  return (
    <section aria-label="Checkout conversion funnel" data-testid="checkout-funnel-section">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">Checkout funnel</h2>
        {/* Shopflo checkout_abandoned is REAL — synthetic badge only if the source says so. */}
        {data?.state === 'has_data' && data.data_source === 'synthetic' && (
          <SyntheticBadge data-testid="checkout-funnel-synthetic-badge" />
        )}
        {data?.state === 'has_data' && (
          <div className="ml-auto flex items-center gap-3">
            <DataWindowBadge
              from={LAST_30D.from}
              to={LAST_30D.to}
              count={toCount(data.abandoned_count)}
              label="abandoned checkouts"
              data-testid="checkout-funnel-window-badge"
            />
            <VerifyLink href="/analytics/abandoned-cart" label="See abandoned checkouts" />
          </div>
        )}
      </div>

      {isLoading && <SectionSkeleton label="checkout funnel" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {!isLoading && !error && data?.state === 'no_data' && (
        <EmptyConnectCard
          testId="checkout-funnel-empty"
          icon={<ShoppingBag className="h-8 w-8" />}
          title="No checkout data yet"
          description="Connect Shopflo and turn on its abandoned-checkout updates to see your abandoned-checkout funnel and discount leakage."
          cta="Connect Shopflo"
        />
      )}

      {!isLoading && !error && data?.state === 'has_data' && (
        <CheckoutFunnelData data={data} />
      )}
    </section>
  );
}

function CheckoutFunnelData({ data }: { data: CheckoutFunnelHasData }) {
  const ccy = data.currency_code as CurrencyCode;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Checkouts Abandoned"
          help="How many shoppers started checkout but left without paying."
          value={Number(BigInt(data.abandoned_count)).toLocaleString('en-IN')}
          sublabel="last 30 days"
          data-testid="checkout-funnel-kpi-abandoned"
        />
        <KpiTile
          label="Discount Applied"
          help="Abandoned checkouts where the shopper had already applied a discount code."
          value={Number(BigInt(data.discount_applied_count)).toLocaleString('en-IN')}
          sublabel="abandoned with a discount"
          data-testid="checkout-funnel-kpi-discount"
        />
        <KpiTile
          label="Cart Value at Risk"
          help="The total value of the carts left behind — sales you could still recover."
          value={formatMoneyDisplay(data.abandoned_value_minor, ccy)}
          sublabel="value you could still recover"
          data-testid="checkout-funnel-kpi-value"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Abandoned-checkout funnel
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CheckoutFunnelChart
            abandonedCount={data.abandoned_count}
            discountAppliedCount={data.discount_applied_count}
            withAddressCount={data.with_address_count}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// ── 2. RTO-risk distribution (GoKwik RTO-Predict — synthetic in dev) ────────────

function RtoRiskSection() {
  const { data, isLoading, error, refetch } = useRtoRiskDistribution();

  return (
    <section aria-label="Return-to-origin risk at checkout" data-testid="rto-risk-section">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          Return-to-origin (RTO) risk at checkout
        </h2>
        {data?.state === 'has_data' && data.data_source === 'synthetic' && (
          <SyntheticBadge data-testid="rto-risk-synthetic-badge" />
        )}
        {data?.state === 'has_data' && (
          <div className="ml-auto flex items-center gap-3">
            <DataWindowBadge
              from={LAST_30D.from}
              to={LAST_30D.to}
              count={toCount(data.order_count)}
              label="orders scored"
              data-testid="rto-risk-window-badge"
            />
            <VerifyLink href="/analytics/orders" label="See orders" />
          </div>
        )}
      </div>

      {isLoading && <SectionSkeleton label="RTO risk" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {!isLoading && !error && data?.state === 'no_data' && (
        <EmptyConnectCard
          testId="rto-risk-empty"
          icon={<Truck className="h-8 w-8" />}
          title="No RTO-risk predictions yet"
          description="Connect GoKwik so Brain can capture the RTO-Predict risk returned at checkout — then high-risk orders surface here before you ship them COD."
          cta="Connect GoKwik"
        />
      )}

      {!isLoading && !error && data?.state === 'has_data' && <RtoRiskData data={data} />}
    </section>
  );
}

function RtoRiskData({ data }: { data: RtoRiskHasData }) {
  const orders = Number(BigInt(data.order_count));
  const high = Number(BigInt(data.high));
  const highPct = orders > 0 ? Math.round((high / orders) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Orders Scored"
          help="Orders that received a delivery-risk prediction at checkout."
          value={orders.toLocaleString('en-IN')}
          sublabel="last 30 days"
          data-testid="rto-risk-kpi-orders"
        />
        <KpiTile
          label="High Risk"
          help="Orders predicted most likely to come back undelivered."
          value={high.toLocaleString('en-IN')}
          sublabel="latest prediction per order"
          data-testid="rto-risk-kpi-high"
        />
        <KpiTile
          label="High-Risk Share"
          help="The share of scored orders that were flagged high risk."
          value={`${highPct}%`}
          sublabel="of scored orders"
          data-testid="rto-risk-kpi-high-share"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Orders by RTO risk category
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RtoRiskChart
            high={data.high}
            medium={data.medium}
            low={data.low}
            control={data.control}
            unknown={data.unknown}
          />
        </CardContent>
      </Card>
    </div>
  );
}
