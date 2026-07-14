'use client';

/**
 * DataQualityContent — Phase-7 Data Quality surface (BFF / metric-engine read only).
 *
 * Surfaces (requirement §5 / arch §3):
 *   - The trust verdict banner: plain-language "Estimated — not counted for billing"
 *     when the gate marks the metric Estimated/Untrusted; a quiet confirmation otherwise.
 *   - effective_confidence (displayed as "Data Trust Score" — display rename only, the
 *     API field is unchanged) as a headline tile with a plain sentence per grade band.
 *   - dq_grade coverage (the success metric) — graded / expected (category,target) pairs.
 *   - Freshness status (on time / falling behind / too old) — icon + label, never colour-only.
 *   - "What's holding your trust score back" — a plain-language list of the checks that are
 *     failing (raw table×category matrix retired), each named in words a shop owner reads,
 *     searchable, and drillable through to ingestion health.
 *   - Every metric title carries a plain-language "?" tooltip (MetricTitle).
 *   - Honest empty / loading / error states. Relates to the Data Health surface.
 *
 * INVARIANT: this view NEVER queries dq_check_result or StarRocks — it reads ONLY the
 * BFF route /api/v1/data-quality/summary (the metric-engine sole read path, I-ST01).
 * The summary carries GRADES, not money — there are no *_minor fields to format.
 */

import * as React from 'react';
import Link from 'next/link';
import { ShieldCheck, Gauge, Layers, Activity, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader as PageHeaderPrimitive } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricTitle } from '@/components/ui/metric-title';
import { DataWindowBadge } from '@/components/ui/data-window-badge';
import { TableSearch, filterRows } from '@/components/ui/table-search';
import { VerifyLink } from '@/components/ui/verify-link';
import {
  DqTrustBanner,
  FreshnessSlaBadge,
  DqGradeBadge,
} from '@/components/analytics/dq-status';
import { useDataQualitySummary } from '@/lib/hooks/use-analytics';
import { plainLabel } from '@/lib/format/plain-language';
import type { DqLetterGrade, DqGradeCell, DqCheckCategory } from '@/lib/api/types';

/**
 * Plain-language sentence per grade band — an honest mapping of the existing
 * A+/A/B/C/D grades the metric-engine computes (display only, never derived here).
 */
function gradeSentence(grade: DqLetterGrade): string {
  switch (grade) {
    case 'A+':
    case 'A':
      return 'Your data is complete and trustworthy.';
    case 'B':
      return 'Most data is complete; some metrics are estimates.';
    case 'C':
      return 'Significant data gaps exist; numbers should be treated as directional.';
    case 'D':
    default:
      return 'Large parts of your data are missing or unverified; treat these numbers with caution.';
  }
}

/**
 * Plain names for the data tables/topics the checks run against, so a raw code like
 * `silver.order_state` never reaches the DOM. Unknown targets fall back to the shared
 * plain-language humanizer (dots → spaces, then Title Case) — never the raw code.
 */
const TARGET_PLAIN: Record<string, string> = {
  bronze_events: 'Every tracked event',
  connector_sync_status: 'Your connected data sources',
  'silver.order_state': 'Your order records',
  'collector.event': 'Website & pixel activity',
  'bronze_vs_silver.order_state': 'Order totals (raw vs processed)',
};

function plainTarget(target: string): string {
  return TARGET_PLAIN[target] ?? plainLabel(target.replace(/\./g, ' '));
}

/**
 * Plain name + plain "what it verifies" + plain "why a failure matters" per check
 * category — so each row reads as a sentence a shop owner understands.
 */
const CATEGORY_META: Record<
  DqCheckCategory,
  { name: string; verifies: string; impact: string }
> = {
  freshness: {
    name: 'Up to date',
    verifies: 'whether this data is as recent as we promise',
    impact:
      'This data is older than our target, so your most recent activity may not be reflected in these numbers yet.',
  },
  completeness: {
    name: 'Nothing missing',
    verifies: 'whether any records are missing',
    impact:
      'Some records look like they are missing, so totals based on this may be undercounted.',
  },
  schema_validity: {
    name: 'Correct format',
    verifies: 'whether records arrive in the expected format',
    impact:
      'Some records arrived in an unexpected format and were set aside instead of counted.',
  },
  reconciliation: {
    name: 'Totals match',
    verifies: 'whether raw and processed totals agree',
    impact:
      'Raw and processed totals do not fully agree, so figures based on this may be slightly off.',
  },
};

