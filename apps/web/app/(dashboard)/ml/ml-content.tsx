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
import Link from 'next/link';
import { Boxes, Cpu, Lock, Search, ShieldCheck, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSearch, matchesQuery } from '@/components/ui/table-search';
import { DataWindowBadge } from '@/components/ui/data-window-badge';
import { VerifyLink } from '@/components/ui/verify-link';
import { useModels, usePromoteModel, useCustomerScore } from '@/lib/hooks/use-ml';
import { useCustomers } from '@/lib/hooks/use-identity';
import { useSessionRole } from '@/lib/hooks/use-session-role';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { plainLabel } from '@/lib/format/plain-language';
import type { MlModel, MlModelStage } from '@/lib/api/types';

/** Stage → badge tone. Production strongest; archived muted. */
function StageBadge({ stage }: { stage: MlModelStage }) {
  const tone: StatusTone =
    stage === 'production'
      ? 'success'
      : stage === 'staging'
        ? 'warning'
        : stage === 'training'
          ? 'info'
          : 'neutral';
  return (
    <StatusBadge tone={tone} hideDot>
      {stage === 'production' && <ShieldCheck className="h-3 w-3" aria-hidden="true" />}
      {stage}
    </StatusBadge>
  );
}

/** Render the small metrics jsonb as a compact key:value strip (loosely typed). */
function MetricsStrip({ metrics }: { metrics: MlModel['metrics'] }) {
  if (!metrics || Object.keys(metrics).length === 0) {
    return (
      <span className="text-xs text-muted-foreground" title="No quality metrics recorded for this model yet">
        —
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {Object.entries(metrics)
        .slice(0, 4)
        .map(([k, v]) => (
          <span key={k}>
            {plainLabel(k)}: <span className="font-medium text-foreground tabular-nums">{String(v)}</span>
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
      <td
        className="py-2.5 pr-4 text-xs text-muted-foreground tabular-nums"
        title={model.promoted_at ? undefined : 'Not promoted yet'}
      >
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

/** A customer chosen in the picker — carries the id used for serving + a human label for display. */
interface PickedCustomer {
  brainId: string;
  label: string;
}

/**
 * CustomerPicker — search-and-pick a customer by name/email/reference instead of pasting a raw
 * Brain customer ID. Types ≥2 chars → live matches from the customer browse (counts-only, no raw
 * PII); pick one to serve its score. This replaces the old raw brain_id textbox so a non-technical
 * owner never has to know what a UUID is.
 */
function CustomerPicker({
  value,
  onSelect,
  onClear,
}: {
  value: PickedCustomer | null;
  onSelect: (c: PickedCustomer) => void;
  onClear: () => void;
}) {
  const [input, setInput] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);

  const active = debounced.length >= 2;
  const { data, isFetching } = useCustomers({ search: active ? debounced : undefined, limit: 8 });
  const items = active ? (data?.items ?? []) : [];

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
          <Cpu className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">{value.label}</span>
        </span>
        <Button variant="outline" size="sm" onClick={onClear}>
          <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Choose another
        </Button>
      </div>
    );
  }

  return (
    <div className="relative max-w-md">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search a customer by name, email, or reference…"
          aria-label="Search a customer to score"
          className="pl-8 text-sm"
        />
      </div>
      {open && active && (
        <div
          className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md"
          role="listbox"
        >
          {isFetching && items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No customers match &ldquo;{debounced}&rdquo;.
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1">
              {items.map((c) => {
                const label = c.customer_ref ?? c.brain_id;
                return (
                  <li key={c.brain_id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      // onMouseDown fires before the input's onBlur closes the list.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onSelect({ brainId: c.brain_id, label });
                        setInput('');
                        setOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                    >
                      <span className="font-medium">{label}</span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {c.segment && <span>{plainLabel(c.segment)}</span>}
                        {c.order_count != null && (
                          <span className="tabular-nums">
                            {c.order_count} {c.order_count === 1 ? 'order' : 'orders'}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function CustomerScorePanel() {
  const [picked, setPicked] = React.useState<PickedCustomer | null>(null);
  const brainId = picked?.brainId ?? null;
  const { data, isLoading, error, refetch } = useCustomerScore(brainId);

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
          Look up a customer&apos;s buying-behaviour score (how recently, how often, and how much they
          buy) and their churn risk. Search for the customer below — every lookup is kept in a
          tamper-proof log.
        </p>
        <CustomerPicker value={picked} onSelect={setPicked} onClear={() => setPicked(null)} />

        {brainId &&
          (isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : error ? (
            <ErrorCard error={error} retry={() => void refetch()} />
          ) : !data || data.state === 'no_data' ? (
            <EmptyState
              icon={<Cpu className="h-6 w-6" aria-hidden="true" />}
              title="No score for this customer"
              description="This customer doesn't have a score yet. Scores appear once they have enough order history."
            />
          ) : (
            <div className="space-y-3 rounded-md border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-medium">Churn risk: </span>
                  <span className="capitalize">{data.score.churn_risk}</span>
                </div>
                <div
                  className="text-sm text-muted-foreground"
                  title="The recency, frequency, and spend scores added together — higher means a more valuable, active customer."
                >
                  Overall score:{' '}
                  <span className="font-semibold text-foreground tabular-nums">{data.score.composite_score}</span>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground" title="How recently they last bought — higher is more recent.">
                    Recency
                  </dt>
                  <dd className="font-medium tabular-nums">{data.score.recency_score}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground" title="How often they buy — higher is more often.">
                    Frequency
                  </dt>
                  <dd className="font-medium tabular-nums">{data.score.frequency_score}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground" title="How much they spend — higher is more.">
                    Spend
                  </dt>
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
                  <dd
                    className="font-medium tabular-nums"
                    title={data.score.days_since_last_order == null ? 'No orders recorded yet' : undefined}
                  >
                    {data.score.days_since_last_order ?? '—'}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
                <span>
                  Served by{' '}
                  {data.model ? (
                    <span className="font-medium text-foreground">
                      {data.model.name} {data.model.version} ({data.model.framework})
                    </span>
                  ) : (
                    <span className="italic">no production model registered</span>
                  )}
                  {' · '}
                  <span title="A tamper-proof reference for this exact prediction, kept in the audit log.">
                    prediction reference {data.prediction_id}
                  </span>
                </span>
                {brainId && (
                  <VerifyLink
                    href={`/customers/${encodeURIComponent(brainId)}`}
                    label="See this customer's records"
                  />
                )}
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

/**
 * ModelRegistryCard — the lifecycle-management table. Admin-only: promoting a model to production
 * retires the previous live model, so we gate it behind the workspace-admin roles (owner /
 * brand_admin). Non-admins see the customer-score serving surface but not the registry controls.
 */
function ModelRegistryCard() {
  const { data, isLoading, error, refetch } = useModels();
  const models = data?.models ?? [];
  const [modelsQ, setModelsQ] = React.useState('');

  const filteredModels = models.filter((m) =>
    matchesQuery(modelsQ, m.name, m.version, m.stage, m.framework),
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Model registry
            </CardTitle>
            {/* Not a time window — the registry is the current, complete set of models. State that
                honestly rather than implying a hidden date filter. */}
            <DataWindowBadge from={null} to={null} count={models.length} label="models" />
          </div>
          {models.length > 0 && (
            <TableSearch
              value={modelsQ}
              onChange={setModelsQ}
              placeholder="Search models…"
              aria-label="Search model registry"
            />
          )}
        </div>
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
              description="Models appear here once one is registered for this brand. The built-in buying-behaviour / churn model is set up automatically for every active brand."
            />
          ) : filteredModels.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground" role="status">
              No matching models for &ldquo;{modelsQ}&rdquo;.
            </p>
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
                  {filteredModels.map((m) => (
                    <ModelRow key={m.model_id} model={m} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </CardContent>
    </Card>
  );
}

export function MlContent() {
  const role = useSessionRole();
  const isAdmin = role === 'owner' || role === 'brand_admin';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Models"
        description="The prediction models Brain uses for this brand, and a way to look up any customer's buying-behaviour and churn scores. Promoting a model to production automatically retires the previous live model, so exactly one stays live."
      />

      {isAdmin ? (
        <ModelRegistryCard />
      ) : (
        <Card>
          <CardContent className="py-6">
            <div className="flex items-start gap-3 text-sm text-muted-foreground">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>
                Managing prediction models (promoting them through their lifecycle) is available to
                workspace admins. You can still look up any customer&apos;s scores below.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <CustomerScorePanel />
    </div>
  );
}
