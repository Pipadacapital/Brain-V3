'use client';

/**
 * SearchContent — P2 "What are shoppers searching for, and do my forms convert?".
 *
 * Reads ONLY via the BFF (the metric-engine seams over the Gold behaviour/conversion marts,
 * I-ST01) — never StarRocks/SQL directly. Two URL-synced sub-tabs under one /analytics/search route,
 * framed by the shared <TabShell> + permanent "?" ExplainerPanel:
 *   - search → useSearchBehavior  (on-site search volume + session/shopper reach + per-day trend) and
 *              the TOP SEARCH TERMS from useBehaviorOverview (the term-level source).
 *   - forms  → useFormConversion  (lead-form submissions + rate + per-form table + per-day trend).
 *
 * Honest states throughout: skeleton (aria-busy), ErrorCard with request_id, an honest empty state
 * linking to pixel setup — never a fabricated zero. Counts are integer (bigint→string); rates are 2dp
 * strings from the engine (null → em-dash, never re-divided client-side). Sparklines encode SHAPE only.
 * data_source='synthetic' surfaces the honest <SyntheticBadge> — never presented as live.
 *
 * The sub-tab is driven by `initialTab` (from ?tab=) and kept in the URL via history.replaceState so a
 * deep-linked section stays shareable without a full navigation.
 */

import * as React from 'react';
import { useState } from 'react';
import Link from 'next/link';
import { Search, FileText, ArrowRight, ListOrdered } from 'lucide-react';
import { TabShell } from '@/components/ui/tab-shell';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { Sparkline } from '@/components/analytics/sparkline';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { DateRangeFilter, initialRange, type DateRange } from '@/components/ui/date-range-filter';
import { TableSearch, matchesQuery } from '@/components/ui/table-search';
import {
  useSearchBehavior,
  useFormConversion,
  useBehaviorOverview,
} from '@/lib/hooks/use-analytics';
import type {
  AnalyticsSearchBehaviorResponse,
  AnalyticsFormConversionResponse,
  AnalyticsBehaviorOverviewResponse,
} from '@/lib/api/types';

type SearchHasData = Extract<AnalyticsSearchBehaviorResponse, { state: 'has_data' }>;
type FormHasData = Extract<AnalyticsFormConversionResponse, { state: 'has_data' }>;
type BehaviorHasData = Extract<AnalyticsBehaviorOverviewResponse, { state: 'has_data' }>;

const SUBTABS = [
  { key: 'search', label: 'Search' },
  { key: 'forms', label: 'Forms' },
] as const;

type SubTabKey = (typeof SUBTABS)[number]['key'];

function normalizeTab(tab?: string): SubTabKey {
  return SUBTABS.some((t) => t.key === tab) ? (tab as SubTabKey) : 'search';
}

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

// ── Shared honest states ──────────────────────────────────────────────────────

