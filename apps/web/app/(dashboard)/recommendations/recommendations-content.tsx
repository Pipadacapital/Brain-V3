'use client';

/**
 * RecommendationsContent — the decision-engine surface (doc 09, the Morning Brief).
 *
 * BFF-ONLY (I-ST01): reads GET /api/v1/recommendations and POSTs /api/v1/recommendations/refresh.
 * Shows the brand's OPEN recommendations — each a deterministic detector's ranked risk/opportunity
 * with a confidence badge, the evidence behind it, and a concrete recommended action. Recommend-only
 * (doc 09): nothing is auto-executed. Honest no_data state when there's nothing to act on.
 *
 * Money in evidence (gmv_at_risk_minor) is a bigint-minor string rendered via the minor-units
 * formatter — never floated (I-S07).
 */

import * as React from 'react';
import { Lightbulb, AlertTriangle, TrendingUp, ShieldCheck, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useRecommendations, useRefreshRecommendations } from '@/lib/hooks/use-recommendations';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { Recommendation } from '@/lib/api/types';

/** Confidence → badge styling (Trusted strongest; engine never overstates — doc 09 Part 7). */
function ConfidenceBadge({ confidence }: { confidence: string }) {
  const tone =
    confidence === 'Trusted'
      ? 'bg-emerald-50 text-emerald-700'
      : confidence === 'Estimated'
        ? 'bg-amber-50 text-amber-800'
        : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      {confidence}
    </span>
  );
}

function inr(minor: string): string {
  try {
    return formatMoneyDisplay(minor, 'INR');
  } catch {
    return minor;
  }
}

function RecommendationCard({ rec }: { rec: Recommendation }) {
  const isRisk = rec.kind === 'risk';
  const gmvAtRisk = rec.evidence['gmv_at_risk_minor'];
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {isRisk ? (
              <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
            ) : (
              <TrendingUp className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            )}
            {rec.title}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs uppercase text-muted-foreground">{isRisk ? 'Risk' : 'Opportunity'}</span>
            <ConfidenceBadge confidence={rec.confidence} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{rec.summary}</p>

        <div className="rounded-md border-l-2 border-primary/50 bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">Recommended action: </span>
          {rec.recommended_action}
        </div>

        {/* Evidence — the certified signal behind the recommendation */}
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {typeof gmvAtRisk === 'string' && gmvAtRisk !== '0' && (
            <div>
              <dt className="inline">GMV at risk: </dt>
              <dd className="inline font-medium text-foreground tabular-nums">{inr(gmvAtRisk)}</dd>
            </div>
          )}
          {Object.entries(rec.evidence)
            .filter(([k]) => k !== 'gmv_at_risk_minor')
            .map(([k, v]) => (
              <div key={k}>
                <dt className="inline">{k.replace(/_/g, ' ')}: </dt>
                <dd className="inline font-medium text-foreground tabular-nums">{String(v)}</dd>
              </div>
            ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export function RecommendationsContent() {
  const { data, isLoading, error, refetch } = useRecommendations();
  const refresh = useRefreshRecommendations();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Recommendations</h1>
          <p className="text-sm text-muted-foreground">
            Deterministic detectors over your certified data — ranked actions with confidence and the
            evidence behind them. Recommend-only: nothing is changed automatically.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refresh.isPending ? 'animate-spin' : ''}`} aria-hidden="true" />
          {refresh.isPending ? 'Running…' : 'Run detectors'}
        </Button>
      </div>

      {refresh.isError && (
        <p className="text-sm text-destructive" role="alert">
          Could not run the detectors. Please try again.
        </p>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : error ? (
        <ErrorCard error={error} retry={() => void refetch()} />
      ) : !data || data.state === 'no_data' ? (
        <EmptyState
          icon={<Lightbulb className="h-6 w-6" aria-hidden="true" />}
          title="No open recommendations"
          description="Run the detectors to scan your latest data. Recommendations appear here when a detector finds an actionable risk or opportunity it's confident about."
          action={
            <Button size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refresh.isPending ? 'animate-spin' : ''}`} aria-hidden="true" />
              Run detectors
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {data.recommendations.map((rec) => (
            <RecommendationCard key={rec.recommendation_id} rec={rec} />
          ))}
        </div>
      )}
    </div>
  );
}
