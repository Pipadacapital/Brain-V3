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
 *   - A model selector (default = position_based, the brand's active model).
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

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Layers, ArrowRight, Target, TrendingUp, Megaphone, Workflow, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { AttributionModelSelector } from '@/components/analytics/attribution-model-selector';
import { AttributedChannelChart } from '@/components/analytics/attributed-channel-chart';
import { ConfidenceGradeBadge } from '@/components/analytics/confidence-grade-badge';
import { ReconciliationResidualCard } from '@/components/analytics/reconciliation-residual-card';
import { Sankey, type SankeyNode, type SankeyLink } from '@/components/analytics/sankey';
import { TrendChart } from '@/components/analytics/trend-chart';
import { channelMeta } from '@/components/analytics/channel-meta';
import { DateRangeFilter, initialRange, type DateRange, type RangePreset } from '@/components/ui/date-range-filter';
import {
  useAttributionByChannel,
  useAttributionReconciliation,
  useChannelRoas,
  useCampaignAttribution,
  useJourneyPaths,
  useAttributedRevenueTimeseries,
} from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type {
  AttributionModel,
  AnalyticsAttributionByChannelResponse,
  AnalyticsAttributionReconciliationResponse,
  AnalyticsCampaignAttributionResponse,
  AnalyticsJourneyPathsResponse,
  AnalyticsAttributedRevenueTimeseriesResponse,
  AnalyticsTimeseriesResponse,
  AttributionConfidenceGrade,
  ChannelRoasRow,
} from '@/lib/api/types';

type ByChannelHasData = Extract<AnalyticsAttributionByChannelResponse, { state: 'has_data' }>;
type ReconHasData = Extract<AnalyticsAttributionReconciliationResponse, { state: 'has_data' }>;
type CampaignAttrHasData = Extract<AnalyticsCampaignAttributionResponse, { state: 'has_data' }>;

/** Date-range presets for attribution — longer windows than the default 7/30/90. */
const ATTRIBUTION_PRESETS: readonly RangePreset[] = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 180 days', days: 180 },
];

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

/** A stable terminal-node id for the channel → revenue Sankey (never a real channel name). */
const REVENUE_NODE_ID = '__attributed_revenue__';

/**
 * Format a pre-divided MAJOR-unit chart magnitude (number) as locale currency for the Sankey
 * band/node labels. The exact money stays minor-unit-safe upstream (by_channel.contribution_minor);
 * only this already-divided display magnitude is rendered here (Sankey contract), so no float money
 * math drives a real figure. 0 fraction digits — it's a chart label, not an exact ledger amount.
 */
function makeMoneyMajorFormat(currency: CurrencyCode): (v: number) => string {
  return (v: number) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }).format(v);
    } catch {
      return `${currency} ${v.toLocaleString()}`;
    }
  };
}

/**
 * Roll the date × channel attributed-revenue timeseries up into the shared TrendChart's
 * realized/provisional shape: aggregate attributed revenue per bucket for the single primary
 * currency (NEVER blend currencies). `provisional` is left at 0 — this series is ATTRIBUTED
 * revenue (net of clawback), not the realized/provisional recognition ledger; the card title
 * frames it honestly. Mirrors the marketing-campaigns rollup so the chart shape stays identical.
 */
