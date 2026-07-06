'use client';

/**
 * UtmContent — the UTM / acquisition-SOURCE matrix (P3) + click-to-drilldown.
 *
 * Top: the source × medium matrix from gold_utm_source (useUtmSource) — one row per first-touch
 * (source, medium) with visitors / conversions / attributed revenue / avg LTV / repeat-purchase rate.
 * Click any row to open the DRILLDOWN: the identity browse list filtered to the customers acquired
 * from that source (useCustomers({ acquisitionSource })) — reusing the exact customer-row shape from
 * the Customers tab, each linking to the full Customer Profile (360).
 *
 * BFF-only (I-ST01): money is bigint MINOR units + sibling currency_code (never blended, never a
 * float — formatMoneyDisplay). Counts (visitors / conversions) are bigint strings → rendered via a
 * BigInt-safe count formatter. repeat_rate_pct is a 0-100 integer.
 *
 * Honest-empty (Brain rule): the matrix renders EmptyState when the brand has no acquisition rows;
 * each money/segment cell shows "—" when the row has no signal — never a fabricated dimension. The
 * drilldown shows its own EmptyState when a source has no resolved customers yet.
 *
 * A11y: the matrix is a real <table> with scope=col headers; each row is a <button>-semantics row
 * (role + keyboard) so the drilldown is reachable without a mouse; the selected source is announced
 * via aria-pressed and the drilldown region is aria-live. Meaning is carried by text, never colour.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  Megaphone,
  Compass,
  Users,
  ShieldCheck,
  ShieldOff,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
  CircleSlash,
  X,
  Trophy,
  Gem,
  Repeat,
  Tag,
  TrendingUp,
  Lightbulb,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/ui/section-card';
import { TabShell } from '@/components/ui/tab-shell';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { humanize } from '@/lib/format/humanize';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { useUtmSource } from '@/lib/hooks/use-analytics';
import { useCustomers } from '@/lib/hooks/use-identity';
import type { UtmSourceRow, CustomerListItem } from '@/lib/api/types';
import type { CurrencyCode } from '@brain/money';

const PAGE_SIZE = 25;

/** Human label for a segment value returned on a customer row (mirrors the Customers tab). */
const SEGMENT_LABEL: Record<string, string> = {
  VIP: 'VIP',
  loyal: 'Loyal',
  at_risk: 'At-Risk',
  churned: 'Churned',
  first_time_buyer: 'One-time',
  window_shopper: 'Window-shopper',
  high_value: 'High-value',
  cart_abandoner: 'Cart-abandoner',
};

/** BigInt-safe count formatter — visitors / conversions arrive as bigint-minor strings. */
function formatCount(value: string): string {
  try {
    return BigInt(value).toLocaleString();
  } catch {
    return value;
  }
}

/** Money cell: honest "—" when there's no currency signal (never a blended/float fallback). */
function money(minor: string, ccy: string | null): React.ReactNode {
  if (!ccy) {
    return (
      <span className="text-muted-foreground" title="No revenue recorded yet">
        —
      </span>
    );
  }
  return formatMoneyDisplay(minor, ccy as CurrencyCode);
}

function ConsentDot({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <ShieldCheck className="h-4 w-4 text-success" aria-label={`${label}: granted`} />
  ) : (
    <ShieldOff className="h-4 w-4 text-muted-foreground" aria-label={`${label}: not granted`} />
  );
}

// ── Insights layer — derived ENTIRELY from the loaded matrix rows (no extra fetch). ──────────────
// The raw source×medium table answers "what are my numbers"; this turns it into "what does it mean":
// which source converts best, which brings the most (but lowest-intent) traffic, whose customers are
// worth most / come back most, and how much traffic is untagged. All aggregated to the SOURCE grain
// (people think in sources, not source×medium pairs) and phrased for a non-technical reader.

function num(s: string | number | null | undefined): number {
  const n = Number(s ?? 0);
  return Number.isFinite(n) ? n : 0;
}
const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);
const fmtPct = (v: number): string => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

