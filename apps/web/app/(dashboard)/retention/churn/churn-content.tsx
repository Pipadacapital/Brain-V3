'use client';

/**
 * ChurnContent — Retention sub-tab "Who is about to leave, and what do I do?".
 *
 * Pure REUSE of existing surfaces (no new backend — web-only slice):
 *   - useCustomers({ segment }) — the SAME customer browse the /customers tab uses, filtered
 *     server-side (RLS, brand from session) to the at-risk / churned RFM band folded from
 *     gold_customer_scores. Each row already carries customer_ref (the public BRN- identity),
 *     segment, lifetime value (bigint MINOR + currency), order count and last_identifier_at
 *     (last-active) — no per-row PII. The churn-risk BAND is derived from that segment
 *     (riskFromSegment) so the "Churn risk" column is filled by default, no serving required.
 *   - useCustomerScore(brain_id) — the deterministic RFM/churn served score per customer. This
 *     SERVES on demand and logs a prediction_log row, so we DO NOT auto-fire it for the whole
 *     page: the "Load churn scores" toggle gates it (default off). When on, each visible row is
 *     ENRICHED with the precise days-since-last-order (the band itself is already shown).
 *   - useSavedSegments / usePreviewSegment / useCreateSegment — the P2 saved-segments surface.
 *     "Create win-back" opens a dialog PRE-FILLED with a win-back segment definition for the
 *     active band, previews the matched customer count (no persistence), then persists it as a
 *     saved segment (the durable, replayable RULE — Brain has no member-list precompute).
 *
 * Honesty: money is bigint minor units + currency_code, formatted ONLY via formatMoneyDisplay and
 * NEVER summed across rows (mixed currencies must not blend). "Churn risk" is the deterministic RFM
 * band (a risk band, never a fabricated float probability). Empty band → EmptyState; a missing
 * per-row signal → an em-dash, never a fake 0.
 *
 * WIN-BACK STUB: this view creates the win-back SEGMENT (the durable artifact). Actually executing
 * the win-back (a recommendation-action ledger entry / campaign send) is the next step and is NOT
 * wired here — doing so needs a recommendation row + backend action, out of scope for this web-only
 * slice. The saved segment is the honest, reversible stub the operator acts on.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  HeartCrack,
  AlertTriangle,
  UserMinus,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Bookmark,
} from 'lucide-react';
import type { CurrencyCode } from '@brain/money';
import { brainRef } from '@brain/contracts';
import { TabShell } from '@/components/ui/tab-shell';
import { SectionCard } from '@/components/ui/section-card';
import { MetricTitle } from '@/components/ui/metric-title';
import { MetricCard } from '@/components/ui/metric-card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toaster';
import { humanize } from '@/lib/format/humanize';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { relativeTime } from '@/lib/format/relative-time';
import { useCustomers } from '@/lib/hooks/use-identity';
import { useCustomerScore } from '@/lib/hooks/use-ml';
import {
  useSavedSegments,
  usePreviewSegment,
  useCreateSegment,
} from '@/lib/hooks/use-segments';
import type { CustomerListItem } from '@/lib/api/types';

const PAGE_SIZE = 20;

/** The two churn-facing RFM bands the deterministic ladder folds into gold_customer_scores. */
const BANDS = [
  {
    value: 'at_risk',
    label: 'At-Risk',
    description: 'Recency slipping — still saveable. Win them back before they lapse.',
    tone: 'warning' as StatusTone,
    icon: AlertTriangle,
  },
  {
    value: 'churned',
    label: 'Churned',
    description: 'Past the churn threshold. Reactivation is the play.',
    tone: 'destructive' as StatusTone,
    icon: HeartCrack,
  },
] as const;

type BandValue = (typeof BANDS)[number]['value'];

