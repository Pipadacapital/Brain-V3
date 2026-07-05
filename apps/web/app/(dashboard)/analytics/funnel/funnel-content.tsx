'use client';

/**
 * FunnelContent — the storefront conversion-funnel surface (Silver tier, Phase H pixel).
 *
 * Reads ONLY via the BFF /api/v1/analytics/funnel (the metric-engine storefront-funnel seam over
 * silver_touchpoint, I-ST01) — never StarRocks/SQL directly. Shows session reach at each stage
 * (sessions → product views → cart adds → purchases) with conversion % vs the funnel top and the
 * step-over-previous drop-off.
 *
 * Honest states: skeleton (aria-busy), ErrorCard with request_id, and an honest empty state linking
 * to pixel setup — never a fabricated zero. Counts are integer (bigint→string); percentages are 2dp
 * strings from the engine (never re-divided with floats here).
 */

import { useState } from 'react';
import Link from 'next/link';
import { Filter, ArrowRight, Users, ChevronRight, TrendingDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { MetricTitle } from '@/components/ui/metric-title';
import { Tooltip } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { relativeTime } from '@/lib/format/relative-time';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { DateRangeFilter, initialRange, type DateRange } from '@/components/ui/date-range-filter';
import { useFunnelAnalytics, useFunnelUsers } from '@/lib/hooks/use-analytics';
import type { AnalyticsFunnelResponse, FunnelStep } from '@/lib/api/types';

type FunnelHasData = Extract<AnalyticsFunnelResponse, { state: 'has_data' }>;

// Plain-language labels for the stage keys emitted by the engine.
// NOTE: the endpoint emits four stages — there is no "Checkout started" stage in its
// payload (that step exists only in the per-visitor furthest_step enum below).
const STAGE_LABELS: Record<string, string> = {
  sessions: 'Visit',
  product_viewed: 'Product view',
  cart_added: 'Add to cart',
  purchased: 'Purchase',
};

/**
 * Maps the storefront-funnel stage key (engine vocabulary) to the per-visitor mart's furthest_step
 * enum (gold_funnel_user vocabulary). A stage is drillable iff it has a mapping — clicking it opens
 * the "who dropped here" panel for visitors whose furthest_step is exactly that step.
 */
const STAGE_TO_STEP: Record<string, FunnelStep> = {
  sessions: 'session',
  product_viewed: 'product_view',
  cart_added: 'cart',
  purchased: 'purchase',
};

// Plain-language labels for the per-visitor furthest_step enum (drill-down title + table cell).
const STEP_LABELS: Record<FunnelStep, string> = {
  session: 'Visit',
  product_view: 'Product view',
  cart: 'Add to cart',
  checkout: 'Checkout started',
  purchase: 'Purchase',
};

const DRILLDOWN_PAGE_SIZE = 20;

/**
 * Relative "last seen" (plain-language rule 4 — relative first) with the absolute
 * timestamp in the title attr; an honest "—" when the timestamp is missing/unparseable.
 */
function LastSeen({ iso }: { iso: string | null }) {
  const t = relativeTime(iso, Number.POSITIVE_INFINITY);
  if (!t.absolute) return <span>—</span>;
  return <span title={t.absolute}>{t.label}</span>;
}

function num(s: string): string {
  return Number(s).toLocaleString('en-IN');
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading conversion funnel…">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function EmptyCard() {
  return (
    <Card data-testid="funnel-empty">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <Filter className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No funnel activity yet</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            The conversion funnel appears once the Brain Pixel captures sessions, product views, and
            cart adds — and orders are stitched back to those sessions. It builds from the journey
            touchpoints in the Silver tier.
          </p>
        </div>
        <Link href="/settings/pixel">
          <Button variant="outline" size="sm">
            Set up the Brain Pixel
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

/** Trim a display percentage like 84.50 → "84.5" (display-only — never money math). */
function fmtPct(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Find the step with the LARGEST drop-off: for each stage after the first with a
 * step_pct, the leave-% is 100 − step_pct (share of the previous step that did NOT
 * continue). Returns null when no stage has a computable step_pct — the callout then
 * simply doesn't render (never a fabricated number).
 */
function biggestDropOff(
  stages: FunnelHasData['stages'],
): { index: number; leavePct: number; fromLabel: string; toLabel: string } | null {
  let best: { index: number; leavePct: number; fromLabel: string; toLabel: string } | null = null;
  stages.forEach((s, i) => {
    if (i === 0 || s.step_pct === null) return;
    const leavePct = 100 - Number(s.step_pct);
    if (leavePct <= 0) return;
    if (!best || leavePct > best.leavePct) {
      best = {
        index: i,
        leavePct,
        fromLabel: STAGE_LABELS[stages[i - 1].key] ?? stages[i - 1].key,
        toLabel: STAGE_LABELS[s.key] ?? s.key,
      };
    }
  });
  return best;
}

function FunnelBars({
  stages,
  onSelectStep,
}: {
  stages: FunnelHasData['stages'];
  onSelectStep: (step: FunnelStep) => void;
}) {
  const dropOff = biggestDropOff(stages);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          <MetricTitle
            label="Conversion funnel"
            help="How many visits made it to each step on the way to a purchase."
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3" aria-label="Conversion funnel stages">
          {stages.map((s, i) => {
            const widthPct = Math.min(100, Number(s.conversion_pct ?? 0));
            const step = STAGE_TO_STEP[s.key];
            const label = STAGE_LABELS[s.key] ?? s.key;
            const isBiggestDrop = dropOff !== null && dropOff.index === i;
            // step_pct = share of the PREVIOUS step that continued to this one.
            const continuedPct = i > 0 && s.step_pct !== null ? s.step_pct : null;
            const bar = (
              <>
                <div className="flex items-center justify-between gap-2 text-sm mb-1">
                  <span className="text-foreground inline-flex items-center gap-1.5">
                    {label}
                    {isBiggestDrop && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-warning-subtle px-1.5 py-0.5 text-[10px] font-medium text-warning-subtle-foreground">
                        <TrendingDown className="h-2.5 w-2.5" aria-hidden="true" />
                        Biggest drop-off
                      </span>
                    )}
                    {step && (
                      <ChevronRight
                        className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {num(s.sessions)}
                    {continuedPct !== null && (
                      <Tooltip content="Of the visitors who reached the previous step, the share that continued to this one.">
                        <span className="ml-2 text-xs" tabIndex={0}>
                          {continuedPct}% continued
                        </span>
                      </Tooltip>
                    )}
                  </span>
                </div>
                <div className="h-3 rounded bg-muted overflow-hidden" aria-hidden="true">
                  <div
                    className={isBiggestDrop ? 'h-full bg-warning' : 'h-full bg-foreground/70'}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </>
            );
            return (
              <li key={s.key}>
                {step ? (
                  <button
                    type="button"
                    onClick={() => onSelectStep(step)}
                    className={`group w-full rounded-md px-2 py-1 -mx-2 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isBiggestDrop ? 'bg-warning-subtle/40' : ''
                    }`}
                    aria-label={`See the visitors who left at "${label}"`}
                    data-testid={`funnel-step-${step}`}
                  >
                    {bar}
                  </button>
                ) : (
                  <div className={`px-2 py-1 -mx-2 ${isBiggestDrop ? 'rounded-md bg-warning-subtle/40' : ''}`}>
                    {bar}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {dropOff && (
          <p
            className="mt-3 flex items-center gap-1.5 rounded-md bg-warning-subtle px-2.5 py-1.5 text-sm font-medium text-warning-subtle-foreground"
            data-testid="funnel-biggest-dropoff"
          >
            <TrendingDown className="h-4 w-4 shrink-0" aria-hidden="true" />
            Biggest drop-off: {fmtPct(dropOff.leavePct)}% leave between {dropOff.fromLabel} and{' '}
            {dropOff.toLabel}.
          </p>
        )}

        <p className="mt-3 text-xs text-muted-foreground">
          Tip: click any step to see the visitors who left there.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * FunnelStepDrilldown — the per-step "who dropped here" panel. Lists the visitors whose furthest
 * reached step is exactly `step` within the page's window (gold_funnel_user via useFunnelUsers),
 * in a small paginated table. Honest EmptyState when the step/window has nobody.
 */
function FunnelStepDrilldown({
  step,
  range,
  onClose,
}: {
  step: FunnelStep | null;
  range: DateRange;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  // Reset to page 1 whenever the selected step changes.
  const [lastStep, setLastStep] = useState<FunnelStep | null>(step);
  if (step !== lastStep) {
    setLastStep(step);
    setPage(1);
  }

  const q = useFunnelUsers({
    step: step ?? undefined,
    date_start: range.from,
    date_end: range.to,
    page,
    page_size: DRILLDOWN_PAGE_SIZE,
  });
  const data = q.data;
  const open = step !== null;

  const total = data ? Number(data.total ?? 0) : 0;
  const totalPages = Math.max(1, Math.ceil(total / DRILLDOWN_PAGE_SIZE));
  const visitors = data?.state === 'has_data' ? data.visitors : [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Stopped at “{step ? STEP_LABELS[step] : ''}”
          </DialogTitle>
          <DialogDescription>
            Visitors who got this far and no further, between {range.from} and {range.to}.
            {total > 0 && ` ${total.toLocaleString('en-IN')} visitor${total === 1 ? '' : 's'}.`}
          </DialogDescription>
        </DialogHeader>

        {q.isLoading && (
          <div className="space-y-2" aria-busy="true" aria-label="Loading visitors…">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}

        {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}

        {!q.isLoading && !q.error && data?.state === 'no_data' && (
          <EmptyState
            compact
            icon={<Users />}
            title="No visitors dropped here"
            description="No visitor's journey ended at this step in the selected window — try a wider date range, or check that the Brain Pixel is capturing sessions."
          />
        )}

        {!q.isLoading && !q.error && data?.state === 'has_data' && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Visitor</TableHead>
                  <TableHead>How far they got</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visitors.map((v) => (
                  <TableRow key={v.visitor_id}>
                    <TableCell className="font-mono text-xs">{v.visitor_id}</TableCell>
                    <TableCell>{STEP_LABELS[v.furthest_step] ?? v.furthest_step}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <LastSeen iso={v.last_seen_at} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-muted-foreground tabular-nums">
                  Page {page} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1 || q.isFetching}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages || q.isFetching}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function FunnelContent() {
  const [range, setRange] = useState<DateRange>(() => initialRange());

  const q = useFunnelAnalytics({ from: range.from, to: range.to });
  const data = q.data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Funnel"
        description="How visits turn into purchases — from browsing to viewing a product, adding to cart, and buying — captured by the Brain Pixel and matched to orders."
        meta={
          <span
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Read from the Silver tier (silver_touchpoint) via the metric-engine storefront-funnel seam."
          >
            <Filter className="h-3 w-3" aria-hidden="true" />
            Powered by the Silver tier
          </span>
        }
      />

      <section aria-label="Conversion funnel">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">Storefront conversion</h2>
          <DateRangeFilter value={range} onChange={setRange} aria-label="Funnel date range" />
        </div>

        {q.isLoading && <Loading />}
        {!q.isLoading && q.error && <ErrorCard error={q.error} retry={q.refetch} />}
        {!q.isLoading && !q.error && data?.state === 'no_data' && <EmptyCard />}
        {!q.isLoading && !q.error && data?.state === 'has_data' && (
          <FunnelData data={data} range={range} />
        )}
      </section>
    </div>
  );
}

function FunnelData({ data, range }: { data: FunnelHasData; range: DateRange }) {
  const [selectedStep, setSelectedStep] = useState<FunnelStep | null>(null);
  const byKey = (k: string) => data.stages.find((s) => s.key === k);
  const sessions = byKey('sessions');
  const purchased = byKey('purchased');
  const cart = byKey('cart_added');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Visits"
          help="How many browsing sessions your store had in the selected period."
          value={sessions ? num(sessions.sessions) : null}
          sublabel={`${data.from} → ${data.to}`}
        />
        <KpiTile
          label="Add-to-cart rate"
          help="Of all visits, the share where the shopper added something to their cart."
          value={cart?.conversion_pct !== undefined && cart?.conversion_pct !== null ? `${cart.conversion_pct}%` : null}
          sublabel="visits that added to cart"
        />
        <KpiTile
          label="Purchase rate"
          help="Of all visits, the share that ended in a purchase."
          value={purchased?.conversion_pct !== undefined && purchased?.conversion_pct !== null ? `${purchased.conversion_pct}%` : null}
          sublabel="visits that ended in a purchase"
        />
      </div>

      <FunnelBars stages={data.stages} onSelectStep={setSelectedStep} />

      <FunnelStepDrilldown
        step={selectedStep}
        range={range}
        onClose={() => setSelectedStep(null)}
      />
    </div>
  );
}
