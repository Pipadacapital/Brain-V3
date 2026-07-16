'use client';

/**
 * CampaignsContent — the per-campaign drill-down (P2, Marketing › Campaigns).
 *
 * The campaign-grain sibling of the Marketing › Attribution tab. Where Attribution answers
 * "which CHANNELS earn the revenue?", this page answers "which CAMPAIGNS work?" — the level
 * marketers actually optimize.
 *
 * It reads ONLY via the BFF endpoints (the metric-engine sole read path) — never the credit
 * ledger / the serving tier directly, never an inlined client-side SUM:
 *   - useCampaignAttribution  → /v1/analytics/attribution/campaign-attribution
 *       per-campaign attributed revenue + spend + ROAS under the selected model (brand-wide roll-up).
 *   - useCampaignTimeseries   → /v1/analytics/attribution/campaign-timeseries
 *       date-bucketed per-(campaign, channel) attributed revenue under the selected model + window.
 *
 * Sections:
 *   1. Controls — AttributionModelSelector (wired: drives every read) + DateRangeFilter (drives the
 *      timeseries window; the campaign-attribution roll-up is brand-wide, not range-scoped).
 *   2. Campaign table — the shared ChannelRoasTable rendered over the campaign rows (each campaign
 *      mapped to a ROAS row: attributed ÷ spend, honest n/a when spend = 0).
 *   3. Attributed revenue over time — the shared TrendChart over the campaign-timeseries roll-up
 *      (aggregate attributed revenue per bucket; provisional left at 0 — this is attributed, not the
 *      realized/provisional ledger).
 *   4. Compare mode — pick exactly 2 campaigns; their per-campaign attributed-revenue trend is shown
 *      side-by-side with the P1 Sparkline primitive + their KPIs.
 *   5. Creatives + demographic breakdown — honest EmptyState: there is no creative / demographic mart
 *      yet, so we render an explained empty (never a fabricated zero).
 *
 * Money: bigint minor-unit strings → formatMoneyDisplay (per-row currency_code, never /100, never a
 * float, never blended across currencies). ROAS is the engine's exact ratio string.
 *
 * Honest states: skeletons (aria-busy), ErrorCard with request_id, EmptyState — never a fabricated 0.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Megaphone,
  ArrowLeft,
  BarChart3,
  GitCompare,
  ImageIcon,
  Users,
  Layers,
} from 'lucide-react';
import { TabShell } from '@/components/ui/tab-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { AttributionModelSelector } from '@/components/analytics/attribution-model-selector';
import { ChannelRoasTable } from '@/components/analytics/channel-roas-table';
import { TrendChart } from '@/components/analytics/trend-chart';
import { Sparkline } from '@/components/analytics/sparkline';
import {
  DateRangeFilter,
  initialRange,
  type DateRange,
  type RangePreset,
} from '@/components/ui/date-range-filter';
import { DataWindowBadge } from '@/components/ui/data-window-badge';
import { TableSearch, filterRows } from '@/components/ui/table-search';
import { VerifyLink } from '@/components/ui/verify-link';
import { useCampaignAttribution, useCampaignTimeseries } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { plainLabel } from '@/lib/format/plain-language';
import type { CurrencyCode } from '@brain/money';
import type {
  AttributionModel,
  AnalyticsCampaignAttributionResponse,
  CampaignAttributionRow,
  AnalyticsCampaignTimeseriesResponse,
  AnalyticsTimeseriesResponse,
  ChannelRoasRow,
} from '@/lib/api/types';

type CampaignAttrHasData = Extract<AnalyticsCampaignAttributionResponse, { state: 'has_data' }>;

/** Longer windows — attribution journeys span weeks, not days. */
const CAMPAIGN_PRESETS: readonly RangePreset[] = [
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '180', label: 'Last 180 days', days: 180 },
];

/** Stable per-campaign key (a campaign id can repeat across platforms / currencies). */
function campaignKey(r: CampaignAttributionRow): string {
  return `${r.platform}␟${r.campaign_id}␟${r.currency_code}`;
}

/** Human-readable campaign name — never a raw ad-platform id on the DOM (plain-language rule). */
function campaignLabel(r: CampaignAttributionRow): string {
  return r.campaign_name ?? 'Unnamed campaign';
}

/**
 * Adapt the per-campaign attribution rows to the shared ChannelRoasTable's ChannelRoasRow shape —
 * each campaign becomes one "channel" row (label = campaign name, attributed ÷ spend = ROAS). The
 * component's honest n/a (spend = 0) and per-currency money handling carry over unchanged. Sorted
 * by attributed revenue descending so the biggest earners lead.
 */
