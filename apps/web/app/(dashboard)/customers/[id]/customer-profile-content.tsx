'use client';

/**
 * CustomerProfileContent — Tab #3 "Customer Profile" (per-customer 360 detail).
 *
 * Reached by clicking a row in Customers (NOT a top-level nav item). The brain_id arrives as the
 * `brainId` route param — replacing the old /identity/customer-360 lookup Input box. This WRAPS
 * the existing Customer 360 surface and organises it into 5 sub-tabs:
 *   Overview · Identity Timeline · Orders · Journey · Segments.
 *
 * REUSE (extend, don't rebuild):
 *   - useCustomer360(brainId)         — profile + linked identifiers + merge history (BFF-only).
 *   - useEraseCustomer / useUnmergeCustomer — DPDP erase + split (PRESERVED, aria-live announced).
 *   - useCustomerScore(brainId)       — RFM/churn served score (gold_customer_scores) → Segments.
 *   - <TouchpointTimeline/>           — per-order journey trace (self-contained order-id input).
 *   - useExecutiveMetrics()           — brand currency for the LTV money formatter only.
 *
 * BFF-ONLY (I-ST01): reads ONLY GET /api/v1/identity/customer + /v1/ml/customer-score. PII
 * discipline (I-S02): identifiers shown by TYPE + TIER + HASH PREFIX only — raw email/phone never
 * cross the BFF. Money is bigint minor + currency via formatMoneyDisplay (no /100, no float).
 *
 * ORDERS (live): getCustomer360 now returns this customer's ORDER LIST (latest state each, from the
 * Silver order-state fold) alongside identity links + merges. The Orders sub-tab shows the served RFM
 * headline (count + lifetime value) plus the itemised per-order table; honest EmptyState when there are
 * no orders. The Journey sub-tab is per-ORDER (the only journey grain that exists today) — there is no
 * per-customer aggregate path yet.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  User,
  Link2,
  GitMerge,
  ShieldCheck,
  ShieldOff,
  CircleSlash,
  Trash2,
  AlertTriangle,
  Split,
  ShoppingBag,
  Gauge,
  TrendingDown,
  Route,
  Mail,
  Phone,
  Fingerprint,
  Store,
  Activity,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/ui/section-card';
import { MetricCard } from '@/components/ui/metric-card';
import { MetricTitle } from '@/components/ui/metric-title';
import { TabShell } from '@/components/ui/tab-shell';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DataWindowBadge } from '@/components/ui/data-window-badge';
import { TableSearch, filterRows } from '@/components/ui/table-search';
import { VerifyLink } from '@/components/ui/verify-link';
import { TouchpointTimeline } from '@/components/analytics/touchpoint-timeline';
import { JourneyLedger } from '@/components/analytics/journey-ledger';
import { brainRef } from '@brain/contracts';
import { humanize } from '@/lib/format/humanize';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { relativeTime } from '@/lib/format/relative-time';
import { eventLabel } from '@/lib/event-labels';
import { useCustomer360, useEraseCustomer, useUnmergeCustomer } from '@/lib/hooks/use-identity';
import { useCustomerScore } from '@/lib/hooks/use-ml';
import { useExecutiveMetrics, useJourneyEvents } from '@/lib/hooks/use-analytics';
import type { Customer360Identifier, Customer360Merge, Customer360Response } from '@/lib/api/types';
import type { CurrencyCode } from '@brain/money';

/** One order row on the profile (derived from the Customer 360 contract's `found` variant). */
type Customer360Order = Extract<Customer360Response, { state: 'found' }>['orders'][number];

function ConsentBadge({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      {on ? (
        <ShieldCheck className="h-4 w-4 text-success" aria-hidden="true" />
      ) : (
        <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      )}
      <span>
        {label}: <strong>{on ? 'granted' : 'not granted'}</strong>
      </span>
    </span>
  );
}