function Loading({ label }: { label: string }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label={label}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

function EmptyCard({
  testid,
  icon,
  title,
  body,
}: {
  testid: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Card data-testid={testid}>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          {icon}
        </div>
        <div>
          <p className="font-medium text-foreground">{title}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">{body}</p>
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

function DataSourceBadge({ source }: { source: SearchHasData['data_source'] }) {
  if (source === 'synthetic') return <SyntheticBadge />;
  return null;
}

// ── Search sub-tab ─────────────────────────────────────────────────────────────

function TopSearchesCard({ data }: { data: BehaviorHasData | undefined }) {
  const [query, setQuery] = useState('');

  return (
    <Card data-testid="search-top-terms">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
            <ListOrdered className="h-4 w-4" aria-hidden="true" />
            Top search terms
          </CardTitle>
          {data && data.top_searches.length > 0 && (
            <TableSearch
              value={query}
              onChange={setQuery}
              placeholder="Filter terms…"
              aria-label="Filter top search terms"
            />
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!data || data.top_searches.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4" role="status">
            No search terms in this window yet.
          </p>
        ) : (
          (() => {
            const rows = data.top_searches.filter((r) => matchesQuery(query, r.key));
            if (rows.length === 0) {
              return (
                <p className="text-sm text-muted-foreground py-4" role="status">
                  No matching terms
                </p>
              );
            }
            return (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1.5 font-medium">Term</th>
                    <th className="py-1.5 font-medium text-right">Searches</th>
                    <th className="py-1.5 font-medium text-right">Shoppers</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5 text-foreground truncate max-w-[18rem]" title={r.key}>
                        {r.key}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{num(r.count)}</td>
                      <td className="py-1.5 text-right tabular-nums">{num(r.reach)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()
        )}
      </CardContent>
    </Card>
  );
}

function SearchTrendCard({ data }: { data: SearchHasData }) {
  const series = data.days.map((d) => Number(d.searches));
  const trending = series.length >= 2 && series[series.length - 1] >= series[0] ? 'up' : 'down';
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Daily search volume ({data.from} → {data.to})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.days.length < 2 ? (
          <p className="text-sm text-muted-foreground py-4" role="status">
            Not enough days to chart a trend yet.
          </p>
        ) : (
          <div className="flex items-end gap-4">
            <Sparkline
              data={series}
              width={240}
              height={48}
              ariaLabel={`On-site searches per day, ${data.from} to ${data.to}, trending ${trending}`}
              data-testid="search-sparkline"
              className="text-foreground"
            />
            <span className="text-xs text-muted-foreground">
              {data.days.length} days · peak {num(String(Math.max(...series)))}/day
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SearchTab() {
  const [range, setRange] = useState<DateRange>(() => initialRange());
  const q = useSearchBehavior({ from: range.from, to: range.to });
  // Top search TERMS live in the storefront-behaviour overview (term-level source).
  const terms = useBehaviorOverview({ from: range.from, to: range.to });
  const data = q.data;

  return (
    <div className="space-y-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">On-site search</h2>
        <DateRangeFilter value={range} onChange={setRange} aria-label="Search date range" />
      </div>

      {q.isLoading && <Loading label="Loading on-site search…" />}
      {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}
      {!q.isLoading && !q.error && data?.state === 'no_data' && (
        <EmptyCard
          testid="search-empty"
          icon={<Search className="h-8 w-8" />}
          title="No search activity yet"
          body="On-site search appears once the Brain Pixel captures search events. Volume, reach, and the
            top terms build from those touchpoints in the behaviour mart."
        />
      )}
      {!q.isLoading && !q.error && data?.state === 'has_data' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <DataSourceBadge source={data.data_source} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile label="Searches" value={num(data.searches)} sublabel={`${data.from} → ${data.to}`} />
            <KpiTile label="Sessions that searched" value={num(data.sessions)} sublabel="distinct sessions" />
            <KpiTile label="Shoppers" value={num(data.journeys)} sublabel="distinct journeys" />
          </div>
          <SearchTrendCard data={data} />
          <TopSearchesCard
            data={terms.data?.state === 'has_data' ? terms.data : undefined}
          />
        </div>
      )}
    </div>
  );
}

// ── Forms sub-tab ──────────────────────────────────────────────────────────────

function FormsTrendCard({ data }: { data: FormHasData }) {
  const subs = data.days.map((d) => Number(d.submissions));
  const trending = subs.length >= 2 && subs[subs.length - 1] >= subs[0] ? 'up' : 'down';
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Daily submissions ({data.from} → {data.to})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.days.length < 2 ? (
          <p className="text-sm text-muted-foreground py-4" role="status">
            Not enough days to chart a trend yet.
          </p>
        ) : (
          <div className="flex items-end gap-4">
            <Sparkline
              data={subs}
              width={240}
              height={48}
              ariaLabel={`Form submissions per day, ${data.from} to ${data.to}, trending ${trending}`}
              data-testid="forms-sparkline"
              className="text-foreground"
            />
            <span className="text-xs text-muted-foreground">
              {data.days.length} days · peak {num(String(Math.max(...subs)))}/day
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FormsTable({ rows }: { rows: FormHasData['forms'] }) {
  const [query, setQuery] = useState('');
  const filtered = rows.filter((r) => matchesQuery(query, r.form_id));
  return (
    <Card data-testid="forms-per-form">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Form performance</CardTitle>
          {rows.length > 0 && (
            <TableSearch
              value={query}
              onChange={setQuery}
              placeholder="Filter forms…"
              aria-label="Filter forms"
            />
          )}
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4" role="status">
            No form activity in this window yet.
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4" role="status">
            No matching forms
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-1.5 font-medium">Form</th>
                <th className="py-1.5 font-medium text-right">Submissions</th>
                <th className="py-1.5 font-medium text-right">Sessions</th>
                <th className="py-1.5 font-medium text-right">Submission rate</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.form_id} className="border-b border-border/50 last:border-0">
                  <td className="py-1.5 text-foreground truncate max-w-[18rem]" title={r.form_id}>
                    {r.form_id}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{num(r.submissions)}</td>
                  <td className="py-1.5 text-right tabular-nums">{num(r.sessions)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.submission_rate_pct !== null ? `${r.submission_rate_pct}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function FormsTab() {
  const [range, setRange] = useState<DateRange>(() => initialRange());
  const q = useFormConversion({ from: range.from, to: range.to });
  const data = q.data;

  return (
    <div className="space-y-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Lead-form conversion</h2>
        <DateRangeFilter value={range} onChange={setRange} aria-label="Forms date range" />
      </div>

      {q.isLoading && <Loading label="Loading form conversion…" />}
      {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}
      {!q.isLoading && !q.error && data?.state === 'no_data' && (
        <EmptyCard
          testid="forms-empty"
          icon={<FileText className="h-8 w-8" />}
          title="No form activity yet"
          body="Form performance appears once the Brain Pixel captures lead-form submissions. Submission
            counts, rates, and payment reach build from those touchpoints — structural form ids only, PII-safe."
        />
      )}
      {!q.isLoading && !q.error && data?.state === 'has_data' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <DataSourceBadge source={data.data_source} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <KpiTile label="Submissions" value={num(data.submissions)} sublabel={`${data.from} → ${data.to}`} />
            <KpiTile label="Sessions" value={num(data.sessions)} sublabel="distinct sessions" />
            <KpiTile
              label="Submission rate"
              value={data.submission_rate_pct !== null ? `${data.submission_rate_pct}%` : '—'}
              sublabel="submissions ÷ sessions"
            />
            <KpiTile label="Payments succeeded" value={num(data.payments_succeeded)} sublabel="same-day reach" />
          </div>
          <FormsTrendCard data={data} />
          <FormsTable rows={data.forms} />
        </div>
      )}
    </div>
  );
}

// ── Page shell ─────────────────────────────────────────────────────────────────

export function SearchContent({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState<SubTabKey>(() => normalizeTab(initialTab));

  const onTabChange = React.useCallback((next: string) => {
    const value = normalizeTab(next);
    setTab(value);
    if (typeof window !== 'undefined') {
      const url = value === 'search' ? '/analytics/search' : `/analytics/search?tab=${value}`;
      window.history.replaceState(null, '', url);
    }
  }, []);

  return (
    <TabShell
      title="Search & Forms"
      description="What are shoppers searching for, and do my forms convert?"
      freshness={<FreshnessBadge timestamp={null} />}
      explainer={{
        title: 'Search & Forms — intent signals from the storefront',
        description:
          'On-site search and lead-form behaviour in one place. Every metric here is built from Brain Pixel touchpoints folded into the Gold behaviour/conversion marts — read via the metric-engine seam, never raw SQL. With no pixel installed these surfaces honestly show an empty state, never a fabricated zero.',
        sections: [
          {
            heading: 'Sub-sections',
            body: 'Search (how much shoppers search, how many sessions/shoppers reach search, the daily trend, and the top search terms) · Forms (lead-form submissions, the submission rate, same-day payment reach, the daily trend, and per-form performance).',
          },
        ],
        metrics: [
          {
            name: 'Searches / sessions / shoppers',
            definition: 'Total on-site searches, the distinct sessions that searched, and the distinct shoppers (journeys) behind them.',
            howComputed: 'Aggregated from the search slice of the Gold behaviour mart over the selected range (useSearchBehavior).',
          },
          {
            name: 'Top search terms',
            definition: 'The most-run search terms with their search and shopper counts.',
            howComputed: 'From the storefront-behaviour overview term breakdown (useBehaviorOverview.top_searches) — the term-level source.',
          },
          {
            name: 'Submission rate',
            definition: 'Of the sessions that engaged a lead form, the share that submitted it.',
            howComputed: 'Submissions ÷ sessions from the Gold conversion mart (useFormConversion). A 2dp string from the engine — null when the denominator is 0 (honest em-dash, never 0/∞).',
          },
          {
            name: 'Payments succeeded',
            definition: 'Same-day payment reach following form submissions — an honest proxy for downstream conversion.',
            howComputed: 'Counted in the per-day series of the Gold conversion mart (useFormConversion).',
          },
        ],
        refreshCadence:
          'Behaviour/conversion marts refresh on the Silver/Gold loop. These endpoints do not stamp a served-at time, so freshness is shown honestly as unknown rather than fabricated. Each surface tags its own provenance (live vs synthetic) via data_source.',
        sources: [
          'Brain Pixel events → Gold behaviour mart (search slice)',
          'Brain Pixel events → Gold conversion mart (lead forms)',
          'metric-engine search-behavior / form-conversion / storefront-behavior seams',
        ],
      }}
    >
      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList aria-label="Search & Forms sub-sections">
          {SUBTABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="search">
          <SearchTab />
        </TabsContent>
        <TabsContent value="forms">
          <FormsTab />
        </TabsContent>
      </Tabs>
    </TabShell>
  );
}
