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
import { KpiTile } from '@/components/analytics/kpi-tile';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { TrendChart } from '@/components/analytics/trend-chart';
import { useInsightsBriefing, useRevenueTimeseries, ANALYTICS_QUERY_KEY } from '@/lib/hooks/use-analytics';
import { recommendationApi } from '@/lib/api/client';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { InsightDto, InsightKind, InsightSeverity, RecommendationActionKind } from '@/lib/api/types';
import { Sparkles, AlertTriangle, Lightbulb, TrendingUp, TrendingDown, Check } from 'lucide-react';

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
                deltaUp ? 'text-status-green-700' : 'text-status-red-700'
              }`}
            >
              {deltaUp ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              {insight.delta_pct}%
            </span>
          )}
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            confidence: {insight.confidence}
          </span>
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
            {act.isError && <span className="text-xs text-status-red-700">Couldn&apos;t record — retry.</span>}
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

  const hasData = data?.state === 'has_data';
  const briefing = hasData ? data.briefing : null;
  const insights = hasData ? data.insights : [];
  const ccy = briefing?.primary_currency ?? null;
  const totalImpact = money(briefing?.total_impact_minor ?? null, ccy);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="rounded-lg bg-primary/10 p-2 text-primary">
          <Sparkles className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Insights &amp; Copilot</h1>
          <p className="text-muted-foreground mt-0.5">
            What changed, why, and what to do — computed from your lakehouse, never guessed.
          </p>
        </div>
      </div>

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
                reason="This briefing is computed from synthetic demo data seeded into the Gold marts (real shape, synthetic source). Connect a live source to replace it — this is never live data."
              />
            )}
            {/* FRESHNESS GUARD: if the gold marts haven't been rebuilt within the SLO (e.g. the dbt
                refresh cron stalled in prod) the briefing warns instead of silently serving stale data. */}
            {briefing?.stale && (
              <span
                role="status"
                data-testid="insights-stale-badge"
                title={briefing.as_of ? `Marts last refreshed ${new Date(briefing.as_of).toLocaleString()}` : 'Mart refresh is overdue'}
                className="inline-flex items-center gap-1 rounded-md border border-status-amber-200 bg-status-amber-50 px-2 py-0.5 text-xs font-medium text-status-amber-700"
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Data may be stale
              </span>
            )}
          </CardTitle>
          {briefing && <CardDescription>{briefing.headline}</CardDescription>}
        </CardHeader>
        <CardContent>
          {isLoading && <p className="text-sm text-muted-foreground">Analysing your commerce…</p>}
          {error && (
            <p className="text-sm text-status-red-700">
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
            value={hasData ? String(briefing?.counts.opportunities ?? 0) : null}
            isLoading={isLoading}
          />
          <KpiTile
            label="Risks"
            value={hasData ? String(briefing?.counts.risks ?? 0) : null}
            isLoading={isLoading}
            lowerIsBetter
          />
          <KpiTile
            label="Est. revenue impact"
            value={totalImpact}
            isLoading={isLoading}
            sublabel="recoverable + at-risk (30d)"
          />
          <KpiTile
            label="Trends tracked"
            value={hasData ? String(briefing?.counts.trends ?? 0) : null}
            isLoading={isLoading}
          />
        </div>
      </section>

      {/* Revenue trend (reuses the existing registry-backed timeseries) */}
      <Card>
        <CardHeader>
          <CardTitle>Revenue trend</CardTitle>
          <CardDescription>Realized vs provisional, the signal behind the briefing.</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart data={revenue} isLoading={revenueLoading} grain="day" />
        </CardContent>
      </Card>

      {/* Insight feed */}
      {hasData && insights.length > 0 && (
        <section aria-label="Insight feed" className="space-y-3">
          <h2 className="text-lg font-semibold text-foreground">Ranked insights</h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {insights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