/** churn_risk band (gold_customer_scores: low/medium/high) → the plain word. Unknown → Title Case. */
function churnRiskWord(risk: string): string {
  const band = risk.toLowerCase();
  if (band === 'low') return 'Low';
  if (band === 'medium') return 'Medium';
  if (band === 'high') return 'High';
  return humanize(risk);
}

/** Identifier type → icon + the plain-sentence subject ("Email", "Anonymous visitor"…). */
function identifierMeta(type: string): { Icon: LucideIcon; subject: string } {
  switch (type) {
    case 'email':
      return { Icon: Mail, subject: 'Email' };
    case 'phone':
      return { Icon: Phone, subject: 'Phone number' };
    case 'brain_anon_id':
      return { Icon: Fingerprint, subject: 'Anonymous visitor' };
    case 'storefront_customer_id':
      return { Icon: Store, subject: 'Store customer account' };
    default:
      return { Icon: Link2, subject: humanize(type) };
  }
}

/** Resolver tier → the parenthetical confidence phrase for the identity sentence. */
function tierPhrase(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'exact':
      return 'exact match';
    case 'strong':
    case 'strong_on_link':
      return 'high-confidence match';
    case 'weak':
      return 'possible match';
    default:
      return `${humanize(tier).toLowerCase()} match`;
  }
}

/** Merge confidence is an integer 0–100 carried as a string — render "98%" only when it parses. */
function confidencePct(confidence: string): string | null {
  const n = Number(confidence);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? `${Math.round(n)}%` : null;
}

/**
 * publicRef — the human-readable BRN- reference we surface INSTEAD of the raw brain_id UUID
 * (canonical brainRef derivation; never invented). Falls back to the raw id only if derivation
 * somehow fails, so we never render a blank.
 */
function publicRef(brainId: string): string {
  return brainRef(brainId) ?? brainId;
}