const EXPLAINER = {
  title: 'Churn risk — Who is about to leave, and what do I do?',
  description:
    'The customer list filtered to the at-risk and churned RFM bands, with each customer’s churn-risk signal, lifetime value and last-active time — plus a one-click win-back segment so you can act on the cohort.',
  metrics: [
    {
      name: 'Band (At-Risk / Churned)',
      definition:
        'The lifecycle band based on how recently, how often, and how much a customer buys. At-Risk = slipping but saveable; Churned = past the churn threshold.',
      howComputed:
        'Assigned by fixed rules from each customer’s own order history — the same history always gives the same band. Only your brand’s customers are ever shown.',
    },
    {
      name: 'Churn risk',
      definition:
        'The per-customer churn-risk band (a risk BAND, never a made-up probability). Shown for every row by default; turning on scores adds the exact days since the last order.',
      howComputed:
        'The band comes straight from each customer’s RFM group in the list (High risk = churned, Elevated = at-risk). Turning on “Load churn scores” looks up the exact days-since-last-order per customer — each lookup is logged. A customer with no order history yet shows “not enough history”, never a blank.',
    },
    {
      name: 'Lifetime value',
      definition: 'Total confirmed revenue from this customer to date.',
      howComputed:
        'Added up from the customer’s orders, always within one currency — never summed across customers with different currencies.',
    },
    {
      name: 'Last active',
      definition: 'When the customer was most recently seen — an order, a visit, or a contact detail.',
      howComputed: 'The latest recorded activity, shown as a relative time; a dash when unknown.',
    },
  ],
  sections: [
    {
      heading: 'Create win-back',
      body: 'Pre-fills a saved segment for the active band (e.g. “Win-back — At-Risk”). The dialog previews how many customers match WITHOUT persisting, then saves it as a reusable RULE (Brain stores segments as their definition, never a frozen member list). Executing the win-back — a campaign send / recommendation-action ledger entry — is the next step and is intentionally not wired here.',
    },
    {
      heading: 'Privacy',
      body: 'Only your brand’s customers are shown. Rows carry counts, segment, value and last-active only — raw email and phone stay locked away. Click a Brain ID to open the full Customer Profile.',
    },
  ],
  refreshCadence:
    'Band membership, value and per-row churn scores refresh on the regular analytics cycle. The list itself is read live each time.',
  sources: [
    'Your customer list, filtered to the at-risk and churned bands',
    'Customer scores built from order history',
    'Your saved win-back segments',
  ],
};

/** Map a churn-risk band string → a status tone (high→destructive, medium→warning, low→success). */
function riskTone(risk: string): StatusTone {
  const r = risk.toLowerCase();
  if (r.includes('high') || r === 'churned') return 'destructive';
  if (r.includes('medium') || r.includes('elev') || r === 'at_risk') return 'warning';
  if (r.includes('low') || r.includes('healthy')) return 'success';
  return 'neutral';
}

/**
 * Derive the plain-language churn-risk band from the RFM segment the customer list ALREADY returns
 * (folded from gold_customer_scores) — no per-row score serving, so the "Churn risk" column is never
 * blank by default. Churned = past the threshold (High risk); At-Risk = slipping (Elevated risk).
 * A null segment (no score row yet) → null, which the row renders as an honest "not enough history".
 */
function riskFromSegment(segment: string | null): { label: string; tone: StatusTone } | null {
  if (!segment) return null;
  const s = segment.toLowerCase();
  if (s === 'churned') return { label: 'High risk', tone: 'destructive' };
  if (s === 'at_risk') return { label: 'Elevated risk', tone: 'warning' };
  // Any other band that surfaces here (defensive) — reflect it plainly, never blank.
  return { label: humanize(segment), tone: riskTone(segment) };
}

/** Prefer the customer's public BRN- reference over the raw brain_id UUID for a recognizable identity. */
function customerLabel(c: CustomerListItem): string {
  return c.customer_ref ?? brainRef(c.brain_id) ?? c.brain_id;
}