interface SourceAgg {
  source: string;
  visitors: number;
  conversions: number;
  revenueMinor: number;
  currency: string | null;
  repeatWeighted: number; // Σ repeat_rate_pct × conversions  → conversions-weighted repeat rate
}

interface UtmInsight {
  key: string;
  icon: React.ElementType;
  tone: 'positive' | 'warning' | 'neutral';
  title: string;
  body: React.ReactNode;
}

function aggregateBySource(rows: UtmSourceRow[]): SourceAgg[] {
  const by = new Map<string, SourceAgg>();
  for (const r of rows) {
    const a =
      by.get(r.source) ??
      { source: r.source, visitors: 0, conversions: 0, revenueMinor: 0, currency: null, repeatWeighted: 0 };
    a.visitors += num(r.visitors);
    a.conversions += num(r.conversions);
    a.revenueMinor += num(r.revenue_minor);
    if (r.currency_code) a.currency = r.currency_code;
    a.repeatWeighted += num(r.repeat_rate_pct) * num(r.conversions);
    by.set(r.source, a);
  }
  return [...by.values()];
}

/** Is a source label a real tagged channel, or untagged/direct traffic? */
function isUntagged(source: string): boolean {
  const s = source.toLowerCase();
  return s === 'unknown' || s === 'direct' || s === '' || s === '(none)' || s === 'none';
}

