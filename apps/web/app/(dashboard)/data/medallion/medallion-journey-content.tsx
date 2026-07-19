'use client';

/**
 * MedallionJourneyContent — the "Data Journey" observability view.
 *
 * A visual trace of a brand's data through the medallion pipeline, left-to-right:
 *   Bronze (ingestion) → Silver (canonicalization) → Identity (Neo4j) → Gold (marts) → Serving.
 *
 * Trust-building + plain-language + honest: every stage shows a freshness pill (text + glyph, never
 * colour-only), and each stage independently renders "No data yet" / "Neo4j unreachable" rather than
 * fabricating a 0 or a confident "healthy" over data that isn't there.
 *
 * LIVE monitor: useMedallionJourney refetches every 30s so the pipeline state updates in place.
 *
 * All non-trivial derivations (state → label/status, count/lag humanisers, fresh-vs-stale mart
 * tallies) live in the React-free medallion-journey-logic.ts module and are unit-tested there — this
 * component only renders from them, so the tests guard the real logic.
 */

import { useState } from 'react';
import {
  Database,
  Sparkles,
  Users,
  Boxes,
  MonitorSmartphone,
  ArrowRight,
  ChevronDown,
  Clock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { StatusPill } from '@/components/ui/status-pill';
import { MetricTitle } from '@/components/ui/metric-title';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import {
  formatRelativeTime,
  formatAbsoluteTime,
} from '@/components/analytics/data-health-relative-time';
import { useMedallionJourney } from '@/lib/hooks/use-medallion-journey';
import type { MedallionJourney } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import {
  stageVerdict,
  humanizeCount,
  humanizeLag,
  martTally,
  servingSummaryLabel,
} from './medallion-journey-logic';

function Header() {
  return (
    <PageHeader
      title="Data Journey"
      description="Follow your data as it moves through the pipeline — from raw events, to cleaned records, to the people behind them, to the business marts your dashboards read."
    />
  );
}

/** A stage's freshness pill, driven entirely by the pure stageVerdict helper. */
function StagePill({ state }: { state: string | null | undefined }) {
  const v = stageVerdict(state);
  return <StatusPill status={v.status} label={v.label} />;
}

/** One labelled number inside a stage card. Honest: null → "—" via humanizeCount. */
function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">
        {humanizeCount(value)}
      </span>
    </div>
  );
}

/** The shared shell every stage card uses — icon, title, plain-language subtitle, freshness pill. */
function StageCard({
  icon: Icon,
  title,
  subtitle,
  state,
  children,
}: {
  icon: typeof Database;
  title: string;
  subtitle: string;
  state: string | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col" role="region" aria-label={`${title} stage`}>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-sm font-semibold text-foreground">{title}</CardTitle>
        </div>
        <p className="text-xs leading-snug text-muted-foreground">{subtitle}</p>
        <StagePill state={state} />
      </CardHeader>
      <CardContent className="flex-1 space-y-2 pt-0">{children}</CardContent>
    </Card>
  );
}

/** The `→` connector between two stages — horizontal on lg, rotated (down) when stacked. */
function Connector() {
  return (
    <div className="flex items-center justify-center py-1 lg:py-0" aria-hidden="true">
      <ArrowRight className="size-5 rotate-90 text-muted-foreground/50 lg:rotate-0" />
    </div>
  );
}

// ── Stage bodies ────────────────────────────────────────────────────────────────

function BronzeBody({ bronze }: { bronze: MedallionJourney['bronze'] }) {
  return (
    <>
      <Stat label="Events landed" value={bronze.rowCount} />
      <p className="text-xs text-muted-foreground" title={formatAbsoluteTime(bronze.latestEventAt)}>
        Last event {formatRelativeTime(bronze.latestEventAt)}
      </p>
      <p className="font-mono text-[10px] text-muted-foreground/70" title={bronze.table}>
        {bronze.table}
      </p>
    </>
  );
}

function SilverBody({ silver }: { silver: MedallionJourney['silver'] }) {
  return (
    <>
      <Stat label="Events (keystone)" value={silver.keystone.rowCount} />
      <Stat label="Orders" value={silver.orderState.rowCount} />
      <Stat label="Ad spend rows" value={silver.marketingSpend.rowCount} />
      <p className="flex items-center gap-1 pt-1 text-xs text-muted-foreground">
        <Clock className="size-3" aria-hidden="true" />
        Watermark {humanizeLag(silver.watermark.lagSeconds)}
      </p>
    </>
  );
}