export function ChurnContent() {
  const [band, setBand] = React.useState<BandValue>('at_risk');
  const [offset, setOffset] = React.useState(0);
  const [showScores, setShowScores] = React.useState(false);
  const [winBackOpen, setWinBackOpen] = React.useState(false);

  const activeBand = BANDS.find((b) => b.value === band) ?? BANDS[0];

  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useCustomers({
    segment: band,
    limit: PAGE_SIZE,
    offset,
  });

  const savedQ = useSavedSegments();
  // Saved segments this view authored (definition.kind === 'churn_winback').
  const winBackSegments = React.useMemo(
    () =>
      (savedQ.data?.segments ?? []).filter(
        (s) => (s.definition as Record<string, unknown> | undefined)?.kind === 'churn_winback',
      ),
    [savedQ.data],
  );

  function onBand(next: BandValue) {
    setOffset(0);
    setBand(next);
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  // No generated_at on the list read — the react-query fetch time is an honest "read live at".
  const listFetchedIso = dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null;

  return (
    <TabShell
      title="Churn risk"
      description="Who is about to leave, and what do I do?"
      eyebrow={
        <Link
          href="/retention"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Retention
        </Link>
      }
      explainer={EXPLAINER}
      freshness={<FreshnessBadge timestamp={listFetchedIso} prefix="Read" />}
      actions={
        <Button onClick={() => setWinBackOpen(true)} disabled={total === 0}>
          <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
          Create win-back
        </Button>
      }
    >
      {/* ── Headline (honest counts only — never a blended-currency value sum) ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label={<MetricTitle label={`${activeBand.label} customers`} help="How many customers fall into this churn-risk group right now." />}
          value={isLoading ? undefined : total.toLocaleString('en-IN')}
          unit={total ? 'in this band' : undefined}
          icon={<activeBand.icon />}
          loading={isLoading}
          freshness={<FreshnessBadge timestamp={listFetchedIso} prefix="Read" />}
        />
        <MetricCard
          label={<MetricTitle label="Showing" help="How many of those customers are listed on this page." />}
          value={isLoading ? undefined : items.length.toLocaleString('en-IN')}
          unit={items.length ? 'on this page' : undefined}
          icon={<UserMinus />}
          loading={isLoading}
        />
        <MetricCard
          label={<MetricTitle label="Win-back segments" help="Saved customer groups you can target with a win-back campaign." />}
          value={savedQ.isLoading ? undefined : winBackSegments.length.toLocaleString('en-IN')}
          unit={winBackSegments.length ? 'saved' : undefined}
          icon={<Bookmark />}
          loading={savedQ.isLoading}
        />
      </div>

      {/* ── Band selector ── */}
      <SectionCard
        title="Risk band"
        description="Switch between customers slipping toward churn and those who have already lapsed."
      >
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by churn band">
          {BANDS.map((b) => {
            const active = b.value === band;
            return (
              <Button
                key={b.value}
                type="button"
                variant={active ? 'default' : 'outline'}
                size="sm"
                aria-pressed={active}
                onClick={() => onBand(b.value)}
              >
                <b.icon className="mr-2 h-4 w-4" aria-hidden="true" />
                {b.label}
              </Button>
            );
          })}
          <span className="ml-1 text-sm text-muted-foreground">{activeBand.description}</span>
        </div>
      </SectionCard>

      {/* ── At-risk / churned customer list ── */}
      <SectionCard
        title={`${activeBand.label} customers`}
        description="Each customer’s churn-risk band shows by default, folded from their RFM band. Click a customer to open the full Customer Profile. Turn on churn scores to add the precise days-since-last-order (each lookup is logged)."
        meta={
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-input"
              checked={showScores}
              onChange={(e) => setShowScores(e.target.checked)}
            />
            Load churn scores
          </label>
        }
        flush
      >
        <div aria-live="polite" aria-busy={isLoading || isFetching}>
          {isLoading ? (
            <div className="space-y-2 p-5" aria-hidden="true">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : error ? (
            <div className="p-5">
              <ErrorCard error={error} retry={refetch} />
            </div>
          ) : items.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={<activeBand.icon />}
                title={`No ${activeBand.label.toLowerCase()} customers`}
                description={
                  band === 'at_risk'
                    ? 'No customers are slipping toward churn right now. As recency on your order history shifts, at-risk customers surface here.'
                    : 'No customers have lapsed past the churn threshold yet. Churned customers appear here once their recency crosses the threshold.'
                }
                action={
                  <Link href="/retention">
                    <Button variant="outline" size="sm">
                      Back to Retention
                      <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                    </Button>
                  </Link>
                }
              />
            </div>
          ) : (
            <Card className="rounded-none border-0 shadow-none">
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th scope="col" className="px-4 py-2.5 font-medium">Customer</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Band</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Churn risk</th>
                      <th scope="col" className="px-4 py-2.5 font-medium text-right">Lifetime value</th>
                      <th scope="col" className="px-4 py-2.5 font-medium text-right">Orders</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">Last active</th>
                      <th scope="col" className="px-4 py-2.5 font-medium text-right sr-only">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((c: CustomerListItem) => (
                      <ChurnRow key={c.brain_id} c={c} showScore={showScores} />
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Pagination */}
        {!isLoading && !error && total > 0 ? (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
            <span>
              Showing <strong className="text-foreground">{from}</strong>–
              <strong className="text-foreground">{to}</strong> of{' '}
              <strong className="text-foreground">{total}</strong>
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canPrev || isFetching}
                onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
              >
                <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canNext || isFetching}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>

      {/* ── Saved win-back segments (so the action isn't fire-and-forget) ── */}
      {winBackSegments.length > 0 ? (
        <SectionCard
          title="Win-back segments"
          description="Saved win-back rules created from this view. Each persists as a reusable definition, not a frozen list."
        >
          <ul className="divide-y">
            {winBackSegments.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2.5 text-sm">
                <span className="inline-flex items-center gap-2">
                  <Bookmark className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="font-medium text-foreground">{s.name}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  Saved {relativeTime(s.created_at).label}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <WinBackDialog
        open={winBackOpen}
        onOpenChange={setWinBackOpen}
        band={band}
        bandLabel={activeBand.label}
      />
    </TabShell>
  );
}

/**
 * One customer row.
 *
 * The churn-risk band is shown BY DEFAULT — derived from the RFM segment the list already returns
 * (riskFromSegment), so the column is never blank and no per-row serving/logging is needed. When the
 * page-level "Load churn scores" toggle is on we ALSO serve useCustomerScore (which logs a prediction)
 * to enrich the row with the precise "days idle" since the last order; otherwise the hook stays idle
 * (brain_id → null). A customer with no score row at all → an honest "not enough history".
 */
function ChurnRow({ c, showScore }: { c: CustomerListItem; showScore: boolean }) {
  const scoreQ = useCustomerScore(showScore ? c.brain_id : null);
  const last = relativeTime(c.last_identifier_at);

  // Band always available from the list row; the served score refines it (+ days idle) when loaded.
  const derived = riskFromSegment(c.segment);
  const served =
    showScore && scoreQ.data?.state === 'has_data' ? scoreQ.data.score : null;
  const risk = served
    ? { label: humanize(served.churn_risk), tone: riskTone(served.churn_risk) }
    : derived;
  const daysIdle = served?.days_since_last_order ?? null;

  let riskCell: React.ReactNode;
  if (risk) {
    riskCell = (
      <span className="inline-flex items-center gap-2">
        <StatusBadge tone={risk.tone} hideDot>
          {risk.label}
        </StatusBadge>
        {daysIdle != null ? (
          <span className="text-xs text-muted-foreground tabular-nums">{daysIdle}d idle</span>
        ) : showScore && scoreQ.isLoading ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : null}
      </span>
    );
  } else {
    // No RFM band and no score row — honest, never a blank cell or a fabricated risk.
    riskCell = (
      <span className="text-muted-foreground" title="No score yet — not enough order history">
        — not enough history
      </span>
    );
  }

  const label = customerLabel(c);

  return (
    <tr className="border-b last:border-0 hover:bg-muted/40">
      <td className="px-4 py-2.5">
        <Link
          href={`/customers/${encodeURIComponent(c.brain_id)}`}
          className="font-mono text-xs hover:underline"
          title={c.brain_id}
        >
          {label}
        </Link>
      </td>
      <td className="px-4 py-2.5">
        {c.segment ? (
          <StatusBadge tone={c.segment === 'churned' ? 'destructive' : 'warning'} hideDot>
            {humanize(c.segment)}
          </StatusBadge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">{riskCell}</td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        {c.ltv_minor != null && c.currency_code ? (
          formatMoneyDisplay(c.ltv_minor, c.currency_code as CurrencyCode)
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        {c.order_count != null ? c.order_count : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-4 py-2.5 text-muted-foreground" title={last.absolute ?? undefined}>
        {c.last_identifier_at ? last.label : '—'}
      </td>
      <td className="px-4 py-2.5 text-right">
        <Link
          href={`/customers/${encodeURIComponent(c.brain_id)}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-label={`Open the profile for ${label}`}
        >
          Open <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </td>
    </tr>
  );
}

/**
 * WinBackDialog — pre-fills a win-back segment for the active band, previews the matched count
 * (usePreviewSegment, no persistence), then persists it as a saved segment (useCreateSegment).
 */
function WinBackDialog({
  open,
  onOpenChange,
  band,
  bandLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  band: BandValue;
  bandLabel: string;
}) {
  const [name, setName] = React.useState('');
  const preview = usePreviewSegment();
  const create = useCreateSegment();

  // The pre-filled, opaque win-back rule tree (run-time evaluated against the serving spine).
  const definition = React.useMemo(
    () => ({
      kind: 'churn_winback',
      segment: band,
      intent: 'win_back',
      source: 'retention/churn',
    }),
    [band],
  );

  // Reset the pre-filled name + clear any prior preview whenever the dialog opens or the band changes.
  React.useEffect(() => {
    if (open) {
      setName(`Win-back — ${bandLabel}`);
      preview.reset();
    }
    // Intentionally deps-narrowed: only re-run when the dialog opens or the band changes —
    // `preview` is a new object identity every render; including it would loop the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bandLabel]);

  const previewData = preview.data;
  const matched =
    previewData?.state === 'has_data' ? Number(BigInt(previewData.matched_customers)) : null;

  async function onCreate() {
    try {
      await create.mutateAsync({ name: name.trim() || `Win-back — ${bandLabel}`, definition });
      toast({
        title: 'Win-back segment created',
        description: `"${name.trim() || `Win-back — ${bandLabel}`}" is saved as a reusable rule. Launch the win-back from your messaging tool — campaign execution is a follow-up step.`,
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: 'Could not create the segment',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create win-back segment</DialogTitle>
          <DialogDescription>
            Pre-filled for the <strong>{bandLabel}</strong> band. Preview how many customers match,
            then save it as a reusable rule you can act on.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="winback-name">Segment name</Label>
            <Input
              id="winback-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`Win-back — ${bandLabel}`}
              maxLength={200}
            />
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <p className="mb-1 font-medium text-muted-foreground">Rule (pre-filled)</p>
            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-foreground">
              {JSON.stringify(definition, null, 2)}
            </pre>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3 text-sm">
            <span className="text-muted-foreground">
              {matched != null ? (
                <>
                  <strong className="text-foreground">{matched.toLocaleString('en-IN')}</strong>{' '}
                  customers match this rule.
                </>
              ) : (
                'Preview the addressable count before saving.'
              )}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={preview.isPending}
              onClick={() => preview.mutate(definition)}
            >
              {preview.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Preview match
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onCreate} disabled={create.isPending}>
            {create.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            Create segment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
