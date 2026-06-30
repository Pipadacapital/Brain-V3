'use client';

/**
 * CheckoutContent — the checkout-step analytics surface (Shopflo Track C).
 *
 * Three sections:
 *   1. Checkout-step funnel — /api/v1/analytics/checkout-funnel (Shopflo, REAL).
 *      Reuses the existing useCheckoutFunnel hook + CheckoutFunnelChart component
 *      (sole-read via the BFF metric-engine — NO ad-hoc SUM/COUNT in the client).
 *   2. Abandonment reasons       — honest-empty (no Gold mart yet).
 *   3. Device / browser breakdown — honest-empty (no Gold mart yet).
 *
 * Money discipline (I-S07 / D-7): every amount is a bigint-serialized minor-unit string
 * rendered via formatMoneyDisplay(minorString, currency_code) — NO /100, NO parseFloat.
 *
 * Honest states: skeletons (aria-busy), ErrorCard with request_id on error, and honest
 * EmptyState surfaces — never a fabricated zero. Sections without a mart yet say so
 * plainly (what unlocks them) rather than rendering an empty chart as success.
 *
 * A11y: every section is a labelled region; the funnel chart carries an SR-table
 * fallback + role=img (via CheckoutFunnelChart); the synthetic indicator is icon+label.
 */

import Link from 'next/link';
import { ShoppingBag, MessageSquareWarning, MonitorSmartphone, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { CheckoutFunnelChart } from '@/components/analytics/checkout-funnel-chart';
import { useCheckoutFunnel } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { AnalyticsCheckoutFunnelResponse } from '@/lib/api/types';

type CheckoutFunnelHasData = Extract<AnalyticsCheckoutFunnelResponse, { state: 'has_data' }>;

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
        description="Where checkouts convert — and where they leak. The Shopflo checkout-step funnel, plus abandonment reasons and device mix as those marts come online."
      />

      <CheckoutFunnelSection />
      <AbandonmentReasonsSection />
      <DeviceBreakdownSection />
    </div>
  );
}

// ── 1. Checkout-step funnel (Shopflo — REAL, no badge unless source says so) ────

function CheckoutFunnelSection() {
  const { data, isLoading, error, refetch } = useCheckoutFunnel();

  return (
    <section aria-label="Checkout-step funnel" data-testid="checkout-funnel-section">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">Checkout-step funnel</h2>
        {data?.state === 'has_data' && data.data_source === 'synthetic' && (
          <SyntheticBadge data-testid="checkout-funnel-synthetic-badge" />
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
                Connect Shopflo and configure the checkout_abandoned webhook to see your
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

// ── 2. Abandonment reasons (no mart yet — honest empty) ────────────────────────

function AbandonmentReasonsSection() {
  return (
    <section aria-label="Abandonment reasons" data-testid="checkout-reasons-section">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">Abandonment reasons</h2>
      </div>
      <Card data-testid="checkout-reasons-empty">
        <CardContent className="py-4">
          <EmptyState
            title="Abandonment reasons aren't broken out yet"
            description="Why checkouts drop — payment failure, shipping cost, RTO-risk decline, coupon error — needs a dedicated Gold mart over the Shopflo checkout signal. It isn't built yet, so we show nothing rather than a fabricated split."
            icon={<MessageSquareWarning className="h-8 w-8" />}
            hint="Unlocks when the checkout-reason Gold mart lands."
            compact
          />
        </CardContent>
      </Card>
    </section>
  );
}

// ── 3. Device / browser breakdown (no mart yet — honest empty) ─────────────────

function DeviceBreakdownSection() {
  return (
    <section aria-label="Device and browser breakdown" data-testid="checkout-device-section">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">Device &amp; browser breakdown</h2>
      </div>
      <Card data-testid="checkout-device-empty">
        <CardContent className="py-4">
          <EmptyState
            title="Device & browser mix isn't broken out yet"
            description="Checkout conversion by device class and browser needs a dedicated Gold mart over the pixel/checkout signal. It isn't built yet, so we show nothing rather than an empty chart."
            icon={<MonitorSmartphone className="h-8 w-8" />}
            hint="Unlocks when the checkout device-mix Gold mart lands."
            compact
          />
        </CardContent>
      </Card>
    </section>
  );
}