/** Worst grade first (D → A+) so the biggest problems surface at the top. */
const GRADE_RANK: Record<DqLetterGrade, number> = {
  D: 0,
  C: 1,
  B: 2,
  A: 3,
  'A+': 4,
};

function PageHeader() {
  return (
    <PageHeaderPrimitive
      title="Data Quality"
      description={
        <>
          How much you can trust your numbers: check results for every table, data
          freshness, and the trust score that decides when your figures are reliable
          enough to bill against and model on.{' '}
          <Link
            href="/data/health"
            className="text-foreground underline underline-offset-2 hover:no-underline"
          >
            See ingestion health →
          </Link>
        </>
      }
    />
  );
}

/**
 * TrustBlockers — the plain-language replacement for the raw table×category grade
 * matrix. It lists, in words, the checks that are failing ("what is holding your trust
 * score back"), searchable, worst-first, each drillable to ingestion health. When
 * everything passes it renders an honest positive state, never a fake empty grid.
 */
function TrustBlockers({ cells }: { cells: DqGradeCell[] }) {
  const [query, setQuery] = React.useState('');

  // Failing checks are what hold the score back; passing ones are shown as reassurance.
  const failing = React.useMemo(
    () =>
      cells
        .filter((c) => !c.passing)
        .sort((a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade]),
    [cells],
  );
  const passing = React.useMemo(() => cells.filter((c) => c.passing), [cells]);

  const searchable = (c: DqGradeCell) =>
    `${plainTarget(c.target)} ${CATEGORY_META[c.category].name} ${CATEGORY_META[c.category].verifies} ${c.passing ? 'passing ok' : 'failing problem'}`;

  const visibleFailing = filterRows(failing, query, searchable);
  const visiblePassing = filterRows(passing, query, searchable);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            <MetricTitle
              label="What's holding your trust score back"
              help="The quality checks that are currently failing — fixing these raises your Data Trust Score. A is best, D is worst."
            />
          </CardTitle>
          <TableSearch
            value={query}
            onChange={setQuery}
            placeholder="Search checks…"
            aria-label="Search quality checks"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Failing checks — the blockers, worst first */}
        {failing.length === 0 ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-status-green-700/30 bg-status-green-50 p-3 text-sm text-status-green-700"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              <strong className="font-semibold">Nothing is holding your trust score back.</strong>{' '}
              All {cells.length} quality {cells.length === 1 ? 'check is' : 'checks are'} currently
              passing.
            </span>
          </div>
        ) : visibleFailing.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No failing checks match “{query}”.
          </p>
        ) : (
          <ul className="space-y-3" data-testid="dq-trust-blockers">
            {visibleFailing.map((c) => {
              const meta = CATEGORY_META[c.category];
              return (
                <li
                  key={`${c.category}:${c.target}`}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      {plainTarget(c.target)}
                      <span className="text-muted-foreground"> — {meta.name}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{meta.impact}</p>
                    <p className="text-xs text-muted-foreground/70 tabular-nums">
                      Measured {c.observed} against a target of {c.threshold}.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <DqGradeBadge grade={c.grade} passing={c.passing} />
                    <VerifyLink href="/data/health" label="See why" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Passing checks — quiet reassurance that the rest is healthy */}
        {visiblePassing.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
              {visiblePassing.length} {visiblePassing.length === 1 ? 'check is' : 'checks are'}{' '}
              passing — show
            </summary>
            <ul className="mt-2 space-y-1.5">
              {visiblePassing.map((c) => (
                <li
                  key={`${c.category}:${c.target}`}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs"
                >
                  <span className="text-foreground">
                    {plainTarget(c.target)}
                    <span className="text-muted-foreground"> — {CATEGORY_META[c.category].name}</span>
                  </span>
                  <DqGradeBadge grade={c.grade} passing={c.passing} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

export function DataQualityContent() {
  const { data, isLoading, error, refetch } = useDataQualitySummary();

  // ── Error ──────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <ErrorCard error={error} retry={() => refetch()} />
      </div>
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Skeleton className="h-16 w-full rounded-lg" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  // ── Empty (honest — no checks have run yet) ─────────────────────────────────
  if (!data || data.state === 'no_data') {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="No data-quality grades yet"
              description="Once a data source is connected and events begin arriving, the freshness, completeness, format and reconciliation checks will run and grades will appear here."
              icon={<ShieldCheck className="h-8 w-8" />}
              action={
                <Link
                  href="/settings/connectors"
                  className="inline-flex items-center rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90"
                  data-testid="dq-empty-cta"
                >
                  Connect a data source →
                </Link>
              }
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Has data ────────────────────────────────────────────────────────────────
  const { grades: cells, freshnessSla, coverage, effectiveConfidence, gate } = data;
  const coveragePct =
    coverage.expected > 0
      ? Math.round((coverage.graded / coverage.expected) * 100)
      : 0;

  // The window these grades cover: earliest → latest check run (honest, from the data).
  // Point-in-time "latest grade per check", so we surface the real check span, not a
  // fabricated date range or a control the endpoint can't honour.
  const checkedTimes = cells
    .map((c) => new Date(c.checkedAt).getTime())
    .filter((t) => Number.isFinite(t));
  const windowFrom =
    checkedTimes.length > 0 ? new Date(Math.min(...checkedTimes)).toISOString() : null;
  const windowTo =
    checkedTimes.length > 0 ? new Date(Math.max(...checkedTimes)).toISOString() : null;

  return (
    <div className="space-y-6">
      <PageHeader />

      {/* The gate verdict — the headline honest signal */}
      <DqTrustBanner tier={gate.tier} effectiveConfidence={effectiveConfidence} />

      {/* The window these check results cover — always visible near the top */}
      <DataWindowBadge
        from={windowFrom}
        to={windowTo}
        count={cells.length}
        label={cells.length === 1 ? 'check' : 'checks'}
      />

      {/* Headline tiles — trust score, freshness, coverage */}
      <section aria-label="Data quality summary">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card
            className="p-5"
            role="region"
            aria-label={`Data Trust Score: grade ${effectiveConfidence}, ${gate.tier}`}
          >
            <CardContent className="p-0 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                <MetricTitle
                  label="Data Trust Score"
                  help="Based on how many events pass validation and identity matching."
                />
              </p>
              <p
                className="text-3xl font-bold text-foreground leading-tight tabular-nums"
                data-testid="dq-effective-confidence"
              >
                {effectiveConfidence}
              </p>
              <p className="text-xs text-muted-foreground">
                {gradeSentence(effectiveConfidence)}
              </p>
            </CardContent>
          </Card>

          <Card
            className="p-5"
            role="region"
            aria-label={`Data freshness: ${freshnessSla.replace('_', ' ')}`}
          >
            <CardContent className="p-0 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                <MetricTitle
                  label="Data freshness"
                  help="Whether the newest data in each table is as recent as Brain promises it to be."
                />
              </p>
              <div className="pt-1">
                <FreshnessSlaBadge status={freshnessSla} />
              </div>
              <p className="text-xs text-muted-foreground">
                How recent the newest data is versus our target
              </p>
            </CardContent>
          </Card>

          <Card
            className="p-5"
            role="region"
            aria-label={`Checks completed: ${coverage.graded} of ${coverage.expected} checks graded, ${coveragePct} percent`}
          >
            <CardContent className="p-0 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                <MetricTitle
                  label="Checks completed"
                  help="How many of the planned data-quality checks have produced a result."
                />
              </p>
              <p
                className="text-3xl font-bold text-foreground leading-tight tabular-nums"
                data-testid="dq-coverage"
              >
                {coveragePct}%
              </p>
              <p className="text-xs text-muted-foreground">
                {coverage.graded} of {coverage.expected} checks completed
              </p>
              <VerifyLink href="#dq-checks" label="See the checks" />
            </CardContent>
          </Card>
        </div>
      </section>

      {/* "What's holding your trust score back" — plain list replacing the raw matrix */}
      <section id="dq-checks" aria-label="What's holding your trust score back">
        {cells.length > 0 ? (
          <TrustBlockers cells={cells} />
        ) : (
          <Card>
            <CardContent className="pt-6">
              <EmptyState
                title="No graded checks in this window"
                description="Checks are scheduled but have not produced a grade yet. They run on an interval — check back shortly."
                icon={<ShieldCheck className="h-8 w-8" />}
              />
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