function rollupAttributedRevenueToTrend(
  ts: AnalyticsAttributedRevenueTimeseriesResponse | undefined,
): AnalyticsTimeseriesResponse | undefined {
  if (!ts) return undefined;
  if (ts.state === 'no_data' || ts.buckets.length === 0) {
    return { state: 'no_data', from: ts.from, to: ts.to, grain: ts.grain };
  }
  // Primary currency = the one with the most buckets (we never blend currencies in one chart).
  const ccyCount = new Map<string, number>();
  for (const b of ts.buckets) ccyCount.set(b.currency_code, (ccyCount.get(b.currency_code) ?? 0) + 1);
  const primary = [...ccyCount.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  const perBucket = new Map<string, bigint>();
  for (const b of ts.buckets) {
    if (b.currency_code !== primary) continue;
    perBucket.set(b.bucket, (perBucket.get(b.bucket) ?? 0n) + BigInt(b.attributed_revenue_minor));
  }
  const buckets = [...perBucket.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([bucket, sum]) => ({
      bucket,
      currency_code: primary,
      realized_minor: sum.toString(),
      provisional_minor: '0',
    }));
  return { state: 'has_data', from: ts.from, to: ts.to, grain: ts.grain, buckets };
}

/**
 * Build the channel → revenue Sankey graph from BOTH journey-path structure and by-channel money.
 *
 * Bands (the only magnitude-bearing flow) are sized PURELY by by_channel attributed revenue —
 * each credited channel → a single "Revenue" terminal, in pre-divided MAJOR units. The UI never
 * re-apportions weights (page invariant), so the journey-path edges (which are in JOURNEY counts,
 * a different unit) are NOT drawn as bands — instead they ORDER the channel nodes by journey
 * prominence so the flow reads in the same order as the journeys that produced it, and supply the
 * honest journeys-observed context. Single unit on the canvas = money. Honest empty falls through
 * to the Sankey's own EmptyState when no channel has positive attributed revenue.
 */
function buildChannelRevenueSankey(
  byChannel: ByChannelHasData,
  paths: AnalyticsJourneyPathsResponse | undefined,
): { nodes: SankeyNode[]; links: SankeyLink[] } {
  // Journey prominence per channel — Σ journeys touching the channel across the top path edges.
  const journeysByChannel = new Map<string, bigint>();
  if (paths?.state === 'has_data') {
    for (const l of paths.links) {
      const j = BigInt(l.journeys);
      journeysByChannel.set(l.from_channel, (journeysByChannel.get(l.from_channel) ?? 0n) + j);
      journeysByChannel.set(l.to_channel, (journeysByChannel.get(l.to_channel) ?? 0n) + j);
    }
  }

  // channel → Revenue, band = attributed revenue in MAJOR units (chart magnitude; minor upstream).
  const links: SankeyLink[] = byChannel.by_channel
    .map((c) => ({
      source: c.channel,
      target: REVENUE_NODE_ID,
      value: Number(BigInt(c.contribution_minor) / 100n),
      label: channelMeta(c.channel).label,
    }))
    .filter((l) => l.value > 0);

  // Order channel nodes by journey prominence (path data), then the canonical channel order.
  const channelIds = [...new Set(links.map((l) => l.source))].sort((a, b) => {
    const ja = journeysByChannel.get(a) ?? 0n;
    const jb = journeysByChannel.get(b) ?? 0n;
    if (ja !== jb) return ja > jb ? -1 : 1;
    return channelMeta(a).order - channelMeta(b).order;
  });

  const nodes: SankeyNode[] = [
    ...channelIds.map((id) => ({
      id,
      label: channelMeta(id).label,
      color: channelMeta(id).chartVar,
    })),
    { id: REVENUE_NODE_ID, label: 'Revenue', color: 'hsl(var(--chart-1))' },
  ];

  return { nodes, links };
}

export function AttributionContent() {
  const [model, setModel] = useState<AttributionModel>('position_based');
  const [range, setRange] = useState<DateRange>(() => initialRange(ATTRIBUTION_PRESETS, '90'));

  const byChannelQ = useAttributionByChannel({ model, from: range.from, to: range.to });
  const reconQ = useAttributionReconciliation({ model, from: range.from, to: range.to });
  const roasQ = useChannelRoas({ model, from: range.from, to: range.to });
  // Per-campaign attributed revenue + ROAS (#32c) — brand-wide roll-up under the same model selector.
  const campaignQ = useCampaignAttribution({ model });
  // Channel → revenue Sankey: journey-path structure (ordering/context) + by-channel money (bands).
  const pathsQ = useJourneyPaths({ limit: 25 });
  // Attributed-revenue-over-time (P3) — model-selector + date-range driven; rolled to the TrendChart.
  const tsQ = useAttributedRevenueTimeseries({
    model,
    date_start: range.from,
    date_end: range.to,
  });
  const tsTrend = useMemo(() => rollupAttributedRevenueToTrend(tsQ.data), [tsQ.data]);

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
      <PageHeader
        title="Attribution"
        description="Multi-touch attributed revenue by channel, the unattributed residual (the closed sum always adds up), and per-channel ROAS — every figure deterministically credited from your journeys and realized revenue."
        meta={
          <span
            data-testid="attribution-silver-label"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Journeys are read from the Silver analytics tier (dbt → StarRocks silver.touchpoint); credit is computed deterministically in the metric engine over the Gold attribution credit ledger."
          >
            <Layers className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        }
      />

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
          <DateRangeFilter
            value={range}
            onChange={setRange}
            presets={ATTRIBUTION_PRESETS}
            aria-label="Attribution date range"
          />
        </div>
      </section>

      {/* ── Attributed revenue by channel + reconciliation residual ── */}
      <section aria-label="Attributed revenue by channel" data-testid="attribution-by-channel-section">
        {isLoading && <AttributionSkeleton />}
        {!isLoading && error && <ErrorCard error={error} retry={byChannelQ.refetch} />}

        {!isLoading && !error && byChannel?.state === 'no_data' && <EmptyAttributionCard />}

        {!isLoading && !error && byChannel?.state === 'not_computed' && (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm" role="status">
                <strong>Attribution not computed yet.</strong> This brand has realized revenue, but the
                attribution credit ledger is empty — the credit pipeline hasn&apos;t populated it.
                Per-channel attribution appears here once it runs. We don&apos;t show a 0%/100% figure,
                because that would be a guess, not a measurement.
              </p>
            </CardContent>
          </Card>
        )}

        {!isLoading && !error && byChannel?.state === 'has_data' && (
          <AttributionData
            byChannel={byChannel}
            recon={recon?.state === 'has_data' ? recon : null}
          />
        )}
      </section>

      {/* ── Channel → revenue flow (the Sankey: which channels feed the attributed revenue) ── */}
      <section aria-label="Channel to revenue flow" data-testid="attribution-sankey-section">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Workflow className="h-4 w-4" aria-hidden="true" />
            Channel → revenue flow
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Each band&apos;s thickness is the attributed revenue that channel earns under the{' '}
            {model.replace('_', '-')} model, flowing into total realized revenue. Bands are sized by
            money only (we never re-apportion credit in the browser); channels are ordered by how
            many of your journeys touched them
            {pathsQ.data?.state === 'has_data'
              ? ` (${Number(BigInt(pathsQ.data.total_journeys)).toLocaleString('en-IN')} journeys across ${pathsQ.data.total_paths.toLocaleString('en-IN')} paths)`
              : ''}
            .
          </p>
        </div>
        <Card>
          <CardContent className="pt-6">
            {isLoading ? (
              <Skeleton className="h-72 w-full rounded-lg" />
            ) : error ? (
              <ErrorCard error={error} retry={byChannelQ.refetch} />
            ) : byChannel?.state === 'has_data' ? (
              (() => {
                const { nodes, links } = buildChannelRevenueSankey(byChannel, pathsQ.data);
                return (
                  <Sankey
                    nodes={nodes}
                    links={links}
                    height={Math.max(280, Math.min(520, links.length * 56 + 80))}
                    valueFormat={makeMoneyMajorFormat((byChannel.currency_code ?? 'INR') as CurrencyCode)}
                    caption="Attributed revenue by channel, flowing into total realized revenue"
                    data-testid="attribution-channel-sankey"
                  />
                );
              })()
            ) : (
              <p className="text-sm text-muted-foreground italic" role="status">
                No channel → revenue flow yet — attribution credit has no rows for this model and
                window. The flow appears once journeys are credited with revenue.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Attributed revenue over time (P3 — the date-grain credit ledger as a trend) ── */}
      <section aria-label="Attributed revenue over time" data-testid="attribution-timeseries-section">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Activity className="h-4 w-4" aria-hidden="true" />
            Attributed revenue over time
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Daily attributed revenue (net of clawback) for the {model.replace('_', '-')} model over
            the selected window, summed across every credited channel — including organic and direct,
            not only campaign-bearing touches. Single currency per chart (never blended); this is
            attributed credit, not the realized/provisional recognition ledger.
          </p>
        </div>
        <Card>
          <CardContent className="pt-6">
            {tsQ.error ? (
              <ErrorCard error={tsQ.error} retry={tsQ.refetch} />
            ) : (
              <TrendChart data={tsTrend} isLoading={tsQ.isLoading} />
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Channel performance (the per-channel unit economics) ── */}
      <section aria-label="Channel performance" data-testid="attribution-roas-section">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" aria-hidden="true" />
            Channel performance
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Ad spend, attributed revenue and ROAS per channel — the real per-channel return on ad
            spend. Same-currency only; honest n/a when there is no spend. Conversions, CPA,
            impressions and clicks are shown as &ldquo;—&rdquo; because the per-channel feed
            (gold_campaign_performance) is spend-only — we never fabricate a count we did not measure.
          </p>
        </div>
        <Card>
          <CardContent className="pt-6">
            {roasQ.isLoading ? (
              <div className="space-y-2" aria-busy="true" aria-label="Loading channel performance">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-8 bg-muted animate-pulse rounded" />
                ))}
              </div>
            ) : roasQ.error ? (
              <ErrorCard error={roasQ.error} retry={roasQ.refetch} />
            ) : roas?.state === 'has_data' ? (
              <ChannelPerformanceTable rows={roas.rows} />
            ) : roas?.state === 'not_computed' ? (
              <p className="text-sm text-muted-foreground italic" role="status">
                Channel ROAS not computed yet — ad spend exists, but attribution credit has not been
                populated, so a per-channel return would be a guess, not a measurement.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground italic" role="status">
                No channel ROAS yet — attribution or ad spend has no rows in this window.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── Per-campaign attribution & ROAS (#32c — the granular per-campaign unit economics) ── */}
      <section aria-label="Per-campaign attribution and ROAS" data-testid="attribution-campaign-section">
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Megaphone className="h-4 w-4" aria-hidden="true" />
            Per-campaign attribution &amp; ROAS
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Attributed revenue, ad spend, and ROAS for each campaign under the selected model — the
            level marketers actually optimize. Money is per-currency (never blended); ROAS is honest
            n/a when there is no spend. Brand-wide roll-up (not scoped by the date range).
          </p>
        </div>
        <Card>
          <CardContent className="pt-6">
            {campaignQ.isLoading ? (
              <div className="space-y-2" aria-busy="true" aria-label="Loading per-campaign attribution">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-8 bg-muted animate-pulse rounded" />
                ))}
              </div>
            ) : campaignQ.error ? (
              <ErrorCard error={campaignQ.error} retry={campaignQ.refetch} />
            ) : campaignQ.data?.state === 'has_data' && campaignQ.data.rows.length > 0 ? (
              <CampaignAttributionTable data={campaignQ.data} />
            ) : (
              <p className="text-sm text-muted-foreground italic" role="status">
                No per-campaign attribution yet — campaign-level credit appears once journeys carry a
                campaign (utm_campaign) and the attribution credit ledger is populated for this model.
                We don&apos;t fabricate campaign rows.
              </p>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

/**
 * CampaignAttributionTable — per-campaign attributed revenue + spend + ROAS (#32c).
 * Money via formatMoneyDisplay (bigint minor + per-row currency_code, never blended); ROAS is the
 * engine's exact ratio string (roas_bps/10000) — n/a when spend = 0. Counts are exact integers.
 */
function CampaignAttributionTable({ data }: { data: CampaignAttrHasData }) {
  return (
    <Table className="w-full text-sm">
      <TableHeader>
        <TableRow>
          <TableHead>Campaign</TableHead>
          <TableHead>Platform</TableHead>
          <TableHead className="text-right">Attributed</TableHead>
          <TableHead className="text-right">Spend</TableHead>
          <TableHead className="text-right">Orders</TableHead>
          <TableHead className="text-right">ROAS</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.rows.map((r) => {
          const ccy = r.currency_code as CurrencyCode;
          const platformLabel = channelMeta(r.platform).label;
          return (
            <TableRow key={`${r.platform}␟${r.campaign_id}␟${r.currency_code}`}>
              <TableCell className="font-medium text-foreground">
                {r.campaign_name ?? r.campaign_id}
              </TableCell>
              <TableCell className="text-muted-foreground">{platformLabel}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoneyDisplay(r.attributed_revenue_minor, ccy)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoneyDisplay(r.spend_minor, ccy)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {Number(BigInt(r.attributed_order_count)).toLocaleString('en-IN')}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {r.roas_ratio != null ? (
                  <span className="text-foreground">{r.roas_ratio}×</span>
                ) : (
                  <span className="text-muted-foreground italic" title="No ad spend — ROAS is undefined">
                    n/a
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * NotMeasured — the honest-empty cell. The channel-roas feed (gold_campaign_performance) is
 * spend-only, so conversions / CPA / impressions / clicks have no measured value at the channel
 * grain. We render an em-dash (NEVER a fabricated 0) with an SR-only reason, per Brain's
 * honest-empty rule ("No empty charts / fabricated zeros as a success state").
 */
function NotMeasured() {
  return (
    <span className="text-muted-foreground" aria-label="Not measured — the per-channel feed is spend-only">
      <span aria-hidden="true">—</span>
    </span>
  );
}

/**
 * ChannelPerformanceTable — per-channel unit economics over the EXISTING channel-roas hook
 * (useChannelRoas → /v1/analytics/attribution/channel-roas, the metric-engine sole read path).
 *
 * Columns: Channel · Spend · Attributed revenue · ROAS · Conversions · CPA · Impressions · Clicks.
 * Spend / Attributed are bigint minor-unit strings → formatMoneyDisplay (per-row currency_code,
 * never /100, never blended). ROAS is the engine's EXACT decimal string — rendered directly, never
 * re-divided with floats; honest n/a when spend = 0. Conversions, CPA, impressions and clicks are
 * NOT in the channel-roas contract (gold_campaign_performance is spend-only) → honest em-dash.
 *
 * Page-local (not the shared ChannelRoasTable, which is fixed at 4 columns and reused by
 * /marketing). Reuses channelMeta for the icon+label (channel meaning is icon + text, never
 * colour-only) and the same paid→owned→referral→direct ordering.
 */
function ChannelPerformanceTable({ rows }: { rows: ChannelRoasRow[] }) {
  const ordered = [...rows].sort(
    (a, b) => channelMeta(a.channel).order - channelMeta(b.channel).order,
  );

  if (ordered.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground italic"
        role="status"
        data-testid="channel-performance-empty"
      >
        No channel performance yet — attribution or ad spend has no rows in this window.
      </p>
    );
  }

  return (
    <Table className="w-full text-sm" data-testid="channel-performance-table">
      <TableHeader>
        <TableRow>
          <TableHead>Channel</TableHead>
          <TableHead className="text-right">Spend</TableHead>
          <TableHead className="text-right">Attributed</TableHead>
          <TableHead className="text-right">ROAS</TableHead>
          <TableHead className="text-right">Conversions</TableHead>
          <TableHead className="text-right">CPA</TableHead>
          <TableHead className="text-right">Impressions</TableHead>
          <TableHead className="text-right">Clicks</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ordered.map((row) => {
          const meta = channelMeta(row.channel);
          const Icon = meta.icon;
          const ccy = row.currency_code as CurrencyCode;
          const ratioLabel =
            row.roas_ratio != null ? `${row.roas_ratio}x ROAS` : 'ROAS not available — no ad spend';
          return (
            <TableRow key={row.channel}>
              <TableCell className="font-medium text-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  {meta.label}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoneyDisplay(row.spend_minor, ccy)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoneyDisplay(row.attributed_minor, ccy)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium" aria-label={ratioLabel}>
                {row.roas_ratio != null ? (
                  <span className="inline-flex items-center justify-end gap-1">
                    <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    {row.roas_ratio}x
                  </span>
                ) : (
                  <span className="text-muted-foreground italic" title="No ad spend — ROAS is undefined">
                    n/a
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <NotMeasured />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <NotMeasured />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <NotMeasured />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <NotMeasured />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function AttributionData({
  byChannel,
  recon,
}: {
  byChannel: ByChannelHasData;
  recon: ReconHasData | null;
}) {
  const ccy = (byChannel.currency_code ?? 'INR') as CurrencyCode;
  const attributedValue = formatMoneyDisplay(byChannel.attributed_gmv_minor, ccy);
  const channelCount = byChannel.by_channel.length;

  // Distinct confidence grades present across credited channels, in strength order — shown
  // as visible icon+label badges. confidence_grade is optional in the by-channel response
  // (core does not emit a per-channel grade today) — filter out absent grades so the legend
  // is empty rather than broken.
  const GRADE_ORDER = { strong: 0, partial: 1, weak: 2 } as const;
  const grades = [
    ...new Set(
      byChannel.by_channel
        .map((c) => c.confidence_grade)
        .filter((g): g is AttributionConfidenceGrade => g != null),
    ),
  ].sort((a, b) => GRADE_ORDER[a] - GRADE_ORDER[b]);

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
              rows={byChannel.by_channel}
              currencyCode={byChannel.currency_code ?? 'INR'}
            />
          </CardContent>
        </Card>
      </div>

      {/* Right: the reconciliation residual — the closed-sum parity oracle made visible. */}
      <div className="lg:col-span-1">
        {recon ? (
          <ReconciliationResidualCard
            currencyCode={recon.currency_code ?? 'INR'}
            realizedMinor={recon.realized_gmv_minor}
            attributedMinor={recon.attributed_gmv_minor}
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