function computeUtmInsights(rows: UtmSourceRow[]): {
  totalVisitors: number;
  totalConversions: number;
  overallCvr: number;
  sourceCount: number;
  topByConversion: SourceAgg[];
  insights: UtmInsight[];
} {
  const sources = aggregateBySource(rows);
  const totalVisitors = sources.reduce((s, a) => s + a.visitors, 0);
  const totalConversions = sources.reduce((s, a) => s + a.conversions, 0);
  const overallCvr = pct(totalConversions, totalVisitors);
  const currency = sources.find((a) => a.currency)?.currency ?? null;

  const tagged = sources.filter((a) => !isUntagged(a.source) && a.visitors > 0);
  const cvrOf = (a: SourceAgg) => pct(a.conversions, a.visitors);
  const avgSpendOf = (a: SourceAgg) => (a.conversions > 0 ? a.revenueMinor / a.conversions : 0);
  const repeatOf = (a: SourceAgg) => (a.conversions > 0 ? a.repeatWeighted / a.conversions : 0);

  // Min-sample floor so a 1-visitor / 1-conversion source can't claim "best" from noise.
  const visitorFloor = Math.max(5, Math.round(totalVisitors * 0.02));

  const insights: UtmInsight[] = [];

  // 1. Best converting tagged source.
  const converters = tagged.filter((a) => a.conversions > 0 && a.visitors >= visitorFloor);
  const best = converters.slice().sort((a, b) => cvrOf(b) - cvrOf(a))[0];
  if (best) {
    const cvr = cvrOf(best);
    insights.push({
      key: 'best-cvr',
      icon: Trophy,
      tone: 'positive',
      title: 'Best at winning customers',
      body: (
        <>
          <strong>{humanize(best.source)}</strong> converts best — {fmtPct(cvr)}% of its visitors become
          customers{overallCvr > 0 && cvr > overallCvr ? `, ${(cvr / overallCvr).toFixed(1)}× your ${fmtPct(overallCvr)}% average` : ''}. Lean into it.
        </>
      ),
    });
  }

  // 2. Biggest traffic source (+ intent flag if it converts below average).
  const biggest = tagged.slice().sort((a, b) => b.visitors - a.visitors)[0];
  if (biggest && biggest.visitors > 0) {
    const cvr = cvrOf(biggest);
    const share = pct(biggest.visitors, totalVisitors);
    const underperforms = overallCvr > 0 && cvr < overallCvr * 0.75 && biggest.conversions >= 0;
    insights.push({
      key: 'biggest',
      icon: TrendingUp,
      tone: underperforms ? 'warning' : 'neutral',
      title: underperforms ? 'Lots of traffic, few buyers' : 'Your biggest source',
      body: underperforms ? (
        <>
          <strong>{humanize(biggest.source)}</strong> sends the most visitors ({formatCount(String(biggest.visitors))},{' '}
          {fmtPct(share)}% of traffic) but only {fmtPct(cvr)}% buy — below your {fmtPct(overallCvr)}% average. This
          traffic looks low-intent; check the targeting or landing page.
        </>
      ) : (
        <>
          <strong>{humanize(biggest.source)}</strong> is your biggest source — {formatCount(String(biggest.visitors))}{' '}
          visitors ({fmtPct(share)}% of all traffic), converting at {fmtPct(cvr)}%.
        </>
      ),
    });
  }

  // 3. Most valuable customers (avg spend per acquired customer).
  const valued = converters
    .filter((a) => a.revenueMinor > 0 && a.currency)
    .slice()
    .sort((a, b) => avgSpendOf(b) - avgSpendOf(a))[0];
  if (valued) {
    insights.push({
      key: 'valuable',
      icon: Gem,
      tone: 'positive',
      title: 'Most valuable customers',
      body: (
        <>
          Customers from <strong>{humanize(valued.source)}</strong> spend the most —{' '}
          {formatMoneyDisplay(String(Math.round(avgSpendOf(valued))), valued.currency as CurrencyCode)} each on average.
          Worth paying more to acquire.
        </>
      ),
    });
  }

  // 4. Most loyal (highest conversions-weighted repeat rate).
  const loyal = converters
    .filter((a) => repeatOf(a) > 0)
    .slice()
    .sort((a, b) => repeatOf(b) - repeatOf(a))[0];
  if (loyal) {
    insights.push({
      key: 'loyal',
      icon: Repeat,
      tone: 'positive',
      title: 'Brings customers who come back',
      body: (
        <>
          <strong>{humanize(loyal.source)}</strong> brings the most loyal customers — {fmtPct(repeatOf(loyal))}% buy
          again. Repeat buyers cost nothing to re-acquire.
        </>
      ),
    });
  }

  // 5. Untagged traffic — actionable nudge (only if it's a meaningful share).
  const untaggedVisitors = sources.filter((a) => isUntagged(a.source)).reduce((s, a) => s + a.visitors, 0);
  const untaggedShare = pct(untaggedVisitors, totalVisitors);
  if (untaggedShare >= 15) {
    insights.push({
      key: 'untagged',
      icon: Tag,
      tone: 'warning',
      title: 'Untagged traffic is hiding what works',
      body: (
        <>
          {fmtPct(untaggedShare)}% of your visitors arrive with no source tag (shown as “unknown”). Add UTM tags
          (<code className="text-xs">utm_source</code> / <code className="text-xs">utm_medium</code>) to your ad,
          email and social links so Brain can tell you which campaigns actually drive sales.
        </>
      ),
    });
  }
  void currency; // referenced for future currency-aware copy; keep single-currency assumption explicit

  return {
    totalVisitors,
    totalConversions,
    overallCvr,
    sourceCount: sources.length,
    topByConversion: tagged.slice().sort((a, b) => cvrOf(b) - cvrOf(a)).slice(0, 5),
    insights: insights.slice(0, 4),
  };
}

const TONE_STYLES: Record<UtmInsight['tone'], string> = {
  positive: 'border-success/30 bg-success/5 text-success',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  neutral: 'border-border bg-muted/30 text-muted-foreground',
};

