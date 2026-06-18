'use client';

/**
 * DataQualityContent — Phase-7 Data Quality surface (BFF / metric-engine read only).
 *
 * Surfaces (requirement §5 / arch §3):
 *   - The trust verdict banner: "Estimated — excluded from billing/MMM" when the gate
 *     marks the metric Estimated/Untrusted; a quiet "Trusted" confirmation otherwise.
 *   - effective_confidence = min(cost_confidence, attribution_confidence) as a headline tile.
 *   - dq_grade coverage (the success metric) — graded / expected (category,target) pairs.
 *   - Freshness-SLA status (green / at-risk / breached) — icon + label, never colour-only.
 *   - Per-category × per-table grade matrix (semantic <table>, screen-reader readable).
 *   - Honest empty / loading / error states. Relates to the Data Health surface.
 *
 * INVARIANT: this view NEVER queries dq_check_result or StarRocks — it reads ONLY the
 * BFF route /api/v1/data-quality/summary (the metric-engine sole read path, I-ST01).
 * The summary carries GRADES, not money — there are no *_minor fields to format.
 */

import Link from 'next/link';
import { ShieldCheck, Gauge, Layers, Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  DqTrustBanner,
  FreshnessSlaBadge,
} from '@/components/analytics/dq-status';
import { DqGradeMatrix } from '@/components/analytics/dq-grade-matrix';
import { useDataQualitySummary } from '@/lib/hooks/use-analytics';

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground">Data Quality</h1>
      <p className="text-muted-foreground mt-1">
        Per-table check grades, freshness-SLA status, coverage, and the
        effective-confidence gate that governs billing and MMM eligibility.{' '}
        <Link
          href="/data/health"
          className="text-foreground underline underline-offset-2 hover:no-underline"
        >
          See ingestion health →
        </Link>
      </p>
    </div>
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
              description="Once a connector is linked and ingestion begins, the freshness, completeness, schema-validity and reconciliation checks will run and grades will appear here."
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
  const { cells, freshnessSla, coverage, effectiveConfidence, gate } = data;
  const coveragePct =
    coverage.expected > 0
      ? Math.round((coverage.graded / coverage.expected) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader />

      {/* The gate verdict — the headline honest signal */}
      <DqTrustBanner tier={gate.tier} effectiveConfidence={effectiveConfidence} />

      {/* Headline tiles — effective confidence, freshness-SLA, coverage */}
      <section aria-label="Data quality summary">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card
            className="p-5"
            role="region"
            aria-label={`Effective confidence: grade ${effectiveConfidence}, ${gate.tier}`}
          >
            <CardContent className="p-0 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                Effective Confidence
              </p>
              <p
                className="text-3xl font-bold text-foreground leading-tight tabular-nums"
                data-testid="dq-effective-confidence"
              >
                {effectiveConfidence}
              </p>
              <p className="text-xs text-muted-foreground">
                min(cost, attribution) confidence
              </p>
            </CardContent>
          </Card>

          <Card
            className="p-5"
            role="region"
            aria-label={`Freshness SLA status: ${freshnessSla.replace('_', ' ')}`}
          >
            <CardContent className="p-0 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                Freshness SLA
              </p>
              <div className="pt-1">
                <FreshnessSlaBadge status={freshnessSla} />
              </div>
              <p className="text-xs text-muted-foreground">
                Latest-row age vs the per-table SLA
              </p>
            </CardContent>
          </Card>

          <Card
            className="p-5"
            role="region"
            aria-label={`Grade coverage: ${coverage.graded} of ${coverage.expected} checks graded, ${coveragePct} percent`}
          >
            <CardContent className="p-0 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                Grade Coverage
              </p>
              <p
                className="text-3xl font-bold text-foreground leading-tight tabular-nums"
                data-testid="dq-coverage"
              >
                {coveragePct}%
              </p>
              <p className="text-xs text-muted-foreground">
                {coverage.graded} of {coverage.expected} checks graded
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Per-category × per-table grade matrix */}
      <section aria-label="Quality grade matrix">
        {cells.length > 0 ? (
          <DqGradeMatrix cells={cells} />
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
