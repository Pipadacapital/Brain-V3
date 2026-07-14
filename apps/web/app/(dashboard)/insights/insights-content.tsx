'use client';

/**
 * InsightsContent — the AI Copilot surface.
 *
 * Renders the deterministic Insight + Opportunity Engine: a daily briefing (what changed / why /
 * what to do), $-quantified KPI tiles, the revenue trend, and a ranked insight feed. Every number
 * comes from the BFF (Gold marts via the metric-engine) — the UI only formats it. Honest empty
 * state until real data flows (no fabricated charts).
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataWindowBadge } from '@/components/ui/data-window-badge';
import { VerifyLink } from '@/components/ui/verify-link';
import { TableSearch, filterRows } from '@/components/ui/table-search';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { TrendChart } from '@/components/analytics/trend-chart';
import { useInsightsBriefing, useRevenueTimeseries, ANALYTICS_QUERY_KEY } from '@/lib/hooks/use-analytics';
import { recommendationApi } from '@/lib/api/client';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { plainConfidence } from '@/lib/format/plain-language';
import type { CurrencyCode } from '@brain/money';
import type { InsightConfidence, InsightDto, InsightKind, InsightSeverity, RecommendationActionKind } from '@/lib/api/types';
import { Sparkles, AlertTriangle, Lightbulb, TrendingUp, TrendingDown, Check } from 'lucide-react';

/**
 * Plain-language confidence → visible phrase + tone + a one-line "what this means" (shown on
 * hover via the badge title). Replaces the raw "confidence: high" code that used to reach the
 * DOM (plain-language rule 1). Meaning is text, never colour alone.
 */
const CONFIDENCE_META: Record<InsightConfidence, { tone: 'success' | 'info' | 'warning'; help: string }> = {
  high: { tone: 'success', help: 'Based on strong, complete data — safe to act on.' },
  medium: { tone: 'info', help: 'Based on mostly complete data — likely reliable.' },
  low: { tone: 'warning', help: 'Based on limited or still-settling data — treat as directional.' },
};

const KIND_ICON: Record<InsightKind, React.ComponentType<{ className?: string }>> = {
  risk: AlertTriangle,
  opportunity: Lightbulb,
  trend: TrendingUp,
};

const SEVERITY_VARIANT: Record<InsightSeverity, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  high: 'destructive',
  medium: 'default',
  low: 'secondary',
  info: 'outline',
};

function money(minor: string | null, ccy: string | null): string | null {
  if (minor == null || ccy == null) return null;
  try {
    return formatMoneyDisplay(minor, ccy as CurrencyCode);
  } catch {
    return null;
  }
}

