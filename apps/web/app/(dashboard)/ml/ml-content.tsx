'use client';

/**
 * MlContent — the C5 ML platform surface (model registry + serving).
 *
 * BFF-ONLY (I-ST01): reads GET /api/v1/ml/models, POSTs /api/v1/ml/models/:id/promote, and reads
 * GET /api/v1/ml/customer-score?brain_id=…. Two panels:
 *   1. Models — the registry table (name, version, stage badge, framework, key metrics, promoted_at)
 *      with promote actions. Promoting staging→production archives the prior production model of the
 *      same (brand,name) (the partial-unique invariant), so the table refreshes after each promote.
 *   2. Customer score lookup — input a brain_id, serve the deterministic RFM/churn score. Honest
 *      no_data when the customer has no Gold score row (we never fabricate). Money = bigint-minor
 *      strings rendered via the minor-units formatter (never floated).
 */

import * as React from 'react';
import { Boxes, Cpu, Search, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useModels, usePromoteModel, useCustomerScore } from '@/lib/hooks/use-ml';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { MlModel, MlModelStage } from '@/lib/api/types';

/** Stage → badge tone. Production strongest; archived muted. */
function StageBadge({ stage }: { stage: MlModelStage }) {
  const tone =
    stage === 'production'
      ? 'bg-emerald-50 text-emerald-700'
      : stage === 'staging'
        ? 'bg-amber-50 text-amber-800'
        : stage === 'training'
          ? 'bg-sky-50 text-sky-700'
          : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {stage === 'production' && <ShieldCheck className="h-3 w-3" aria-hidden="true" />}
      {stage}
    </span>
  );
}

/** Render the small metrics jsonb as a compact key:value strip (loosely typed). */
function MetricsStrip({ metrics }: { metrics: MlModel['metrics'] }) {
  if (!metrics || Object.keys(metrics).length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {Object.entries(metrics)
        .slice(0, 4)
        .map(([k, v]) => (
          <span key={k}>
            {k.replace(/_/g, ' ')}: <span className="font-medium text-foreground tabular-nums">{String(v)}</span>
          </span>
        ))}
    </div>
  );
}

function ModelRow({ model }: { model: MlModel }) {
  const promote = usePromoteModel();
  // Promotion targets allowed from the current stage (never re-promote to the same stage).
  const canPromoteToProduction = model.stage === 'staging' || model.stage === 'training';
  const canPromoteToStaging = model.stage === 'training' || model.stage === 'archived';

  function onPromote(stage: MlModelStage) {
    promote.mutate({ modelId: model.model_id, stage });
  }

  return (
    <tr className="border-b last:border-0">
      <td className="py-2.5 pr-4">
        <div className="font-medium text-foreground">{model.name}</div>
        <div className="text-xs text-muted-foreground">{model.version}</div>
      </td>
      <td className="py-2.5 pr-4">
        <StageBadge stage={model.stage} />
      </td>
      <td className="py-2.5 pr-4 text-sm text-muted-foreground">{model.framework}</td>
      <td className="py-2.5 pr-4">
        <MetricsStrip metrics={model.metrics} />
      </td>
      <td className="py-2.5 pr-4 text-xs text-muted-foreground tabular-nums">
        {model.promoted_at ? new Date(model.promoted_at).toLocaleString() : '—'}
      </td>
      <td className="py-2.5">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canPromoteToStaging && (
            <Button
              variant="outline"
              size="sm"
              disabled={promote.isPending}
              onClick={() => onPromote('staging')}
            >
              Promote to staging
            </Button>
          )}
          {canPromoteToProduction && (
            <Button size="sm" disabled={promote.isPending} onClick={() => onPromote('production')}>
              Promote to production
            </Button>
          )}
          {model.stage === 'production' && (
            <span className="text-xs text-muted-foreground">Live</span>
          )}
        </div>
        {promote.isError && (
          <span className="mt-1 block text-right text-xs text-destructive" role="alert">
            Couldn&apos;t promote. Try again.
          </span>
        )}
      </td>
    </tr>
  );
}

function inr(minor: string): string {
  try {
    return formatMoneyDisplay(minor, 'INR');
  } catch {
    return minor;
  }
}

function CustomerScorePanel() {
  const [input, setInput] = React.useState('');
  const [brainId, setBrainId] = React.useState<string | null>(null);
  const { data, isLoading, error, refetch } = useCustomerScore(brainId);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = input.trim();
    setBrainId(v.length > 0 ? v : null);
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Cpu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Customer score lookup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Serve the deterministic RFM / churn score for a customer by brain_id. Each lookup is recorded
          in the append-only prediction log.
        </p>
        <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="brain_id (UUID)"
            aria-label="brain_id"
            className="max-w-xs font-mono text-sm"
          />
          <Button type="submit" size="sm" disabled={input.trim().length === 0}>
            <Search className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Serve score
          </Button>
        </form>

        {brainId &&
          (isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : error ? (
            <ErrorCard error={error} retry={() => void refetch()} />
          ) : !data || data.state === 'no_data' ? (
            <EmptyState
              icon={<Cpu className="h-6 w-6" aria-hidden="true" />}
              title="No score for this customer"
              description="This customer has no computed RFM / churn score yet. Scores appear once the customer has enough certified commerce history."
            />
          ) : (
            <div className="space-y-3 rounded-md border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-medium">Churn risk: </span>
                  <span className="capitalize">{data.score.churn_risk}</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Composite (R+F+M):{' '}
                  <span className="font-semibold text-foreground tabular-nums">{data.score.composite_score}</span>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Recency</dt>
                  <dd className="font-medium tabular-nums">{data.score.recency_score}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Frequency</dt>
                  <dd className="font-medium tabular-nums">{data.score.frequency_score}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Monetary</dt>
                  <dd className="font-medium tabular-nums">{data.score.monetary_score}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Lifetime orders</dt>
                  <dd className="font-medium tabular-nums">{data.score.lifetime_orders}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Lifetime value</dt>
                  <dd className="font-medium tabular-nums">{inr(data.score.lifetime_value_minor)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Days since last order</dt>
                  <dd className="font-medium tabular-nums">{data.score.days_since_last_order ?? '—'}</dd>
                </div>
              </dl>
              <div className="border-t pt-2 text-xs text-muted-foreground">
                Served by{' '}
                {data.model ? (
                  <span className="font-medium text-foreground">
                    {data.model.name} {data.model.version} ({data.model.framework})
                  </span>
                ) : (
                  <span className="italic">no production model registered</span>
                )}
                {' · '}prediction {data.prediction_id}
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

export function MlContent() {
  const { data, isLoading, error, refetch } = useModels();
  const models = data?.models ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
        <p className="text-sm text-muted-foreground">
          The model registry and serving layer. Promote a model through its lifecycle — promoting to
          production automatically archives the prior production model so exactly one stays live.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            Model registry
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <ErrorCard error={error} retry={() => void refetch()} />
          ) : models.length === 0 ? (
            <EmptyState
              icon={<Boxes className="h-6 w-6" aria-hidden="true" />}
              title="No models registered"
              description="Models appear here once a brand has a registered scorer. The deterministic RFM / churn model is seeded for every active brand."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Model</th>
                    <th className="py-2 pr-4 font-medium">Stage</th>
                    <th className="py-2 pr-4 font-medium">Framework</th>
                    <th className="py-2 pr-4 font-medium">Metrics</th>
                    <th className="py-2 pr-4 font-medium">Promoted</th>
                    <th className="py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <ModelRow key={m.model_id} model={m} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <CustomerScorePanel />
    </div>
  );
}