/** Absolute date for identity events ("12 Mar 2026") — identity history reads better absolute. */
function absDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function CustomerProfileContent({ brainId }: { brainId: string }) {
  const trimmed = brainId.trim();
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useCustomer360(trimmed);
  const erase = useEraseCustomer();
  const unmerge = useUnmergeCustomer();

  // RFM/churn served score — backs Overview headline + the Segments tab (gold_customer_scores).
  const scoreQ = useCustomerScore(trimmed || null);
  const score = scoreQ.data?.state === 'has_data' ? scoreQ.data.score : undefined;

  // Brand currency for the LTV money formatter (the served score carries minor units, no ccy).
  const exec = useExecutiveMetrics();
  const currency: CurrencyCode =
    (exec.data?.state === 'has_data' ? exec.data.metrics[0]?.currency_code : undefined) ?? 'INR';

  const profileFetchedIso = dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null;

  const found = data && data.state === 'found' ? data : null;

  // Controlled tab + per-order trace: clicking an order row jumps to the Journey tab and traces
  // that exact order — the honest "proof" drill (per-order Bronze detail was retired; the order's
  // own visit→purchase journey IS its proof). Both live at parent scope so the row → tab handoff works.
  const [activeTab, setActiveTab] = React.useState('overview');
  const [traceDraft, setTraceDraft] = React.useState('');
  const [tracedOrderId, setTracedOrderId] = React.useState<string | null>(null);

  const openOrderProof = React.useCallback((orderId: string) => {
    const v = orderId.trim();
    setTraceDraft(v);
    setTracedOrderId(v.length > 0 ? v : null);
    setActiveTab('journey');
  }, []);

  return (
    <TabShell
      title="Customer Profile"
      eyebrow={
        <Link href="/customers" className="hover:text-foreground">
          ← Back to Customers
        </Link>
      }
      description="The full 360 view of one customer."
      freshness={<FreshnessBadge timestamp={profileFetchedIso} prefix="Read" />}
      explainer={{
        title: 'Customer Profile — one customer, end to end',
        description:
          'Everything Brain knows about this resolved identity: overview, identity timeline, orders, journey and segments.',
        metrics: [
          {
            name: 'Overview',
            definition: 'Lifecycle, consent, first-seen, plus headline lifetime value / orders / churn risk.',
            howComputed: 'Customer 360 aggregate (useCustomer360) + served RFM score (gold_customer_scores).',
          },
          {
            name: 'Identity timeline',
            definition: 'Linked identifiers (by type + tier + hash prefix) and full merge/split history.',
            howComputed: 'Identity control-plane links + merges (BFF /v1/identity/customer).',
          },
          {
            name: 'Journey ledger',
            definition: 'This customer’s resolved journey events (newest first), incl. transaction revenue on composite rows.',
            howComputed: 'Versioned Gold ledger journey_events (current versions only) via mv_journey_events_current — identity merges re-version events onto the canonical customer.',
          },
          {
            name: 'Journey',
            definition: 'Ordered touchpoints from first visit to a purchase, for a chosen order.',
            howComputed: 'silver_touchpoint via useJourneyTimeline — per ORDER (the grain that exists today).',
          },
          {
            name: 'Segments (RFM / churn)',
            definition: 'Recency, frequency and monetary scores, composite score and churn-risk band.',
            howComputed: 'Served on demand from gold_customer_scores (useCustomerScore); logs a prediction.',
          },
        ],
        sections: [
          {
            heading: 'What’s shown vs pending',
            body: 'Overview, Identity timeline, Orders (served RFM headline + the itemised per-order list), Journey (per order) and Segments are all live.',
          },
          {
            heading: 'Privacy',
            body: 'Identifiers are shown hashed (type + tier + 12-hex prefix) — raw email/phone never leave the vault. DPDP erasure permanently deletes stored contact PII and tombstones links.',
          },
        ],
        refreshCadence: 'Profile + score are read live from the BFF on open. Segment marts refresh on the Gold loop (the score’s “scored on” timestamp is shown).',
        sources: ['BFF /v1/identity/customer', 'gold_customer_scores (RFM/churn)', 'mv_journey_events_current (journey ledger)', 'silver_touchpoint (journey)'],
      }}
    >
      <div aria-live="polite" aria-busy={isLoading || isFetching}>
        {trimmed.length === 0 ? (
          <EmptyState
            icon={<CircleSlash className="h-6 w-6" aria-hidden="true" />}
            title="No customer selected"
            description="Pick a customer from the list to open their profile."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/customers">Back to Customers</Link>
              </Button>
            }
          />
        ) : isLoading ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : !data ? null : data.state === 'not_found' ? (
          <EmptyState
            icon={<CircleSlash className="h-6 w-6" aria-hidden="true" />}
            title="No customer found"
            description={`No customer with reference ${publicRef(data.brain_id)} exists for the active brand.`}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/customers">Back to Customers</Link>
              </Button>
            }
          />
        ) : found ? (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-6">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="identity">Identity timeline</TabsTrigger>
              <TabsTrigger value="orders">Orders</TabsTrigger>
              <TabsTrigger value="journey">Journey</TabsTrigger>
              <TabsTrigger value="segments">Segments</TabsTrigger>
            </TabsList>

            {/* ── Overview ─────────────────────────────────────────────────── */}
            <TabsContent value="overview" className="space-y-6">
              {/* Headline score KPIs (only when scored — no fake zeros). */}
              {score ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <MetricCard
                    label={
                      <MetricTitle
                        label="Lifetime value"
                        help="Total revenue from this customer across all their orders."
                      />
                    }
                    value={formatMoneyDisplay(score.lifetime_value_minor, currency)}
                    icon={<ShoppingBag className="h-4 w-4" aria-hidden="true" />}
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                  <MetricCard
                    label={
                      <MetricTitle
                        label="Lifetime orders"
                        help="How many orders this customer has placed in total."
                      />
                    }
                    value={Number(score.lifetime_orders).toLocaleString()}
                    unit={score.days_since_last_order != null ? `${score.days_since_last_order}d since last` : undefined}
                    icon={<Gauge className="h-4 w-4" aria-hidden="true" />}
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                  <MetricCard
                    label={
                      <MetricTitle
                        label="Churn risk"
                        help="How likely this customer is to stop buying, based on how recently and how often they purchase."
                      />
                    }
                    value={churnRiskWord(score.churn_risk)}
                    unit={`composite ${score.composite_score}`}
                    icon={<TrendingDown className="h-4 w-4" aria-hidden="true" />}
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                </div>
              ) : null}

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <User className="h-5 w-5" aria-hidden="true" />
                    Profile
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2">
                  <dl className="space-y-2 text-sm">
                    <div>
                      <dt className="text-muted-foreground">
                        <MetricTitle
                          label="Customer reference"
                          help="Brain's stable, human-readable ID for this customer (a BRN- code). It never changes, even after profiles merge."
                        />
                      </dt>
                      <dd className="font-mono">{publicRef(found.customer.brain_id)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Lifecycle</dt>
                      <dd className="font-medium">{humanize(found.customer.lifecycle_state)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">First seen</dt>
                      <dd>{new Date(found.customer.created_at).toLocaleString()}</dd>
                    </div>
                    {found.customer.merged_into ? (
                      <div>
                        <dt className="text-muted-foreground">Merged into</dt>
                        <dd className="font-mono">{publicRef(found.customer.merged_into)}</dd>
                        <dd className="mt-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={unmerge.isPending}
                            onClick={() => unmerge.mutate(found.customer.brain_id)}
                          >
                            <Split className="mr-2 h-4 w-4" aria-hidden="true" />
                            {unmerge.isPending ? 'Splitting…' : 'Split (unmerge)'}
                          </Button>
                          {unmerge.data?.unmerged ? (
                            <span className="ml-2 text-sm text-success">Split — re-open to refresh.</span>
                          ) : null}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  <div className="space-y-2">
                    <ConsentBadge on={found.customer.resolution_consent} label="Identity resolution" />
                    <ConsentBadge on={found.customer.ai_processing_consent} label="AI processing" />
                  </div>
                </CardContent>
              </Card>

              {/* Recent activity — the customer's last 5 journey events (icon + plain description). */}
              <SectionCard
                title={
                  <MetricTitle
                    label="Recent activity"
                    help="The last five things this customer did — pages viewed, carts, orders and more."
                  />
                }
                description="The five most recent events on this customer's timeline. See the Journey tab for the full story."
              >
                <RecentActivity brainId={found.customer.brain_id} />
              </SectionCard>

              {/* Danger zone — DPDP right-to-deletion (PRESERVED). */}
              {found.customer.lifecycle_state !== 'erased' && (
                <DangerZone
                  brainId={found.customer.brain_id}
                  erase={erase}
                />
              )}
            </TabsContent>

            {/* ── Identity timeline ────────────────────────────────────────── */}
            <TabsContent value="identity" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Link2 className="h-5 w-5" aria-hidden="true" />
                    Linked identifiers ({found.identifiers.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {found.identifiers.length === 0 ? (
                    <EmptyState
                      compact
                      title="No identifiers linked yet"
                      description="As email/phone/anon identifiers resolve to this customer, they appear here (masked)."
                    />
                  ) : (
                    <ul className="space-y-3">
                      {found.identifiers.map((id: Customer360Identifier, i: number) => {
                        const { Icon, subject } = identifierMeta(id.identifier_type);
                        return (
                          <li
                            key={`${id.identifier_type}-${id.identifier_hash_prefix}-${i}`}
                            className="flex items-start gap-3 text-sm"
                          >
                            <span
                              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
                              aria-hidden="true"
                            >
                              <Icon className="h-3.5 w-3.5" />
                            </span>
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">
                                {subject} linked ({tierPhrase(id.tier)})
                                {!id.is_active ? (
                                  <span className="ml-2 font-normal text-muted-foreground">— no longer active</span>
                                ) : null}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {absDate(id.created_at)}
                                <span aria-hidden="true"> · </span>
                                <span className="font-mono" title="Masked identifier — the real value never leaves the vault.">
                                  {id.identifier_hash_prefix}…
                                </span>
                              </p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <GitMerge className="h-5 w-5" aria-hidden="true" />
                    Merge history ({found.merges.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {found.merges.length === 0 ? (
                    <EmptyState compact title="No merges recorded" description="This profile has not been merged with or split from another." />
                  ) : (
                    <ul className="space-y-3">
                      {found.merges.map((m: Customer360Merge) => {
                        const pct = confidencePct(m.confidence);
                        return (
                          <li
                            key={`${m.canonical_brain_id}-${m.merged_brain_id}-${m.committed_at}`}
                            className="flex items-start gap-3 text-sm"
                          >
                            <span
                              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
                              aria-hidden="true"
                            >
                              <GitMerge className="h-3.5 w-3.5" />
                            </span>
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">
                                Profile merged with a duplicate
                                {pct ? ` (confidence ${pct})` : ''}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {absDate(m.committed_at)}
                                {m.identifier_combo.length > 0
                                  ? ` · matched on: ${m.identifier_combo.map((c) => humanize(c).toLowerCase()).join(', ')}`
                                  : ''}
                                {' · '}
                                {m.role === 'canonical'
                                  ? 'this profile absorbed the duplicate'
                                  : 'this profile was folded into the surviving one'}
                              </p>
                              <p className="truncate text-xs text-muted-foreground/80">
                                <span className="font-mono">{publicRef(m.merged_brain_id)}</span>
                                {' → '}
                                <span className="font-mono">{publicRef(m.canonical_brain_id)}</span>
                              </p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Orders ───────────────────────────────────────────────────── */}
            <TabsContent value="orders" className="space-y-6">
              {score ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <MetricCard
                    label={
                      <MetricTitle
                        label="Lifetime orders"
                        help="How many orders this customer has placed in total."
                      />
                    }
                    value={Number(score.lifetime_orders).toLocaleString()}
                    icon={<ShoppingBag className="h-4 w-4" aria-hidden="true" />}
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                  <MetricCard
                    label={
                      <MetricTitle
                        label="Lifetime value"
                        help="Total revenue from this customer across all their orders."
                      />
                    }
                    value={formatMoneyDisplay(score.lifetime_value_minor, currency)}
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                  <MetricCard
                    label={
                      <MetricTitle
                        label="Days since last order"
                        help="How many days have passed since this customer's most recent order."
                      />
                    }
                    value={score.days_since_last_order != null ? String(score.days_since_last_order) : '—'}
                    unit="recency"
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                </div>
              ) : null}

              {found.orders.length === 0 ? (
                <SectionCard
                  title="Orders"
                  description="This customer's orders, newest first, each showing its latest status."
                >
                  <EmptyState
                    icon={<ShoppingBag className="h-6 w-6" aria-hidden="true" />}
                    title="No orders for this customer yet"
                    description="As this customer's orders flow through to the Silver order-state mart they appear here. Trace any single order's visit→purchase path in the Journey tab."
                    action={
                      <Button asChild variant="outline" size="sm">
                        <Link href="/journeys">Open Journeys</Link>
                      </Button>
                    }
                  />
                </SectionCard>
              ) : (
                <OrdersTable
                  orders={found.orders}
                  currency={currency}
                  onOpenProof={openOrderProof}
                />
              )}
            </TabsContent>

            {/* ── Journey (story timeline + "Explain this order" trace) ────── */}
            <TabsContent value="journey" className="space-y-4">
              <JourneyTab
                brainId={found.customer.brain_id}
                traceDraft={traceDraft}
                setTraceDraft={setTraceDraft}
                tracedOrderId={tracedOrderId}
                setTracedOrderId={setTracedOrderId}
              />
            </TabsContent>

            {/* ── Segments (RFM / churn) ───────────────────────────────────── */}
            <TabsContent value="segments" className="space-y-6">
              {scoreQ.isLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : scoreQ.error ? (
                <ErrorCard error={scoreQ.error} retry={scoreQ.refetch} />
              ) : !score ? (
                <EmptyState
                  icon={<Gauge className="h-6 w-6" aria-hidden="true" />}
                  title="No RFM score yet"
                  description="This customer has not been scored. Scores are produced from order recency, frequency and monetary value on the Gold loop."
                />
              ) : (
                <>
                  <SectionCard
                    title={
                      <MetricTitle
                        label="Buying behaviour (R / F / M)"
                        help="Three 1-to-5 scores rating how recently, how often, and how much this customer buys."
                      />
                    }
                    description="How recently, how often, and how much this customer spends."
                    meta={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  >
                    <div className="space-y-4">
                      <ScoreBar
                        label="How recently"
                        help="Scores how recently this customer last ordered — 5 means very recently."
                        score={score.recency_score}
                      />
                      <ScoreBar
                        label="How often"
                        help="Scores how frequently this customer orders — 5 means very often."
                        score={score.frequency_score}
                      />
                      <ScoreBar
                        label="How much"
                        help="Scores how much this customer spends compared to others — 5 means among your biggest spenders."
                        score={score.monetary_score}
                      />
                    </div>
                    <p className="mt-4 text-xs text-muted-foreground">
                      Combined score: <strong className="text-foreground">{score.composite_score}</strong> —
                      the three scores added together (3 is the lowest, 15 the highest).
                    </p>
                  </SectionCard>
                  <SectionCard
                    title="Churn & value"
                    meta={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  >
                    <dl className="grid gap-4 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-muted-foreground">
                          <MetricTitle
                            label="Churn risk"
                            help="How likely this customer is to stop buying, based on how recently and how often they purchase."
                          />
                        </dt>
                        <dd className="font-medium">{churnRiskWord(score.churn_risk)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">
                          <MetricTitle
                            label="Lifetime value"
                            help="Total revenue from this customer across all their orders."
                          />
                        </dt>
                        <dd className="font-medium">{formatMoneyDisplay(score.lifetime_value_minor, currency)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">
                          <MetricTitle
                            label="Lifetime orders"
                            help="How many orders this customer has placed in total."
                          />
                        </dt>
                        <dd className="font-medium tabular-nums">{Number(score.lifetime_orders).toLocaleString()}</dd>
                      </div>
                    </dl>
                    <p className="mt-3 text-xs text-muted-foreground">
                      These scores power the named customer segments (VIP / Loyal / At-Risk / …) you can
                      filter by on the Customers list.
                    </p>
                  </SectionCard>
                </>
              )}
            </TabsContent>
          </Tabs>
        ) : null}
      </div>
    </TabShell>
  );
}

/**
 * ScoreBar — one R/F/M score (1–5) as a labelled bar. The width is score/5; the value is
 * also shown as text ("4 of 5") so the bar is never colour/size-only.
 */
function ScoreBar({ label, help, score }: { label: string; help: string; score: number }) {
  const clamped = Math.max(0, Math.min(5, score));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-sm">
        <MetricTitle label={label} help={help} />
        <span className="tabular-nums text-muted-foreground">{clamped} of 5</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuemin={1}
        aria-valuemax={5}
        aria-valuenow={clamped}
        aria-label={`${label}: ${clamped} of 5`}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${(clamped / 5) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * RecentActivity — the customer's last 5 journey events (first ledger page, sliced), each as
 * icon + human name + plain sentence + relative time. Honest empty/loading (rule 1); raw event
 * codes never render (rule 3 — eventLabel humanizes).
 */
function RecentActivity({ brainId }: { brainId: string }) {
  const { data, isLoading, error, refetch } = useJourneyEvents(brainId, null);

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading recent activity…">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (error) return <ErrorCard error={error} retry={refetch} />;
  if (!data || data.state === 'no_data' || data.events.length === 0) {
    return (
      <EmptyState
        compact
        icon={<Activity className="h-5 w-5" aria-hidden="true" />}
        title="No activity yet"
        description="As this customer browses and buys, their latest events appear here."
      />
    );
  }

  return (
    <ol className="space-y-3">
      {data.events.slice(0, 5).map((e) => {
        const { label, Icon, description } = eventLabel(e.event_type);
        // Trino serves 'YYYY-MM-DD hh:mm:ss[.fff] UTC' — normalize before parsing (never fabricate).
        const cleaned = e.occurred_at.replace(/\s*UTC$/, '').trim();
        const iso = cleaned.includes('T') ? cleaned : `${cleaned.replace(' ', 'T')}Z`;
        const time = relativeTime(iso, Number.POSITIVE_INFINITY);
        return (
          <li key={e.touchpoint_id} className="flex items-start gap-3 text-sm">
            <span
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
              aria-hidden="true"
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{label}</p>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
            <span
              className="shrink-0 text-xs text-muted-foreground"
              title={time.absolute ?? undefined}
            >
              {time.absolute ? time.label : 'Unknown time'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * OrdersTable — this customer's orders (newest first, latest state each). Adds the three shared
 * definition-of-done affordances over the raw list:
 *   - a <DataWindowBadge> stating the honest date span these orders cover (+ the count shown);
 *   - a <TableSearch> narrowing the visible rows by order id or status (client-side, no re-fetch);
 *   - each order id is a button that jumps to the Journey tab and traces that exact order — the
 *     "proof" drill (per-order Bronze detail was retired; the order's own journey IS its evidence).
 * Money stays bigint minor + currency via formatMoneyDisplay; search never touches a number.
 */
function OrdersTable({
  orders,
  currency,
  onOpenProof,
}: {
  orders: readonly Customer360Order[];
  currency: CurrencyCode;
  onOpenProof: (orderId: string) => void;
}) {
  const [query, setQuery] = React.useState('');

  const visible = filterRows(orders, query, (o) => `${o.order_id} ${humanize(o.lifecycle_state)}`);

  // Honest date span over the VISIBLE rows: min/max placed date (first_event_at). Nulls skipped;
  // when none carry a date we pass null → the badge renders "all time" rather than a fabricated bound.
  const placedTimes = visible
    .map((o) => (o.first_event_at ? new Date(o.first_event_at).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  const fromIso = placedTimes.length ? new Date(Math.min(...placedTimes)).toISOString() : null;
  const toIso = placedTimes.length ? new Date(Math.max(...placedTimes)).toISOString() : null;

  return (
    <SectionCard
      title={`Orders (${orders.length})`}
      description="This customer's orders, newest first, each showing its latest status. Select an order to see the visits and clicks that led to it."
      meta={<DataWindowBadge from={fromIso} to={toIso} count={visible.length} label="orders" />}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <TableSearch
          value={query}
          onChange={setQuery}
          placeholder="Search orders…"
          aria-label="Search this customer's orders by id or status"
        />
        <VerifyLink href="/analytics/orders" label="All orders" />
      </div>
      {visible.length === 0 ? (
        <EmptyState
          compact
          icon={<ShoppingBag className="h-5 w-5" aria-hidden="true" />}
          title="No orders match your search"
          description="No order id or status contains that text. Clear the search to see every order."
        />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">Order</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium text-right">Amount</th>
              <th scope="col" className="px-3 py-2 font-medium">Placed</th>
              <th scope="col" className="px-3 py-2 font-medium">Last updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((o) => (
              <tr key={o.order_id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onOpenProof(o.order_id)}
                    className="rounded font-mono text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="See this order's journey — every step from first visit to purchase"
                  >
                    {o.order_id}
                  </button>
                </td>
                <td className="px-3 py-2">{humanize(o.lifecycle_state)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMoneyDisplay(o.order_value_minor, (o.currency_code ?? currency) as CurrencyCode)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {o.first_event_at ? new Date(o.first_event_at).toLocaleDateString() : '—'}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {o.state_effective_at ? new Date(o.state_effective_at).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

/**
 * JourneyTab — the customer's full story timeline (shared <JourneyTimeline/> via JourneyLedger)
 * plus the "Explain this order" trace box. The ledger endpoint does not expose per-event order
 * references today, so a submitted order id always resolves through the per-order trace below
 * (TouchpointTimeline, controlled); the highlight seam is wired for when the BFF exposes them.
 */
function JourneyTab({
  brainId,
  traceDraft,
  setTraceDraft,
  tracedOrderId,
  setTracedOrderId,
}: {
  brainId: string;
  traceDraft: string;
  setTraceDraft: (v: string) => void;
  tracedOrderId: string | null;
  setTracedOrderId: (v: string | null) => void;
}) {
  const submitTrace = (e: React.FormEvent) => {
    e.preventDefault();
    const v = traceDraft.trim();
    setTracedOrderId(v.length > 0 ? v : null);
  };

  return (
    <>
      <SectionCard
        title="Explain this order"
        description="Paste an order ID to see the visits and clicks that led up to it."
      >
        <form onSubmit={submitTrace} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="explain-order-id" className="text-xs font-medium text-muted-foreground">
              Order ID
            </label>
            <input
              id="explain-order-id"
              type="text"
              inputMode="text"
              value={traceDraft}
              onChange={(e) => setTraceDraft(e.target.value)}
              placeholder="e.g. 4521987654321"
              data-testid="explain-order-input"
              className="h-9 w-64 max-w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <Button type="submit" size="sm" variant="outline" data-testid="explain-order-submit">
            <Route className="mr-2 h-4 w-4" aria-hidden="true" />
            Explain this order
          </Button>
          {tracedOrderId ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setTraceDraft('');
                setTracedOrderId(null);
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>

        {tracedOrderId ? (
          <div className="mt-4">
            <TouchpointTimeline orderId={tracedOrderId} />
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            The trace shows the order's own journey — every step from first visit to purchase.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Full story — everything this customer did"
        description="Every event on this customer's timeline, newest first. If their profiles were ever merged, this is the combined, post-merge story."
      >
        <JourneyLedger brainId={brainId} highlightOrderId={tracedOrderId ?? undefined} />
      </SectionCard>
    </>
  );
}

/** DPDP right-to-deletion — extracted to keep the confirm state local (PRESERVED behaviour). */
function DangerZone({
  brainId,
  erase,
}: {
  brainId: string;
  erase: ReturnType<typeof useEraseCustomer>;
}) {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          DPDP erasure
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Permanently delete this customer&apos;s stored email/phone, deactivate their identifiers,
          and mark them erased. This cannot be undone.
        </p>
        {erase.data?.erased ? (
          <p className="text-sm font-medium text-success">
            Erased — {erase.data.contact_pii_deleted} PII record(s) deleted,{' '}
            {erase.data.links_tombstoned} identifier(s) deactivated. Re-open to refresh.
          </p>
        ) : confirming ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Erase this customer permanently?</span>
            <Button
              variant="destructive"
              disabled={erase.isPending}
              onClick={() => erase.mutate(brainId)}
            >
              {erase.isPending ? 'Erasing…' : 'Confirm erase'}
            </Button>
            <Button variant="outline" disabled={erase.isPending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
            Erase customer (DPDP)
          </Button>
        )}
        {erase.isError ? (
          <p className="text-sm text-destructive">Erase failed — please try again.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