function InsightCard({ insight }: { insight: InsightDto }) {
  const Icon = KIND_ICON[insight.kind];
  const impact = money(insight.impact_minor, insight.currency_code);
  const deltaUp = insight.direction === 'up';
  const queryClient = useQueryClient();
  const dismissed = insight.status === 'dismissed';
  const [lastAction, setLastAction] = useState<RecommendationActionKind | null>(null);

  // Acting writes to the audited recommendation_action ledger (the decision-feedback loop / RGUD).
  const act = useMutation({
    mutationFn: (action: RecommendationActionKind) => {
      if (!insight.recommendation_id) throw new Error('insight not yet actionable');
      return recommendationApi.action(insight.recommendation_id, action);
    },
    onSuccess: (_data, action) => {
      setLastAction(action);
      void queryClient.invalidateQueries({ queryKey: [...ANALYTICS_QUERY_KEY, 'insights-briefing'] });
    },
  });
  const actionable = Boolean(insight.recommendation_id) && !dismissed;

  return (
    <Card className={`p-5 ${dismissed ? 'opacity-60' : ''}`}>
      <CardContent className="p-0 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-muted-foreground">
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <p className="font-semibold text-foreground leading-snug">{insight.title}</p>
              <p className="text-sm text-muted-foreground mt-1">{insight.why}</p>
            </div>
          </div>
          <Badge variant={SEVERITY_VARIANT[insight.severity]} className="shrink-0 capitalize">
            {insight.severity}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm">
          {impact && (
            <span className="font-semibold text-foreground tabular-nums">
              {insight.kind === 'opportunity' ? 'Recoverable: ' : 'At risk: '}
              {impact}
            </span>
          )}
          {insight.delta_pct && (
            <span
              className={`inline-flex items-center gap-1 tabular-nums ${
                deltaUp ? 'text-success' : 'text-destructive'
              }`}
            >
              {deltaUp ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              {insight.delta_pct}%
            </span>
          )}
          {/* Plain-language confidence — "We're confident" / "Fairly confident" / "Rough estimate"
              instead of the raw "confidence: high" code; title carries the one-line explainer. */}
          <StatusBadge
            tone={CONFIDENCE_META[insight.confidence].tone}
            hideDot
            title={CONFIDENCE_META[insight.confidence].help}
          >
            {plainConfidence(insight.confidence)}
          </StatusBadge>
        </div>

        <div className="rounded-md bg-accent/60 px-3 py-2 text-sm">
          <span className="font-medium text-foreground">Recommended: </span>
          <span className="text-muted-foreground">{insight.recommended_action}</span>
        </div>

        {/* Audited decision loop — Accept / Snooze / Dismiss write to the recommendation_action ledger. */}
        {actionable && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => act.mutate('accepted')}
              disabled={act.isPending}
              data-testid="insight-accept"
            >
              {lastAction === 'accepted' ? (
                <span className="inline-flex items-center gap-1"><Check className="h-4 w-4" /> Accepted</span>
              ) : (
                'Accept'
              )}
            </Button>
            <Button size="sm" variant="outline" onClick={() => act.mutate('snoozed')} disabled={act.isPending}>
              {lastAction === 'snoozed' ? 'Snoozed' : 'Snooze'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act.mutate('dismissed')} disabled={act.isPending}>
              Dismiss
            </Button>
            {act.isError && <span className="text-xs text-destructive">Couldn&apos;t record — retry.</span>}
          </div>
        )}
        {dismissed && (
          <div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
            <span>Dismissed.</span>
            {insight.recommendation_id && (
              <Button size="sm" variant="ghost" onClick={() => act.mutate('reopened')} disabled={act.isPending}>
                Undo
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function InsightsContent() {
  const { data, isLoading, error } = useInsightsBriefing();
  const { data: revenue, isLoading: revenueLoading } = useRevenueTimeseries({ grain: 'day' });
  const [feedQuery, setFeedQuery] = useState('');

  const hasData = data?.state === 'has_data';
  const briefing = hasData ? data.briefing : null;
  const insights = hasData ? data.insights : [];
  const ccy = briefing?.primary_currency ?? null;
  const totalImpact = money(briefing?.total_impact_minor ?? null, ccy);

  // SEARCH: narrow the already-loaded insight feed across its human-meaningful text.
  const filteredInsights = filterRows(
    insights,
    feedQuery,
    (i) => `${i.title} ${i.why} ${i.recommended_action} ${i.kind} ${i.severity}`,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            Copilot
          </span>
        }
        title="Insights & Copilot"
        description="What changed, why, and what to do — calculated from your own data, never guessed."
      />

      {/* Daily briefing */}
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" /> Daily Briefing
            </span>
            {/* DEV-HONESTY: data_source comes from the BFF (never hardcoded). When the contributing
                Gold marts hold synthetic demo rows the briefing is badged Synthetic (dev) and is
                NEVER presented as live; it disappears with no UI change once real data flows. */}
            {briefing?.data_source === 'synthetic' && (
              <SyntheticBadge
                data-testid="insights-synthetic-badge"
                reason="This briefing is calculated from sample demo data, not your live sales. Connect a live source to replace it."
              />
            )}
            {/* FRESHNESS GUARD: if the gold marts haven't been rebuilt within the SLO (e.g. the dbt
                refresh cron stalled in prod) the briefing warns instead of silently serving stale data. */}
            {briefing?.stale && (
              <StatusBadge
                tone="warning"
                hideDot
                role="status"
                data-testid="insights-stale-badge"
                title={briefing.as_of ? `Data last refreshed ${new Date(briefing.as_of).toLocaleString()}` : 'A data refresh is overdue'}
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Data may be stale
              </StatusBadge>
            )}
          </CardTitle>
          {briefing && <CardDescription>{briefing.headline}</CardDescription>}
          {/* DATE WINDOW: the briefing is computed over a fixed comparison window (server-owned,
              not a client filter) — surface it honestly so the reader always sees the span the
              numbers cover. */}
          {briefing && (
            <DataWindowBadge
              from={briefing.window.current.from}
              to={briefing.window.current.to}
              count={insights.length}
              label="insights"
              className="pt-1"
            />
          )}
        </CardHeader>
        <CardContent>
          {isLoading && <p className="text-sm text-muted-foreground">Analysing your commerce…</p>}
          {error && (
            <p className="text-sm text-destructive">
              Couldn&apos;t load the briefing. Your data is safe — please retry shortly.
            </p>
          )}
          {!isLoading && !error && !hasData && (
            <EmptyState
              title="No insights yet"
              description="Connect a store and let data flow (orders, customers, spend). Brain will surface insights, risks and opportunities here automatically — no empty charts until the numbers are real."
            />
          )}
          {briefing && (
            <ul className="space-y-2">
              {briefing.summary.map((line, i) => (
                <li key={i} className="flex gap-2 text-sm text-foreground">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* KPI tiles */}
      <section aria-label="Insight summary">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Opportunities"
            help="Chances to gain revenue that Brain has spotted in your data."
            value={hasData ? String(briefing?.counts.opportunities ?? 0) : null}
            isLoading={isLoading}
          />
          <KpiTile
            label="Risks"
            help="Issues that could cost you revenue if left unaddressed — lower is better."
            value={hasData ? String(briefing?.counts.risks ?? 0) : null}
            isLoading={isLoading}
            lowerIsBetter
          />
          <KpiTile
            label="Est. revenue impact"
            help="Roughly how much money the current opportunities and risks add up to over 30 days."
            value={totalImpact}
            isLoading={isLoading}
            sublabel="recoverable + at-risk (30d)"
          />
          <KpiTile
            label="Trends tracked"
            help="Ongoing patterns in your numbers that Brain is watching."
            value={hasData ? String(briefing?.counts.trends ?? 0) : null}
            isLoading={isLoading}
          />
        </div>
      </section>

      {/* Revenue trend (reuses the existing registry-backed timeseries) */}
      <Card>
        <CardHeader>
          <CardTitle>Revenue trend</CardTitle>
          <CardDescription>Confirmed vs still-settling revenue — the signal behind the briefing.</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart data={revenue} isLoading={revenueLoading} grain="day" />
        </CardContent>
      </Card>

      {/* Insight feed */}
      {hasData && (
        <section aria-label="Insight feed" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-foreground">Ranked insights</h2>
            <div className="flex flex-wrap items-center gap-3">
              {/* VERIFY: the impact figures summarize order records — let the reader drill through. */}
              <VerifyLink href="/analytics/orders" label="See the orders behind these numbers" />
              {insights.length > 0 && (
                <TableSearch
                  value={feedQuery}
                  onChange={setFeedQuery}
                  placeholder="Search insights…"
                  aria-label="Search insights"
                />
              )}
            </div>
          </div>

          {insights.length === 0 ? (
            // HONEST EMPTY: has_data but nothing ranked — say why, don't show a blank grid.
            <EmptyState
              title="No risks or opportunities in this window"
              description="Brain analysed your data for this period and found nothing that needs attention right now. New insights appear here automatically as orders, spend and returns change."
            />
          ) : filteredInsights.length === 0 ? (
            <EmptyState
              title="No insights match your search"
              description={`Nothing matches "${feedQuery}". Clear the search to see all ${insights.length} ranked insights.`}
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {filteredInsights.map((insight) => (
                <InsightCard key={insight.id} insight={insight} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
