'use client';

/**
 * CheckoutContent — the checkout-step analytics surface (Shopflo Track C).
 *
 * ONE built section: the checkout-step funnel — /api/v1/analytics/checkout-funnel
 * (Shopflo, REAL). Reuses the existing useCheckoutFunnel hook + CheckoutFunnelChart
 * component (sole-read via the BFF metric-engine — NO ad-hoc SUM/COUNT in the client).
 *
 * Unbuilt breakdowns (abandonment reasons, device/browser mix) have NO Gold mart, so —
 * per the audit — they are HIDDEN rather than rendered as permanent "coming soon" empties.
 * When Shopflo is not connected the page shows a SINGLE honest empty (connect Shopflo),
 * never a fabricated zero.
 *
 * Data window (I honest-window): the funnel is a fixed rolling LAST-30-DAY aggregate (the
 * metric-engine window is a constant — the endpoint takes no from/to), so we surface a
 * <DataWindowBadge> stating "Showing D1 → D2" rather than a DateRangeFilter that couldn't
 * actually re-scope the read.
 *
 * Money discipline (I-S07 / D-7): every amount is a bigint-serialized minor-unit string
 * rendered via formatMoneyDisplay(minorString, currency_code) — NO /100, NO parseFloat.
 *
 * Proof (capture-truth → build-trust): each KPI carries a MetricTitle "how computed" tooltip,
 * and a <VerifyLink> drills the abandoned-cart figures through to the recoverable-carts list.
 *
 * A11y: every section is a labelled region; the funnel chart carries an SR-table
 * fallback + role=img (via CheckoutFunnelChart); the synthetic indicator is icon+label.
 */

import Link from 'next/link';
import { ShoppingBag, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { DataWindowBadge } from '@/components/ui/data-window-badge';
import { VerifyLink } from '@/components/ui/verify-link';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { CheckoutFunnelChart } from '@/components/analytics/checkout-funnel-chart';
import { useCheckoutFunnel } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { AnalyticsCheckoutFunnelResponse } from '@/lib/api/types';

type CheckoutFunnelHasData = Extract<AnalyticsCheckoutFunnelResponse, { state: 'has_data' }>;

/** The metric-engine funnel window is a fixed rolling 30 days (checkout-funnel.ts constant). */
const FUNNEL_WINDOW_DAYS = 30;

function SectionSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label={`Loading ${label}…`}>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export function CheckoutContent() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Checkout"
        description="Where checkouts leak — the Shopflo abandoned-checkout funnel over the last 30 days, and the cart value you could still recover."
      />

      <CheckoutFunnelSection />
    </div>
  );
}

// ── 1. Checkout-step funnel (Shopflo — REAL, no badge unless source says so) ────

function CheckoutFunnelSection() {
  const { data, isLoading, error, refetch } = useCheckoutFunnel();

  // Fixed rolling 30-day window (the endpoint takes no from/to — see FUNNEL_WINDOW_DAYS).
  const windowTo = new Date();
  const windowFrom = new Date(windowTo.getTime() - FUNNEL_WINDOW_DAYS * 86_400_000);

  return (
    <section aria-label="Checkout-step funnel" data-testid="checkout-funnel-section">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold text-foreground">Checkout-step funnel</h2>
        {data?.state === 'has_data' && data.data_source === 'synthetic' && (
          <SyntheticBadge data-testid="checkout-funnel-synthetic-badge" />
        )}
        {data?.state === 'has_data' && (
          <DataWindowBadge
            from={windowFrom.toISOString()}
            to={windowTo.toISOString()}
            count={Number(BigInt(data.abandoned_count))}
            label="abandoned checkouts"
            data-testid="checkout-funnel-window"
          />
        )}
      </div>

      {isLoading && <SectionSkeleton label="checkout funnel" />}
      {!isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {!isLoading && !error && data?.state === 'no_data' && (
        <Card data-testid="checkout-funnel-empty">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="text-muted-foreground" aria-hidden="true">
              <ShoppingBag className="h-8 w-8" />
            </div>
            <div>
              <p className="font-medium text-foreground">No checkout data yet</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                Connect Shopflo and turn on its abandoned-checkout updates to see your
                checkout-step funnel and discount leakage.
              </p>
            </div>
            <Link href="/settings/connectors">
              <Button variant="outline" size="sm">
                Connect Shopflo
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && data?.state === 'has_data' && <CheckoutFunnelData data={data} />}
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

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          Counted from Shopflo&rsquo;s abandoned-checkout signal over the last {FUNNEL_WINDOW_DAYS} days.
        </p>
        <VerifyLink href="/cart-abandonment" label="See recoverable carts" />
      </div>
    </div>
  );
}
