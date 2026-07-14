'use client';

/**
 * MetricLineagePanel — the reusable "prove this number" trust surface (Wave C, metric lineage).
 *
 * Given a metric id, it traces the number back to the exact Iceberg tables that produce it, the
 * brand + as-of scoped row counts behind it, and the Spark job version(s) that built it. This is
 * the audit trail that lets a user verify ANY figure Brain serves — not a chart, an accounting of
 * where the number came from.
 *
 * It reads ONLY via useMetricLineage (the metric-engine lineage endpoint) — it never queries a
 * mart directly and never re-derives a count client-side. The row counts shown are exactly what the
 * engine returned (brand-scoped, honest 0 for a table that hasn't materialized).
 *
 * Honest states (Brain rule — never make an empty look like a success or an error):
 *   - loading            → a quiet "Tracing lineage…" (aria-busy), not a spinner-as-content.
 *   - isError            → ErrorCard (a real fetch failure the user may retry).
 *   - state 'unknown_metric' → a GENTLE note, NOT an error: this semantic metric simply isn't wired
 *                          to the measurement layer yet. We list the metrics that ARE traceable so
 *                          the honesty is actionable, not a dead end.
 *   - state 'ok'         → the lineage table: table · role · row count · provenance · date column.
 *
 * Reusable: drop it anywhere a number needs to be defended — `{ metric, date? }`. `date` (YYYY-MM-DD)
 * scopes the row counts as-of that day; omitted/null = all-time counts.
 */

import { Database, GitBranch, ShieldCheck, Layers } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SectionCard } from '@/components/ui/section-card';
import { ErrorCard } from '@/components/ui/error-card';
import { Badge } from '@/components/ui/badge';
import { plainLabel } from '@/lib/format/plain-language';
import { useMetricLineage } from '@/lib/hooks/use-metrics';
import type { MetricLineageFact } from '@/lib/api/types';

/** `schema.table` in mono — the physical identity of the fact (never hidden behind a label alone). */
function factTableRef(fact: MetricLineageFact): string {
  return `${fact.schema}.${fact.table}`;
}

export function MetricLineagePanel({
  metric,
  date,
}: {
  metric: string;
  date?: string | null;
}) {
  // Disabled until a metric id exists (the hook guards on Boolean(metric)); `date` scopes the counts.
  const lineageQ = useMetricLineage(metric, date ?? null);
  const data = lineageQ.data;

  // ── Loading — a calm status line, not an empty chart ──
  if (lineageQ.isLoading || !data) {
    return (
      <Card aria-busy="true" aria-label="Tracing lineage…" data-testid="metric-lineage-loading">
        <CardContent className="py-8 text-center text-sm text-muted-foreground" role="status">
          Tracing lineage…
        </CardContent>
      </Card>
    );
  }

  // ── Real fetch failure — retryable ──
  if (lineageQ.isError) {
    return <ErrorCard error={lineageQ.error} retry={lineageQ.refetch} />;
  }

  // ── Honest "not traceable yet" — a GENTLE note, deliberately NOT styled as an error ──
  if (data.state === 'unknown_metric') {
    return (
      <Card data-testid="metric-lineage-unknown">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <GitBranch className="size-4" aria-hidden="true" />
            Lineage for {plainLabel(data.metric)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This metric&apos;s lineage isn&apos;t wired to the measurement layer yet. It&apos;s a
            defined, governed metric — but we can&apos;t yet trace its number back to specific source
            tables, so we say so rather than show a made-up trail.
          </p>
          {data.supported.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">
                These metrics ARE traceable to source today:
              </p>
              <div className="flex flex-wrap gap-1.5" data-testid="metric-lineage-supported">
                {data.supported.map((name) => (
                  <Badge key={name} variant="outline" className="font-mono">
                    {name}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── state === 'ok' — the audit trail: how the number is built, fact by fact ──
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
          How this number is built
        </span>
      }
      description={data.description}
      meta={
        data.date ? (
          <span className="text-xs text-muted-foreground">
            Counts as of <span className="font-mono">{data.date}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">All-time counts</span>
        )
      }
      footer={
        data.traces_to_measurement ? (
          <span className="inline-flex items-center gap-1.5 text-success-subtle-foreground">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Traces to measurement: yes
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Layers className="size-4" aria-hidden="true" />
            Definitional only — not yet traced to the measurement layer.
          </span>
        )
      }
      data-testid="metric-lineage-ok"
    >
      {data.facts.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground" role="status">
          No source facts are recorded for this metric.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.facts.map((fact) => (
            <li
              key={fact.fqtn}
              className="rounded-lg border border-border p-4 space-y-2"
              data-testid={`metric-lineage-fact-${fact.table}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  {/* Physical table identity — schema.table in mono, never hidden behind a label. */}
                  <p className="flex items-center gap-1.5 font-mono text-sm text-foreground">
                    <Database className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    {factTableRef(fact)}
                  </p>
                  {/* What this fact contributes to the metric (the human "role"). */}
                  <p className="text-sm text-muted-foreground">{fact.role}</p>
                </div>
                <div className="shrink-0 text-right">
                  {/* Brand + as-of scoped — labelled so the user knows the scope of the number. */}
                  <p className="text-sm font-semibold tabular-nums text-foreground">
                    {fact.row_count.toLocaleString()} rows
                  </p>
                  <p className="text-xs text-muted-foreground">this brand</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                {/* Provenance — the Spark job version(s) that produced this fact. */}
                {fact.job_versions.length > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-medium text-foreground">Built by</span>
                    <span className="font-mono">{fact.job_versions.join(', ')}</span>
                    <span className="text-muted-foreground">({fact.job_version_source})</span>
                  </span>
                )}
                {/* The date column filtered for the as-of read, when present. */}
                {fact.date_column && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-medium text-foreground">As-of column</span>
                    <span className="font-mono">{fact.date_column}</span>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
