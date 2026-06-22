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
import Link from 'next/link';
import { Lightbulb, AlertTriangle, TrendingUp, TrendingDown, ShieldCheck, ShieldAlert, RefreshCw, Check, X, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useRecommendations, useRefreshRecommendations, useRecommendationAction } from '@/lib/hooks/use-recommendations';
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
  // The icon must match the tier — a verified check only for Trusted. Showing a green ShieldCheck on
  // an Estimated/Insufficient rec would overstate certainty (the exact thing the engine prevents).
  const Icon = confidence === 'Trusted' ? ShieldCheck : ShieldAlert;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
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

/** The learning-loop outcome strip: the detector's headline metric then-at-raise vs now. */
function OutcomeStrip({ outcome }: { outcome: NonNullable<Recommendation['outcome']> }) {
  const label = outcome.metric.replace(/_/g, ' ').replace(/ pct$/, ' %');
  const tone = outcome.improved ? 'text-emerald-700 bg-emerald-50' : 'text-amber-800 bg-amber-50';
  const Icon = outcome.improved ? TrendingDown : TrendingUp;
  return (
    <div className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs ${tone}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium">Since raised:</span>
      <span className="tabular-nums">
        {label} {outcome.then} → {outcome.now}
      </span>
      <span className="font-medium">{outcome.improved ? 'improving' : 'not improving yet'}</span>
    </div>
  );
}

function RecommendationCard({ rec }: { rec: Recommendation }) {
  const isRisk = rec.kind === 'risk';
  const gmvAtRisk = rec.evidence['gmv_at_risk_minor'];
  const act = useRecommendationAction();
  // Optimistic local acknowledgement: the action ledger is append-only and a dismissal also
  // refetches the list (the rec drops off), but until that lands we reflect what the user chose.
  const [acted, setActed] = React.useState<'accepted' | 'dismissed' | 'snoozed' | null>(null);

  function onAct(action: 'accepted' | 'dismissed' | 'snoozed') {
    setActed(action);
    act.mutate(
      { recommendationId: rec.recommendation_id, action },
      { onError: () => setActed(null) },
    );
  }

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

        {rec.outcome && <OutcomeStrip outcome={rec.outcome} />}

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

        {/* Decision-feedback loop (M7): the human acts on the recommendation. Recorded in the
            append-only action ledger; a dismissal also drops the rec off the Morning Brief. */}
        {acted ? (
          <div
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
            role="status"
          >
            {acted === 'accepted' ? (
              <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            ) : acted === 'snoozed' ? (
              <Clock className="h-4 w-4 text-amber-600" aria-hidden="true" />
            ) : (
              <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            )}
            {acted === 'accepted' ? 'Accepted' : acted === 'snoozed' ? 'Snoozed' : 'Dismissed'}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" disabled={act.isPending} onClick={() => onAct('accepted')}>
              <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Accept
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={act.isPending}
              onClick={() => onAct('snoozed')}
            >
              <Clock className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Snooze
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={act.isPending}
              onClick={() => onAct('dismissed')}
            >
              <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Dismiss
            </Button>
            {act.isError && (
              <span className="text-xs text-destructive" role="alert">
                Couldn&apos;t record that. Try again.
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * HeldRecommendationCard — a recommendation the confidence gate is holding back (P0). Brain found a
 * signal but the brand's data foundation isn't trusted enough to ACT on it yet. We don't hide it and
 * we don't dress it as a decision — we surface it as a guided next step: improve the foundation.
 */
function HeldRecommendationCard({ rec }: { rec: Recommendation }) {
  return (
    <Card className="border-dashed bg-muted/30">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
            <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
            {rec.title}
          </CardTitle>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            Held
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">{rec.summary}</p>
        <p className="text-sm" role="status">
          {rec.held_reason ?? 'Held until your data foundation is trusted enough to act on this.'}
        </p>
        <Link href="/data/quality" className="inline-flex items-center text-sm font-medium text-primary hover:underline">
          Improve data confidence →
        </Link>
      </CardContent>
    </Card>
  );
}

export function RecommendationsContent() {
  const { data, isLoading, error, refetch } = useRecommendations();
  const refresh = useRefreshRecommendations();

  const recommendations = data?.state === 'has_data' ? data.recommendations : [];
  const actionable = recommendations.filter((r) => !r.held);
  const held = recommendations.filter((r) => r.held);

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
        <div className="space-y-8">
          {actionable.length > 0 ? (
            <div className="space-y-4">
              {actionable.map((rec) => (
                <RecommendationCard key={rec.recommendation_id} rec={rec} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Lightbulb className="h-6 w-6" aria-hidden="true" />}
              title="Nothing to act on yet"
              description="No recommendation currently meets your data-confidence bar. Anything Brain found is listed below, waiting on a stronger data foundation."
            />
          )}

          {held.length > 0 && (
            <section className="space-y-3" aria-label="Recommendations waiting on data confidence">
              <div>
                <h2 className="text-sm font-semibold text-muted-foreground">Waiting on data confidence</h2>
                <p className="text-xs text-muted-foreground">
                  Brain found these signals but won&apos;t recommend acting until your data foundation is
                  trusted — confidence before decisions.
                </p>
              </div>
              <div className="space-y-3">
                {held.map((rec) => (
                  <HeldRecommendationCard key={rec.recommendation_id} rec={rec} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
