'use client';

/**
 * MetricsContent — the semantic metric catalog (Wave D) + the "prove this number" lineage surface
 * (Wave C), on one page.
 *
 * The catalog answers "what does Brain even mean by this metric?" — every metric is defined ONCE,
 * governed (owner, version, entity/grain, currency handling, identity basis), and listed honestly.
 * Selecting a metric drops the reusable MetricLineagePanel below it, which answers the follow-up a
 * skeptical operator always asks: "prove it — where does this number come from?"
 *
 * It reads ONLY via the metrics hooks (the metric-engine read path) — never a mart directly, never
 * an inlined client-side count:
 *   - useSemanticCatalog → the certified catalog (definitions + the per-brand semantic.serving flag).
 *   - MetricLineagePanel → useMetricLineage for the selected metric (lazy; only when one is picked).
 *
 * Honest states (Brain rule — no empty chart as success, no fabricated data):
 *   - catalog loading    → skeleton rows (aria-busy).
 *   - catalog error      → ErrorCard with retry.
 *   - empty metrics      → EmptyState (never a blank list dressed as success).
 *   - search miss        → an explained "no match" with a clear-search affordance.
 *   - no metric selected → a subtle prompt in the lineage slot, not a broken-looking void.
 *   - unknown lineage    → handled inside the panel as a gentle "not traceable yet" (NOT an error).
 */

import { useMemo, useState } from 'react';
import { Layers, ShieldCheck, GitBranch } from 'lucide-react';
import { TabShell } from '@/components/ui/tab-shell';
import { Card, CardContent } from '@/components/ui/card';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { TableSearch, filterRows } from '@/components/ui/table-search';
import { MetricLineagePanel } from '@/components/analytics/metric-lineage-panel';
import { plainLabel } from '@/lib/format/plain-language';
import { useSemanticCatalog } from '@/lib/hooks/use-metrics';
import type { SemanticMetricEntry } from '@/lib/api/types';