function IdentityBody({ identity }: { identity: MedallionJourney['identity'] }) {
  if (!identity.reachable) {
    return (
      <p className="text-xs text-muted-foreground">
        Neo4j unreachable — identity resolution is temporarily unavailable. People counts will
        return once the graph is reachable again.
      </p>
    );
  }
  return (
    <>
      <Stat label="People (brain IDs)" value={identity.brainIds} />
      <Stat label="Identifiers" value={identity.identifiers} />
      <Stat label="Links (edges)" value={identity.edges} />
    </>
  );
}

function GoldBody({ gold }: { gold: MedallionJourney['gold'] }) {
  return (
    <>
      {/* Customer 360 sub-card */}
      <div className="rounded-md border bg-muted/30 p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">Customer 360</span>
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {humanizeCount(gold.customer360.rowCount)}
          </span>
        </div>
        <FreshnessBadge timestamp={gold.customer360.freshnessAt} className="mt-0.5" />
      </div>

      {/* BI marts */}
      {gold.biMarts.length > 0 ? (
        <ul className="space-y-1.5">
          {gold.biMarts.map((m) => (
            <li key={m.name} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs text-muted-foreground" title={m.name}>
                {m.name}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs font-semibold tabular-nums text-foreground">
                  {humanizeCount(m.rowCount)}
                </span>
                <FreshnessBadge timestamp={m.freshnessAt} prefix="" />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No business marts built yet.</p>
      )}
    </>
  );
}

function ServingBody({ serving }: { serving: MedallionJourney['serving'] }) {
  const [expanded, setExpanded] = useState(false);
  const tally = martTally(serving.marts);
  return (
    <>
      <p className="text-sm font-semibold text-foreground">{servingSummaryLabel(tally)}</p>
      {tally.total > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
              aria-hidden="true"
            />
            {expanded ? 'Hide views' : `Show ${tally.total} view${tally.total === 1 ? '' : 's'}`}
          </button>
          {expanded && (
            <ul className="space-y-1.5 pt-1">
              {serving.marts.map((m) => (
                <li key={m.view} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={m.view}>
                    {m.view}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs font-semibold tabular-nums text-foreground">
                      {humanizeCount(m.rowCount)}
                    </span>
                    <StagePill state={m.state} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────────────────

function StageSkeleton() {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
    </Card>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function MedallionJourneyContent() {
  const { data, isLoading, error, refetch } = useMedallionJourney();

  if (error) {
    return (
      <div className="space-y-6">
        <Header />
        <ErrorCard error={error} retry={() => refetch()} />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch">
          <StageSkeleton />
          <Connector />
          <StageSkeleton />
          <Connector />
          <StageSkeleton />
          <Connector />
          <StageSkeleton />
          <Connector />
          <StageSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Header />

      <p
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        title={formatAbsoluteTime(data.generatedAt)}
      >
        <Clock className="size-3.5" aria-hidden="true" />
        <MetricTitle
          label={`Snapshot ${formatRelativeTime(data.generatedAt)}`}
          help="When this pipeline snapshot was taken. The page refreshes on its own every 30 seconds."
        />
      </p>

      {/* The flow: horizontal on lg, stacked on mobile. Connector arrows between stages. */}
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch">
        <StageCard
          icon={Database}
          title="Bronze"
          subtitle="Raw events as captured"
          state={data.bronze.state}
        >
          <BronzeBody bronze={data.bronze} />
        </StageCard>

        <Connector />

        <StageCard
          icon={Sparkles}
          title="Silver"
          subtitle="Cleaned & canonicalized"
          state={data.silver.state}
        >
          <SilverBody silver={data.silver} />
        </StageCard>

        <Connector />

        <StageCard
          icon={Users}
          title="Identity"
          subtitle="People resolved across sources (Neo4j)"
          state={data.identity.state}
        >
          <IdentityBody identity={data.identity} />
        </StageCard>

        <Connector />

        <StageCard
          icon={Boxes}
          title="Gold"
          subtitle="Business marts"
          state={data.gold.state}
        >
          <GoldBody gold={data.gold} />
        </StageCard>

        <Connector />

        <StageCard
          icon={MonitorSmartphone}
          title="Serving"
          subtitle="What the dashboards read"
          state={data.serving.state}
        >
          <ServingBody serving={data.serving} />
        </StageCard>
      </div>
    </div>
  );
}
