'use client';

/**
 * AttributionContent — the attribution surface (Phase 5, Gold attribution credit ledger).
 *
 * The unit-economics payoff: it joins the deterministic multi-touch attribution credit
 * ledger (position-based / first / last / linear, with saved-weight clawback) with the
 * realized-revenue ledger and ad_spend_ledger to answer the decision question —
 * "WHICH CHANNELS actually earn the revenue, and what is each channel's ROAS?"
 *
 * It reads ONLY via the BFF endpoints /api/v1/analytics/attribution/* (the metric-engine
 * sole read path, I-ST01) — NEVER the credit ledger / StarRocks directly, never an inlined
 * SUM in the client. Every figure is Tier-0 deterministic (no model, no prompt, no dbt
 * macro). The UI never re-apportions weights and never does float money math.
 *
 * What it shows:
 *   - A 4-model selector (default = position_based, the brand's active model).
 *   - Attributed revenue BY CHANNEL (Recharts horizontal bars + SR-table + confidence grade).
 *   - The RECONCILIATION RESIDUAL alongside — the closed-sum parity oracle made visible
 *     (attributed + unattributed = realized; the residual is never hidden).
 *   - Per-channel ROAS = attributed revenue ÷ ad spend (honest n/a when spend = 0).
 *
 * Money: SIGNED bigint minor-unit strings (I-S07) → formatMoneyDisplay (locale-aware).
 * Net-of-clawback contributions can be below gross — the net is what we render (honest).
 *
 * DEV-HONESTY: data_source comes from the BFF (never hardcoded). Real journey data is thin
 * (23 real touchpoints), so dev attribution is mostly synthetic — when so the BFF returns
 * data_source='synthetic' and <SyntheticBadge/> renders. A subtle "Powered by the Silver
 * tier" label marks the journey provenance.
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id on error, and an honest
 * empty state linking /settings/pixel — never a fabricated zero.
 *
 * A11y: each section is a labelled region; the chart carries an SR-table fallback + role=img;
 * status / synthetic / confidence indicators are icon+label (never colour-only); the model
 * selector is a keyboard-reachable radio group.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Layers, ArrowRight, Target, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { AttributionModelSelector } from '@/components/analytics/attribution-model-selector';
import { AttributedChannelChart } from '@/components/analytics/attributed-channel-chart';
import { ConfidenceGradeBadge } from '@/components/analytics/confidence-grade-badge';
import { ChannelRoasTable } from '@/components/analytics/channel-roas-table';
import { ReconciliationResidualCard } from '@/components/analytics/reconciliation-residual-card';
import {
  useAttributionByChannel,
  useAttributionReconciliation,
  useChannelRoas,
} from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type {
  AttributionModel,
  AnalyticsAttributionByChannelResponse,
  AnalyticsAttributionReconciliationResponse,
} from '@/lib/api/types';

type ByChannelHasData = Extract<AnalyticsAttributionByChannelResponse, { state: 'has_data' }>;
type ReconHasData = Extract<AnalyticsAttributionReconciliationResponse, { state: 'has_data' }>;

/** Date-range presets (days). The range drives every attribution BFF query. */
const RANGE_PRESETS = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 180 days', days: 180 },
] as const;
type RangeKey = (typeof RANGE_PRESETS)[number]['key'];

function rangeFor(days: number): { from: string; to: string } {
  const to = new Date().toISOString().split('T')[0] as string;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0] as string;
  return { from, to };
}

function AttributionSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading attribution…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/** Honest empty card with a pixel-setup CTA (never a fabricated zero). */
function EmptyAttributionCard() {
  return (
    <Card data-testid="attribution-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <Target className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No attributed revenue yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Attribution credits revenue to the journeys that earned it. It needs Brain Pixel
            touchpoints (the Silver tier) stitched to realized orders. Once journeys and orders
            land, channel credit and ROAS build here.
          </p>
        </div>
        <Link href="/settings/pixel">
          <Button variant="outline" size="sm">
            Set up the Brain Pixel
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

export function AttributionContent() {
  const [model, setModel] = useState<AttributionModel>('position_based');
  const [rangeKey, setRangeKey] = useState<RangeKey>('90');
  const preset = RANGE_PRESETS.find((p) => p.key === rangeKey) ?? RANGE_PRESETS[1];
  const { from, to } = rangeFor(preset.days);

  const byChannelQ = useAttributionByChannel({ model, from, to });
  const reconQ = useAttributionReconciliation({ model, from, to });
  const roasQ = useChannelRoas({ model, from, to });

  const isLoading = byChannelQ.isLoading;
  const error = byChannelQ.error;

  const byChannel = byChannelQ.data;
  const recon = reconQ.data;
  const roas = roasQ.data;

  const synthetic =
    (byChannel?.state === 'has_data' && byChannel.data_source === 'synthetic') ||
    (recon?.state === 'has_data' && recon.data_source === 'synthetic');

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-foreground">Attribution</h1>
          {/* Subtle provenance: journeys come from the Silver tier. */}
          <span
            data-testid="attribution-silver-label"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Journeys are read from the Silver analytics tier (dbt → StarRocks silver.touchpoint); credit is computed deterministically in the metric engine over the Gold attribution credit ledger."
          >
            <Layers className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        </div>
        <p className="text-muted-foreground mt-1">
          Multi-touch attributed revenue by channel, the unattributed residual (the closed sum
          always adds up), and per-channel ROAS — every figure deterministically credited from
          your journeys and realized revenue.
        </p>
      </div>

      {/* ── Model selector + date range ── */}
      <section aria-label="Attribution controls" data-testid="attribution-controls">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-center gap-2">
            <AttributionModelSelector model={model} onChange={setModel} />
            {synthetic && (
              <SyntheticBadge
                data-testid="attribution-synthetic-badge"
                reason="Real journey data is thin (23 real touchpoints), so attribution coverage in this window is mostly synthetic — clearly-labelled journey fixtures (real shape, synthetic source). Never presented as live attribution."
              />
            )}
          </div>

          {/* Date-range selector — drives the BFF query (local UI state). */}
          <div
            role="group"
            aria-label="Date range"
            className="inline-flex rounded-md border border-border p-0.5"
          >
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setRangeKey(p.key)}
                aria-pressed={rangeKey === p.key}
                data-testid={`attribution-range-${p.key}`}
                className={
                  rangeKey === p.key
                    ? 'rounded px-3 py-1 text-xs font-medium bg-foreground text-background'
                    : 'rounded px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Attributed revenue by channel + reconciliation residual ── */}
      <section aria-label="Attributed revenue by channel" data-testid="attribution-by-channel-section">
        {isLoading && <AttributionSkeleton />}
        {!isLoading && error && <ErrorCard error={error} retry={byChannelQ.refetch} />}

        {!isLoading && !error && byChannel?.state === 'no_data' && <EmptyAttributionCard />}

        {!isLoading && !error && byChannel?.state === 'has_data' && (
          <AttributionData
            byChannel={byChannel}
            recon={recon?.state === 'has_data' ? recon : null}
          />
        )}
      </section>

      {/* ── Channel ROAS (the per-channel unit economics) ── */}
      <section aria-label="Channel ROAS" data-testid="attribution-roas-section">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" aria-hidden="true" />
            Channel ROAS
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Attributed revenue ÷ ad spend, per channel — the real per-channel return on ad spend.
            Same-currency only; honest n/a when there is no spend.
          </p>
        </div>
        <Card>
          <CardContent className="pt-6">
            {roasQ.isLoading ? (
              <div className="space-y-2" aria-busy="true" aria-label="Loading channel ROAS">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-8 bg-muted animate-pulse rounded" />
                ))}
              </div>
            ) : roasQ.error ? (
              <ErrorCard error={roasQ.error} retry={roasQ.refetch} />
            ) : roas?.state === 'has_data' ? (
              <ChannelRoasTable rows={roas.rows} className="w-full text-sm" />
            ) : (
              <p className="text-sm text-muted-foreground italic" role="status">
                No channel ROAS yet — attribution or ad spend has no rows in this window.
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function AttributionData({
  byChannel,
  recon,
}: {
  byChannel: ByChannelHasData;
  recon: ReconHasData | null;
}) {
  const ccy = byChannel.currency_code as CurrencyCode;
  const attributedValue = formatMoneyDisplay(byChannel.attributed_minor, ccy);
  const channelCount = byChannel.channels.length;

  // Distinct confidence grades present across credited channels, in strength order — shown
  // as visible icon+label badges (the deterministic floor; never colour-only, never a model
  // number). The grade is stamped at credit time and carried verbatim to clawback.
  const GRADE_ORDER = { strong: 0, partial: 1, weak: 2 } as const;
  const grades = [...new Set(byChannel.channels.map((c) => c.confidence_grade))].sort(
    (a, b) => GRADE_ORDER[a] - GRADE_ORDER[b],
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Left: KPI tiles + the by-channel chart (spans 2 cols on desktop). */}
      <div className="space-y-4 lg:col-span-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label="Attributed revenue"
            value={attributedValue}
            sublabel={`${byChannel.from} → ${byChannel.to}`}
            data-testid="attribution-kpi-attributed"
          />
          <KpiTile
            label="Reconciliation rate"
            value={
              recon && recon.reconciliation_rate_pct != null
                ? `${recon.reconciliation_rate_pct}%`
                : null
            }
            sublabel="attributed ÷ realized"
            data-testid="attribution-kpi-recon-rate"
          />
          <KpiTile
            label="Channels credited"
            value={channelCount.toLocaleString('en-IN')}
            sublabel={`${byChannel.model.replace('_', '-')} model`}
            data-testid="attribution-kpi-channels"
          />
        </div>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Attributed revenue by channel
              </CardTitle>
              {grades.length > 0 && (
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  aria-label="Attribution confidence grades present"
                  data-testid="attribution-confidence-legend"
                >
                  {grades.map((g) => (
                    <ConfidenceGradeBadge key={g} grade={g} data-testid={`confidence-grade-${g}`} />
                  ))}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <AttributedChannelChart
              rows={byChannel.channels}
              currencyCode={byChannel.currency_code}
            />
          </CardContent>
        </Card>
      </div>

      {/* Right: the reconciliation residual — the closed-sum parity oracle made visible. */}
      <div className="lg:col-span-1">
        {recon ? (
          <ReconciliationResidualCard
            currencyCode={recon.currency_code}
            realizedMinor={recon.realized_minor}
            attributedMinor={recon.attributed_minor}
            unattributedMinor={recon.unattributed_minor}
            reconciliationRatePct={recon.reconciliation_rate_pct}
          />
        ) : (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-sm text-muted-foreground italic" role="status">
                Reconciliation residual unavailable for this window.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