export function MetricsContent() {
  const catalogQ = useSemanticCatalog();
  // The metric whose lineage is being proved (null = none picked yet → subtle prompt below).
  const [selectedMetric, setSelectedMetric] = useState<string | null>(null);
  // Free-text filter over the already-loaded catalog rows (client-side; never re-fetches).
  const [query, setQuery] = useState('');

  const catalog = catalogQ.data;
  const metrics: SemanticMetricEntry[] = catalog?.metrics ?? [];

  // Search narrows the visible metrics across the human-meaningful columns (name · entity · desc).
  const visibleMetrics = useMemo(
    () => filterRows(metrics, query, ['name', 'entity', 'description']),
    [metrics, query],
  );

  return (
    <TabShell
      title="Metrics Catalog"
      description="Every metric Brain serves — defined once, governed, and traceable to source."
      freshness={
        catalog ? (
          <Badge
            variant={catalog.semantic_serving_flag ? 'success' : 'secondary'}
            data-testid="semantic-serving-flag"
          >
            <ShieldCheck className="size-3" aria-hidden="true" />
            Semantic serving: {catalog.semantic_serving_flag ? 'on' : 'off'}
          </Badge>
        ) : undefined
      }
      explainer={{
        title: 'Metrics Catalog — What does Brain mean by each number?',
        description:
          'The certified, governed catalog of every metric Brain serves — defined once — plus the lineage that traces any metric back to the exact source tables and jobs that build it.',
        sections: [
          {
            heading: 'Defined once, governed',
            body:
              'Each metric has a single canonical definition: its owner, version, the entity and grain it is measured at, how it handles currency, and which identity it is keyed on. No two surfaces can quietly disagree on what a metric means.',
          },
          {
            heading: 'Prove this number',
            body:
              'Select any metric to see its lineage — the exact Iceberg tables behind it, the brand-scoped row counts, and the Spark job versions that produced them. This is the audit trail that lets you verify a figure rather than trust it blindly.',
          },
          {
            heading: 'Honest about coverage',
            body:
              'Not every defined metric is wired to the measurement layer yet. When lineage is not available, we say so plainly and list the metrics that ARE traceable — never a fabricated trail.',
          },
        ],
        refreshCadence:
          'The catalog is generated from the semantic spec; lineage counts refresh on the regular analytics cycle.',
        sources: ['Semantic metric spec (Wave D)', 'Iceberg Gold/Silver marts + Spark job provenance'],
      }}
    >
      {/* ── 1. The semantic catalog — definitions, searchable, row-selectable ── */}
      <section aria-label="Semantic metric catalog" data-testid="metrics-catalog-section">
        <SectionCard
          title={
            <span className="flex items-center gap-2">
              <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
              Semantic metrics
            </span>
          }
          description="The single source of truth for what each metric means. Select one to prove its number."
          actions={
            metrics.length > 0 ? (
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {catalog?.count ?? metrics.length} metrics
                </span>
                <TableSearch
                  value={query}
                  onChange={setQuery}
                  placeholder="Search metrics…"
                  aria-label="Search metrics by name, entity or description"
                  className="sm:w-56"
                />
              </div>
            ) : undefined
          }
          flush
        >
          {catalogQ.isLoading ? (
            <div className="space-y-2 p-5" aria-busy="true" aria-label="Loading metrics…">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : catalogQ.error ? (
            <div className="p-5">
              <ErrorCard error={catalogQ.error} retry={catalogQ.refetch} />
            </div>
          ) : metrics.length === 0 ? (
            <EmptyState
              compact
              icon={<Layers />}
              title="No metrics defined yet"
              description="The semantic catalog is empty. Once the metric spec is generated for this brand, every governed metric will be listed here — we don't invent definitions."
            />
          ) : visibleMetrics.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground" role="status">
              No metrics match &ldquo;{query.trim()}&rdquo;.{' '}
              <button
                type="button"
                onClick={() => setQuery('')}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Clear search
              </button>
            </p>
          ) : (
            <ul className="divide-y divide-border" role="list">
              {visibleMetrics.map((m) => {
                const selected = m.name === selectedMetric;
                return (
                  <li key={m.name}>
                    {/* Whole row is the affordance — clicking selects it for the lineage panel below. */}
                    <button
                      type="button"
                      onClick={() => setSelectedMetric(m.name)}
                      aria-pressed={selected}
                      data-testid={`metric-row-${m.name}`}
                      className={
                        'flex w-full flex-col gap-1.5 px-5 py-3.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset' +
                        (selected ? ' bg-muted/60' : '')
                      }
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Human-readable name first (plain-language rule), raw id as a mono sub-label. */}
                        <span className="font-medium text-foreground">{plainLabel(m.name)}</span>
                        <code className="font-mono text-xs text-muted-foreground">{m.name}</code>
                        <Badge variant="outline">{plainLabel(m.entity)}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{m.description}</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs text-muted-foreground">
                        <span>
                          Owned by <span className="text-foreground">{m.owner}</span>
                        </span>
                        {m.grain.length > 0 && (
                          <span className="inline-flex flex-wrap items-center gap-1">
                            <span>Grain:</span>
                            {m.grain.map((g) => (
                              <Badge key={g} variant="secondary" className="font-mono">
                                {g}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </section>

      {/* ── 2. "Prove this number" — the lineage of the selected metric (lazy) ── */}
      <section aria-label="Metric lineage" data-testid="metrics-lineage-section">
        {selectedMetric ? (
          <MetricLineagePanel metric={selectedMetric} />
        ) : (
          <Card data-testid="metrics-lineage-prompt">
            <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <div
                className="flex size-11 items-center justify-center rounded-full border border-border bg-muted/60 text-muted-foreground"
                aria-hidden="true"
              >
                <GitBranch className="size-5" />
              </div>
              <p className="text-sm font-medium text-foreground">
                Select a metric to see how its number is built.
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Pick any metric above and Brain will trace it back to the exact source tables, row
                counts and jobs behind it.
              </p>
            </CardContent>
          </Card>
        )}
      </section>
    </TabShell>
  );
}