function UtmInsights({ rows }: { rows: UtmSourceRow[] }) {
  const { totalVisitors, totalConversions, overallCvr, sourceCount, topByConversion, insights } =
    React.useMemo(() => computeUtmInsights(rows), [rows]);

  if (totalVisitors === 0) return null;

  const cvrOf = (a: SourceAgg) => pct(a.conversions, a.visitors);
  const maxCvr = topByConversion.length ? cvrOf(topByConversion[0]!) : 0;

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          <Lightbulb className="size-4 text-primary" aria-hidden="true" />
          What your acquisition data is telling you
        </span>
      }
      description="Automatic read of the matrix below — best sources, where to focus, and what to fix."
    >
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Visitors tracked', value: formatCount(String(totalVisitors)) },
          { label: 'Customers acquired', value: formatCount(String(totalConversions)) },
          { label: 'Overall conversion', value: `${fmtPct(overallCvr)}%` },
          { label: 'Sources', value: String(sourceCount) },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border border-border bg-background p-3">
            <div className="text-xl font-semibold tabular-nums text-foreground">{k.value}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Insight cards */}
      {insights.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {insights.map((ins) => (
            <div key={ins.key} className={`flex gap-3 rounded-lg border p-3 ${TONE_STYLES[ins.tone]}`}>
              <ins.icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{ins.title}</div>
                <p className="mt-0.5 text-sm text-muted-foreground">{ins.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Top sources by conversion — compact ranked bars */}
      {topByConversion.length > 1 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Top sources by conversion rate
          </div>
          <ul className="space-y-1.5" role="list">
            {topByConversion.map((a) => {
              const cvr = cvrOf(a);
              return (
                <li key={a.source} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-sm text-foreground" title={humanize(a.source)}>
                    {humanize(a.source)}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${maxCvr > 0 ? Math.max(4, (cvr / maxCvr) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {fmtPct(cvr)}% · {formatCount(String(a.conversions))} won
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

export function UtmContent() {
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useUtmSource();

  // The selected first-touch SOURCE for the drilldown (medium is not a customer-360 filter — the
  // acquisition_source drilldown is source-grained per the list-customers contract).
  const [selectedSource, setSelectedSource] = React.useState<string | null>(null);

  const rows: UtmSourceRow[] =
    data?.state === 'has_data' ? data.rows : [];

  // Prefer the mart's generated_at (a common field on both union variants); otherwise the
  // react-query fetch time is an honest "read at".
  const freshnessIso =
    data?.generated_at ?? (dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null);

  return (
    <TabShell
      title="UTM Sources"
      description="Where do my customers come from?"
      eyebrow={
        <span className="inline-flex items-center gap-1.5">
          <Megaphone className="size-3.5" aria-hidden="true" />
          Marketing
        </span>
      }
      freshness={<FreshnessBadge timestamp={freshnessIso} prefix="Updated" />}
      explainer={{
        title: 'UTM Sources — Where do my customers come from?',
        description:
          'The first-touch acquisition matrix: every (utm_source, utm_medium) pair with the visitors it brought, how many converted, the revenue and average lifetime value of those customers, and how many came back. Click a row to see the actual customers acquired from that source.',
        sections: [
          {
            heading: 'First-touch attribution',
            body: 'Each customer is counted against the source/medium of their FIRST touch — the channel that introduced them to the brand. This answers acquisition (who brought them in), not last-click conversion credit (see the Attribution sub-tab for model-switchable credit).',
          },
          {
            heading: 'Drilldown',
            body: 'Click any source row to open the customers acquired from it — the same identity browse list filtered by acquisition_source, each linking to the full Customer Profile (360). A source with no resolved customers yet shows an honest empty state, never fabricated rows.',
          },
          {
            heading: 'Honest dimensions',
            body: 'A source/medium with no UTM signal reads "unknown" (e.g. direct/typed-in traffic). Money cells show "—" when a row has no revenue signal. We never invent a channel.',
          },
        ],
        metrics: [
          {
            name: 'Visitors',
            definition: 'Distinct visitors whose first touch came from this source/medium.',
            howComputed: 'Counted from the first recorded visit of each person, per source and medium.',
          },
          {
            name: 'Conversions',
            definition: 'Distinct customers acquired via this source/medium who went on to buy.',
            howComputed: 'Counted from customers whose first touch was this source and who later placed an order.',
          },
          {
            name: 'Revenue / Avg LTV',
            definition: 'Revenue from customers acquired here, and their average lifetime value.',
            howComputed: 'Added up from those customers’ orders, always within one currency — never blended.',
          },
          {
            name: 'Repeat-purchase rate',
            definition: 'Share of customers acquired via this source who placed more than one order.',
            howComputed: 'Repeat customers ÷ converting customers (0–100%).',
          },
        ],
        refreshCadence: 'The source matrix refreshes on the regular analytics cycle; the drilldown customer list is read live.',
        sources: ['First-touch visits recorded by the Brain Pixel', 'Customer 360 profiles'],
      }}
    >
      {rows.length > 0 ? <UtmInsights rows={rows} /> : null}

      <SectionCard
        title="Source × medium matrix"
        description="One row per first-touch (source, medium). Click a row to drill into the customers it acquired."
        flush
      >
        <div aria-live="polite" aria-busy={isLoading || isFetching}>
          {isLoading ? (
            <div className="space-y-2 p-5" aria-hidden="true">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : error ? (
            <div className="p-5">
              <ErrorCard error={error} retry={refetch} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Compass className="h-6 w-6" aria-hidden="true" />}
              title="No acquisition sources yet"
              description="As first-touch UTM data lands from your pixel and connected ad platforms, each source and medium that brought you customers appears here — with its visitors, conversions, revenue and repeat rate."
            />
          ) : (
            <table className="w-full text-sm" data-testid="utm-source-matrix">
              <caption className="sr-only">
                First-touch acquisition matrix: one row per (utm source, utm medium) with visitors,
                conversions, attributed revenue, average lifetime value and repeat-purchase rate.
                Select a row to list the customers acquired from that source.
              </caption>
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="px-4 py-2.5 font-medium">Source</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Medium</th>
                  <th scope="col" className="px-4 py-2.5 font-medium text-right">Visitors</th>
                  <th scope="col" className="px-4 py-2.5 font-medium text-right">Conversions</th>
                  <th scope="col" className="px-4 py-2.5 font-medium text-right">Revenue</th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 font-medium text-right"
                    title="Average lifetime value — what a customer from this source spends with you in total, on average."
                  >
                    Avg LTV
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-2.5 font-medium text-right"
                    title="The share of customers from this source who came back to buy again."
                  >
                    Repeat rate
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-medium sr-only">Drill in</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const active = selectedSource === row.source;
                  return (
                    <tr
                      key={`${row.source}__${row.medium}__${i}`}
                      className={`cursor-pointer border-b last:border-0 hover:bg-muted/40 ${
                        active ? 'bg-muted/60' : ''
                      }`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={active}
                      aria-label={`Show customers acquired from ${humanize(row.source)} (${humanize(row.medium)})`}
                      onClick={() =>
                        setSelectedSource((cur) => (cur === row.source ? null : row.source))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedSource((cur) => (cur === row.source ? null : row.source));
                        }
                      }}
                    >
                      <td className="px-4 py-2.5 font-medium">{humanize(row.source)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{humanize(row.medium)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatCount(row.visitors)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatCount(row.conversions)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{money(row.revenue_minor, row.currency_code)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{money(row.avg_ltv_minor, row.currency_code)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{row.repeat_rate_pct}%</td>
                      <td className="px-4 py-2.5 text-right">
                        <span
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                          aria-hidden="true"
                        >
                          {active ? 'Selected' : 'Customers'} <ArrowRight className="h-3 w-3" />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </SectionCard>

      {/* Drilldown — customers acquired from the selected source. */}
      {selectedSource ? (
        <SourceDrilldown
          source={selectedSource}
          onClose={() => setSelectedSource(null)}
        />
      ) : (
        rows.length > 0 && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Compass className="h-3.5 w-3.5" aria-hidden="true" />
            Select a source above to see the customers it acquired.
          </p>
        )
      )}
    </TabShell>
  );
}

/**
 * SourceDrilldown — the customers acquired from one first-touch source (acquisition_source filter).
 * Reuses the identity browse list (useCustomers) and the customer-row shape from the Customers tab,
 * paginated and linking each row to /customers/{brain_id}. Honest-empty when a source has resolved
 * no customers yet.
 */
function SourceDrilldown({ source, onClose }: { source: string; onClose: () => void }) {
  const [offset, setOffset] = React.useState(0);

  // Reset to the first page whenever the selected source changes.
  React.useEffect(() => {
    setOffset(0);
  }, [source]);

  const { data, isLoading, isFetching, error, refetch } = useCustomers({
    acquisitionSource: source,
    limit: PAGE_SIZE,
    offset,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Customers from {humanize(source)}
        </span>
      }
      description="Resolved customers whose first touch was this source. Click a row to open the full profile."
      actions={
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <X className="mr-1 h-4 w-4" aria-hidden="true" /> Close
        </Button>
      }
      flush
    >
      <div aria-live="polite" aria-busy={isLoading || isFetching}>
        {isLoading ? (
          <div className="space-y-2 p-5" aria-hidden="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="p-5">
            <ErrorCard error={error} retry={refetch} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<CircleSlash className="h-6 w-6" aria-hidden="true" />}
            title="No resolved customers from this source yet"
            description={`The matrix counts first-touch ${humanize(source)} visitors, but identity resolution hasn't tied a resolved customer to this source yet. As resolution runs on incoming orders and events, customers acquired from ${humanize(source)} appear here.`}
          />
        ) : (
          <Card className="border-0 shadow-none">
            <CardContent className="p-0">
              <table className="w-full text-sm" data-testid="utm-source-customers">
                <caption className="sr-only">
                  Customers acquired from the {humanize(source)} first-touch source — brain id,
                  business segment, lifetime value, orders, lifecycle and consent.
                </caption>
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="px-4 py-2.5 font-medium">Brain ID</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Segment</th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-right">Lifetime value</th>
                    <th scope="col" className="px-4 py-2.5 font-medium text-right">Orders</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Lifecycle</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Consent</th>
                    <th scope="col" className="px-4 py-2.5 font-medium sr-only">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c: CustomerListItem) => (
                    <tr key={c.brain_id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/customers/${encodeURIComponent(c.brain_id)}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {c.brain_id}
                        </Link>
                        {c.merged_into ? (
                          <span className="ml-2 text-[10px] text-warning">→ merged</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        {c.segment ? (
                          <StatusBadge tone="neutral" hideDot>
                            {SEGMENT_LABEL[c.segment] ?? humanize(c.segment)}
                          </StatusBadge>
                        ) : (
                          <span className="text-muted-foreground" title="No segment assigned yet">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {c.ltv_minor != null && c.currency_code ? (
                          formatMoneyDisplay(c.ltv_minor, c.currency_code as CurrencyCode)
                        ) : (
                          <span className="text-muted-foreground" title="No purchases recorded yet">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {c.order_count != null ? (
                          c.order_count
                        ) : (
                          <span className="text-muted-foreground" title="No orders recorded yet">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge
                          tone={c.lifecycle_state === 'active' ? 'success' : 'neutral'}
                          hideDot
                        >
                          {humanize(c.lifecycle_state)}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-2">
                          <ConsentDot on={c.resolution_consent} label="Identity resolution" />
                          <ConsentDot on={c.ai_processing_consent} label="AI processing" />
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/customers/${encodeURIComponent(c.brain_id)}`}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          aria-label={`Open the profile for ${c.brain_id}`}
                        >
                          Open <ArrowRight className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {!isLoading && !error && total > 0 ? (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
            <span>
              Showing <strong className="text-foreground">{from}</strong>–
              <strong className="text-foreground">{to}</strong> of{' '}
              <strong className="text-foreground">{total}</strong>
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canPrev || isFetching}
                onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
              >
                <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canNext || isFetching}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