function toRoasRows(rows: CampaignAttributionRow[]): ChannelRoasRow[] {
  return [...rows]
    .sort((a, b) => {
      const av = BigInt(a.attributed_revenue_minor);
      const bv = BigInt(b.attributed_revenue_minor);
      return av < bv ? 1 : av > bv ? -1 : 0;
    })
    .map((r) => ({
      channel: campaignLabel(r),
      attributed_minor: r.attributed_revenue_minor,
      spend_minor: r.spend_minor,
      roas_ratio: r.roas_ratio,
      currency_code: r.currency_code,
    }));
}

/**
 * Roll the campaign-timeseries (one row per bucket·campaign·channel·currency) up into the shared
 * TrendChart's realized/provisional shape: aggregate attributed revenue per bucket for the single
 * primary currency (never blend currencies). `provisional` is left at 0 — this series is ATTRIBUTED
 * revenue, not the realized/provisional ledger; the card title frames it honestly.
 *
 * When `campaignId` is given, only that campaign's buckets are summed (used to derive a per-campaign
 * series for the compare sparklines).
 */
function rollupToTrend(
  ts: AnalyticsCampaignTimeseriesResponse | undefined,
  campaignId?: string,
): AnalyticsTimeseriesResponse | undefined {
  if (!ts) return undefined;
  if (ts.state === 'no_data') {
    return { state: 'no_data', from: ts.from, to: ts.to, grain: ts.grain };
  }
  const rows = campaignId ? ts.buckets.filter((b) => b.campaign_id === campaignId) : ts.buckets;
  if (rows.length === 0) {
    return { state: 'no_data', from: ts.from, to: ts.to, grain: ts.grain };
  }
  // Primary currency = the one with the most buckets (we never blend currencies in one chart).
  const ccyCount = new Map<string, number>();
  for (const b of rows) ccyCount.set(b.currency_code, (ccyCount.get(b.currency_code) ?? 0) + 1);
  const primary = [...ccyCount.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  const perBucket = new Map<string, bigint>();
  for (const b of rows) {
    if (b.currency_code !== primary) continue;
    perBucket.set(
      b.bucket,
      (perBucket.get(b.bucket) ?? 0n) + BigInt(b.attributed_revenue_minor),
    );
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

/** Per-campaign daily attributed-revenue magnitudes (major units) for a Sparkline — shape only. */
function campaignSparkSeries(
  ts: AnalyticsCampaignTimeseriesResponse | undefined,
  campaignId: string,
): number[] {
  const trend = rollupToTrend(ts, campaignId);
  if (!trend || trend.state !== 'has_data') return [];
  return trend.buckets.map((b) => Number(BigInt(b.realized_minor) / 100n));
}

export function CampaignsContent() {
  const [model, setModel] = useState<AttributionModel>('position_based');
  const [range, setRange] = useState<DateRange>(() => initialRange(CAMPAIGN_PRESETS, '90'));
  // Compare mode — up to 2 campaign ids selected.
  const [compare, setCompare] = useState<string[]>([]);
  // Free-text filter over the campaign table (narrows already-loaded rows; never re-fetches).
  const [query, setQuery] = useState('');

  const campaignQ = useCampaignAttribution({ model });
  const timeseriesQ = useCampaignTimeseries({
    model,
    date_start: range.from,
    date_end: range.to,
  });

  const campaignData = campaignQ.data;
  // Memoized so the array identity is stable across renders (downstream useMemo deps).
  const rows: CampaignAttributionRow[] = useMemo(
    () => (campaignData?.state === 'has_data' ? campaignData.rows : []),
    [campaignData],
  );

  // Search filters the visible campaign rows across the human-meaningful columns (name · platform).
  const visibleRows = useMemo(
    () => filterRows(rows, query, (r) => `${campaignLabel(r)} ${plainLabel(r.platform)}`),
    [rows, query],
  );
  const roasRows = useMemo(() => toRoasRows(visibleRows), [visibleRows]);
  const trend = useMemo(() => rollupToTrend(timeseriesQ.data), [timeseriesQ.data]);

  /** Toggle a campaign into/out of the (max-2) compare set. */
  function toggleCompare(id: string) {
    setCompare((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1]!, id]; // keep most-recent two (FIFO)
      return [...prev, id];
    });
  }

  return (
    <TabShell
      title="Campaigns"
      description="Which campaigns actually work? Attributed revenue, spend and ROAS per campaign under the model you choose."
      eyebrow={
        <Link
          href="/marketing"
          className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Marketing
        </Link>
      }
      explainer={{
        title: 'Campaigns — Which campaigns work?',
        description:
          'Per-campaign attributed revenue, spend and ROAS under the selected attribution model, the attributed-revenue trend over time, and a 2-campaign compare.',
        sections: [
          {
            heading: 'How credit is assigned',
            body:
              'Each campaign is credited from your customers’ actual journeys under the model you pick (first / last / linear / position / time-decay / data-driven). The campaign roll-up covers all time; the over-time chart honors the date range.',
          },
          {
            heading: 'ROAS',
            body:
              'ROAS = attributed revenue ÷ ad spend, within the same currency only. It shows a dash when a campaign has no spend — we never make up an infinite or zero return.',
          },
          {
            heading: 'Compare',
            body:
              'Pick any two campaigns to see their attributed-revenue trend and headline numbers side-by-side.',
          },
          {
            heading: 'Not measured yet',
            body:
              'Creative-level and demographic breakdowns are not built yet, so they show an honest empty — not a made-up zero.',
          },
        ],
        metrics: [
          {
            name: 'Attributed revenue (per campaign)',
            definition: 'Revenue credited to each campaign under the selected model.',
            howComputed:
              'Calculated from the customer journeys that carried this campaign’s tag — the same journeys always give the same answer.',
          },
          {
            name: 'Campaign ROAS',
            definition: 'Return on ad spend per campaign.',
            howComputed:
              'Attributed revenue ÷ ad spend, within the same currency only; shows a dash when spend is zero.',
          },
        ],
        refreshCadence: 'Campaign attribution and spend refresh on the regular analytics cycle.',
        sources: ['Your customer journeys and orders', 'Meta and Google ad accounts'],
      }}
    >
      {/* ── 1. Controls: model selector (wired) + date range ── */}
      <section aria-label="Campaign controls" data-testid="campaigns-controls">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <AttributionModelSelector model={model} onChange={setModel} />
          <DateRangeFilter
            value={range}
            onChange={setRange}
            presets={CAMPAIGN_PRESETS}
            disableCustom
            aria-label="Campaign trend date range"
          />
        </div>
      </section>

      {/* ── 2. Campaign performance table (shared ChannelRoasTable over campaign rows) ── */}
      <section aria-label="Campaign performance" data-testid="campaigns-table-section">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Megaphone className="size-4" aria-hidden="true" />
                Campaign performance
              </CardTitle>
              {rows.length > 0 && (
                <div className="flex flex-wrap items-center gap-3">
                  {/* The per-campaign roll-up covers all time (only the trend below honors the date range). */}
                  <DataWindowBadge from={null} to={null} count={rows.length} label="campaigns" />
                  <TableSearch
                    value={query}
                    onChange={setQuery}
                    placeholder="Search campaigns…"
                    aria-label="Search campaigns by name or ad platform"
                    className="sm:w-56"
                  />
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {campaignQ.isLoading ? (
              <div className="space-y-2" aria-busy="true" aria-label="Loading campaigns…">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : campaignQ.error ? (
              <ErrorCard error={campaignQ.error} retry={campaignQ.refetch} />
            ) : rows.length === 0 ? (
              <EmptyState
                compact
                icon={<Megaphone />}
                title="No per-campaign attribution yet"
                description="Campaign rows appear once two things line up: (1) your ad links carry campaign tags (utm_campaign) so Brain can name the campaign, and (2) revenue has been attributed to those journeys under this model. We don't invent campaign rows — this stays empty until real credit exists."
                action={
                  <Link href="/analytics/attribution">
                    <Button variant="outline" size="sm">
                      See attribution status
                    </Button>
                  </Link>
                }
              />
            ) : roasRows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground" role="status">
                No campaigns match “{query.trim()}”.{' '}
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  Clear search
                </button>
              </p>
            ) : (
              <>
                <ChannelRoasTable rows={roasRows} className="w-full text-sm" />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <p className="text-xs text-muted-foreground">
                    Every figure traces back to the customer journeys that touched each campaign.
                  </p>
                  <VerifyLink
                    href="/analytics/attribution"
                    label="See the journeys behind these numbers"
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── 3. Attributed revenue over time (shared TrendChart over the timeseries roll-up) ── */}
      <section aria-label="Attributed revenue over time" data-testid="campaigns-trend-section">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <BarChart3 className="size-4" aria-hidden="true" />
                Attributed revenue over time
              </CardTitle>
              {/* This chart honors the date range above (unlike the all-time campaign roll-up). */}
              <DataWindowBadge from={range.from} to={range.to} />
            </div>
          </CardHeader>
          <CardContent>
            {timeseriesQ.error ? (
              <ErrorCard error={timeseriesQ.error} retry={timeseriesQ.refetch} />
            ) : (
              <TrendChart
                data={trend}
                isLoading={timeseriesQ.isLoading}
                grain={(trend?.state === 'has_data' ? trend.grain : 'day') as 'day' | 'week'}
              />
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Aggregate attributed revenue across all campaigns under the selected model, summed per
              day for the primary currency (currencies are never blended).
            </p>
          </CardContent>
        </Card>
      </section>

      {/* ── 4. Compare mode — pick 2 campaigns ── */}
      <section aria-label="Compare campaigns" data-testid="campaigns-compare-section">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <GitCompare className="size-4" aria-hidden="true" />
              Compare campaigns
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground italic" role="status">
                Compare appears once at least two campaigns have attributed revenue.
              </p>
            ) : (
              <>
                {/* Picker — toggle up to two campaigns (aria-pressed reflects selection). */}
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Pick up to two campaigns to compare"
                >
                  {rows.map((r) => {
                    const id = r.campaign_id;
                    const selected = compare.includes(id);
                    const atCap = compare.length >= 2 && !selected;
                    return (
                      <Button
                        key={campaignKey(r)}
                        type="button"
                        variant={selected ? 'default' : 'outline'}
                        size="sm"
                        aria-pressed={selected}
                        onClick={() => toggleCompare(id)}
                        title={atCap ? 'Two campaigns already selected — picking another replaces the oldest' : undefined}
                      >
                        {campaignLabel(r)}
                      </Button>
                    );
                  })}
                </div>

                {compare.length < 2 ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    Select {2 - compare.length} more campaign{2 - compare.length === 1 ? '' : 's'} to
                    compare their attributed-revenue trend side-by-side.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {compare.map((id) => {
                      const row = rows.find((r) => r.campaign_id === id);
                      if (!row) return null;
                      const ccy = row.currency_code as CurrencyCode;
                      const series = campaignSparkSeries(timeseriesQ.data, id);
                      return (
                        <div
                          key={id}
                          className="rounded-lg border border-border p-4 space-y-3"
                          data-testid={`campaign-compare-${id}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-medium text-foreground">
                                {campaignLabel(row)}
                              </p>
                              <p className="text-xs text-muted-foreground">{plainLabel(row.platform)}</p>
                            </div>
                            <Sparkline
                              data={series}
                              width={96}
                              height={28}
                              ariaLabel={`${campaignLabel(row)} attributed revenue trend`}
                              className="text-primary shrink-0"
                            />
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <KpiTile
                              label="Attributed"
                              help="Revenue credited to this campaign under the selected model."
                              value={formatMoneyDisplay(row.attributed_revenue_minor, ccy)}
                            />
                            <KpiTile
                              label="Spend"
                              help="What you spent on this campaign."
                              value={formatMoneyDisplay(row.spend_minor, ccy)}
                            />
                            <KpiTile
                              label="ROAS"
                              help="Return on ad spend — attributed revenue divided by what this campaign cost."
                              value={row.roas_ratio != null ? `${row.roas_ratio}×` : null}
                              sublabel={row.roas_ratio == null ? 'no spend recorded' : undefined}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ── 5. Creatives + demographic breakdown — honest empty (no mart yet) ── */}
      <section
        aria-label="Creative and demographic breakdown"
        data-testid="campaigns-breakdown-section"
        className="grid grid-cols-1 gap-4 lg:grid-cols-2"
      >
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ImageIcon className="size-4" aria-hidden="true" />
              Creative breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              compact
              icon={<ImageIcon />}
              title="No creative-level data yet"
              description="Per-creative attributed revenue and ROAS aren't built yet. Once your ad connectors share creative-level spend and revenue is credited to it, this fills in — until then we show nothing rather than a made-up zero."
              hint={
                <span className="inline-flex items-center gap-1.5">
                  <Layers className="size-3" aria-hidden="true" />
                  Coming in a future update
                </span>
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="size-4" aria-hidden="true" />
              Demographic breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              compact
              icon={<Users />}
              title="No demographic data yet"
              description="Age / gender / location breakdowns aren't built yet. We never guess or invent demographics — this stays empty until a real source lands."
              hint={
                <span className="inline-flex items-center gap-1.5">
                  <Layers className="size-3" aria-hidden="true" />
                  Coming in a future update
                </span>
              }
            />
          </CardContent>
        </Card>
      </section>
    </TabShell>
  );
}
