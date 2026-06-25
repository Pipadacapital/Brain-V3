'use client';

/**
 * CodRtoContent — the CoD / RTO analytics surface (GoKwik + Shopflo Track C).
 *
 * Three views, each via the BFF sole-read-path (metric-engine, ADR-002 — NO ad-hoc
 * SUM/COUNT in the client or routes):
 *   1. RTO% by pincode cohort   — /api/v1/analytics/cod-rto-rates (GoKwik AWB, SYNTHETIC dev)
 *   2. CoD-vs-prepaid + CoD CM2  — /api/v1/analytics/cod-mix       (ledger cod_*, SYNTHETIC dev)
 *   3. Checkout-conversion funnel— /api/v1/analytics/checkout-funnel (Shopflo, REAL)
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

import Link from 'next/link';
import { Truck, ArrowRight, ShoppingBag, Wallet, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { RtoPincodeChart } from '@/components/analytics/rto-pincode-chart';
import { CodMixChart } from '@/components/analytics/cod-mix-chart';
import { CheckoutFunnelChart } from '@/components/analytics/checkout-funnel-chart';
import { RtoRiskChart } from '@/components/analytics/rto-risk-chart';
import { useCodRtoRates, useCodMix, useCheckoutFunnel, useRtoRiskDistribution } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type {
  AnalyticsCodMixResponse,
  AnalyticsCheckoutFunnelResponse,
  AnalyticsRtoRiskResponse,
} from '@/lib/api/types';

type CodMixHasData = Extract<AnalyticsCodMixResponse, { state: 'has_data' }>;
type CheckoutFunnelHasData = Extract<AnalyticsCheckoutFunnelResponse, { state: 'has_data' }>;
type RtoRiskHasData = Extract<AnalyticsRtoRiskResponse, { state: 'has_data' }>;

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
      <CodMixSection />
      <CheckoutFunnelSection />
    </div>
  );
}

// ── 1. RTO% by pincode cohort (GoKwik AWB — synthetic in dev) ──────────────────

function RtoSection() {
  const { data, isLoading, error, refetch } = useCodRtoRates();

  return (
    <section aria-label="RTO rate by pincode" data-testid="cod-rto-section">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">RTO rate by pincode</h2>
        {/* Badge shown whenever the data is synthetic-sourced (GoKwik dev). */}
        {data?.state === 'has_data' && data.data_source === 'synthetic' && (
          <SyntheticBadge
            data-testid="cod-rto-synthetic-badge"
            reason="GoKwik AWB lifecycle is synthetic in dev (real shape, synthetic source). Real partner sandbox is a platform follow-up."
          />
        )}
      </div>

      {isLoading && <SectionSkeleton label="RTO by pincode" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {!isLoading && !error && data?.state === 'no_data' && (
        <EmptyConnectCard
          testId="cod-rto-empty"
          icon={<Truck className="h-8 w-8" />}
          title="No RTO data yet"
          description="Connect GoKwik to track return-to-origin by pincode. RTO rate appears once AWB shipments reach a terminal state (delivered or returned)."
          cta="Connect GoKwik"
        />
      )}

      {!isLoading && !error && data?.state === 'has_data' && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile
              label="Overall RTO Rate"
              value={data.overall_rto_rate_pct === null ? null : `${data.overall_rto_rate_pct}%`}
              sublabel="returned ÷ terminal shipments"
              lowerIsBetter
              data-testid="cod-rto-kpi-overall"
            />
            <KpiTile
              label="RTO Shipments"
              value={Number(BigInt(data.total_rto)).toLocaleString('en-IN')}
              sublabel="terminal returns"
              data-testid="cod-rto-kpi-rto-count"
            />
            <KpiTile
              label="Terminal Shipments"
              value={Number(BigInt(data.total_terminal)).toLocaleString('en-IN')}
              sublabel="delivered or returned"
              data-testid="cod-rto-kpi-terminal-count"
            />
          </div>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                RTO rate by destination pincode
              </CardTitle>
            </CardHeader>
            <CardContent>
              <RtoPincodeChart cohorts={data.cohorts} pincodePending={data.pincode_pending} />
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}

// ── 2. CoD-vs-prepaid mix + CoD CM2 (ledger cod_* — synthetic in dev) ──────────

function CodMixSection() {
  const { data, isLoading, error, refetch } = useCodMix();

  return (
    <section aria-label="CoD versus prepaid mix" data-testid="cod-mix-section">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">CoD vs prepaid &amp; CoD CM2</h2>
        {/* CoD ledger is fed by the synthetic GoKwik AWB consumer in dev. */}
        <SyntheticBadge
          data-testid="cod-mix-synthetic-badge"
          reason="CoD CM2 derives from the GoKwik AWB terminal-state ledger, synthetic in dev. Settlement/fees + EMI/loyalty are synthetic-only. Real partner sandbox is a platform follow-up."
        />
      </div>

      {isLoading && <SectionSkeleton label="CoD mix" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {!isLoading && !error && data?.state === 'no_data' && (
        <EmptyConnectCard
          testId="cod-mix-empty"
          icon={<Wallet className="h-8 w-8" />}
          title="No CoD data yet"
          description="Connect GoKwik to see CoD-vs-prepaid mix and CoD CM2 (cash-on-delivery contribution after RTO clawback)."
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
          value={formatMoneyDisplay(data.cod_delivered_minor, ccy)}
          sublabel="recognized on delivery"
          data-testid="cod-mix-kpi-delivered"
        />
        <KpiTile
          label="RTO Clawback"
          value={`− ${formatMoneyDisplay(data.cod_rto_clawback_minor, ccy)}`}
          sublabel="reversed on return"
          data-testid="cod-mix-kpi-clawback"
        />
        <KpiTile
          label="CoD CM2 (Net)"
          value={formatMoneyDisplay(data.cod_net_minor, ccy)}
          sublabel="after RTO leakage"
          data-testid="cod-mix-kpi-net"
        />
        <KpiTile
          label="CoD Share"
          value={data.cod_share_pct === null ? null : `${data.cod_share_pct}%`}
          sublabel="of recognized revenue"
          data-testid="cod-mix-kpi-share"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Minus className="h-4 w-4" aria-hidden="true" />
            Recognized revenue mix
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
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">Checkout funnel</h2>
        {/* Shopflo checkout_abandoned is REAL — synthetic badge only if the source says so. */}
        {data?.state === 'has_data' && data.data_source === 'synthetic' && (
          <SyntheticBadge data-testid="checkout-funnel-synthetic-badge" />
        )}
      </div>

      {isLoading && <SectionSkeleton label="checkout funnel" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {!isLoading && !error && data?.state === 'no_data' && (
        <EmptyConnectCard
          testId="checkout-funnel-empty"
          icon={<ShoppingBag className="h-8 w-8" />}
          title="No checkout data yet"
          description="Connect Shopflo and configure the checkout_abandoned webhook to see your abandoned-checkout funnel and discount leakage."
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
          value={Number(BigInt(data.abandoned_count)).toLocaleString('en-IN')}
          sublabel="last 30 days"
          data-testid="checkout-funnel-kpi-abandoned"
        />
        <KpiTile
          label="Discount Applied"
          value={Number(BigInt(data.discount_applied_count)).toLocaleString('en-IN')}
          sublabel="abandoned with a discount"
          data-testid="checkout-funnel-kpi-discount"
        />
        <KpiTile
          label="Cart Value at Risk"
          value={formatMoneyDisplay(data.abandoned_value_minor, ccy)}
          sublabel="recoverable GMV"
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
    <section aria-label="RTO risk distribution" data-testid="rto-risk-section">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">RTO risk at checkout</h2>
        {data?.state === 'has_data' && data.data_source === 'synthetic' && (
          <SyntheticBadge data-testid="rto-risk-synthetic-badge" />
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
          value={orders.toLocaleString('en-IN')}
          sublabel="last 30 days"
          data-testid="rto-risk-kpi-orders"
        />
        <KpiTile
          label="High Risk"
          value={high.toLocaleString('en-IN')}
          sublabel="latest prediction per order"
          data-testid="rto-risk-kpi-high"
        />
        <KpiTile
          label="High-Risk Share"
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
