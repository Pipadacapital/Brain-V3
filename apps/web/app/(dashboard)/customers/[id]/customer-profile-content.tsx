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
 * GENUINE GAP (flagged, never faked): getCustomer360 does NOT return this customer's ORDER LIST —
 * only identity links + merges. The Orders sub-tab therefore shows the order COUNT (from the served
 * RFM score) plus an honest EmptyState + a journey trace, and notes the BFF order-list as an
 * openItem. The Journey sub-tab is per-ORDER (the only journey grain that exists today) — there is
 * no per-customer aggregate path yet.
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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/ui/section-card';
import { MetricCard } from '@/components/ui/metric-card';
import { TabShell } from '@/components/ui/tab-shell';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { TouchpointTimeline } from '@/components/analytics/touchpoint-timeline';
import { humanize } from '@/lib/format/humanize';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { useCustomer360, useEraseCustomer, useUnmergeCustomer } from '@/lib/hooks/use-identity';
import { useCustomerScore } from '@/lib/hooks/use-ml';
import { useExecutiveMetrics } from '@/lib/hooks/use-analytics';
import type { Customer360Identifier, Customer360Merge } from '@/lib/api/types';
import type { CurrencyCode } from '@brain/money';

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
            body: 'Overview, Identity timeline, Journey (per order) and Segments are live. The Orders tab shows the order COUNT from the RFM score plus a journey trace — a per-customer ORDER LIST is not yet returned by the profile endpoint (flagged, never faked).',
          },
          {
            heading: 'Privacy',
            body: 'Identifiers are shown hashed (type + tier + 12-hex prefix) — raw email/phone never leave the vault. DPDP erasure permanently deletes stored contact PII and tombstones links.',
          },
        ],
        refreshCadence: 'Profile + score are read live from the BFF on open. Segment marts refresh on the Gold loop (the score’s “scored on” timestamp is shown).',
        sources: ['BFF /v1/identity/customer', 'gold_customer_scores (RFM/churn)', 'silver_touchpoint (journey)'],
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
            description={`No customer with Brain ID ${data.brain_id} exists for the active brand.`}
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/customers">Back to Customers</Link>
              </Button>
            }
          />
        ) : found ? (
          <Tabs defaultValue="overview" className="gap-6">
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
                    label="Lifetime value"
                    value={formatMoneyDisplay(score.lifetime_value_minor, currency)}
                    icon={<ShoppingBag className="h-4 w-4" aria-hidden="true" />}
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                  <MetricCard
                    label="Lifetime orders"
                    value={Number(score.lifetime_orders).toLocaleString()}
                    unit={score.days_since_last_order != null ? `${score.days_since_last_order}d since last` : undefined}
                    icon={<Gauge className="h-4 w-4" aria-hidden="true" />}
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                  <MetricCard
                    label="Churn risk"
                    value={humanize(score.churn_risk)}
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
                      <dt className="text-muted-foreground">Brain ID</dt>
                      <dd className="font-mono">{found.customer.brain_id}</dd>
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
                        <dd className="font-mono">{found.customer.merged_into}</dd>
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
                      description="As email/phone/anon identifiers resolve to this customer, they appear here (hashed)."
                    />
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th scope="col" className="py-2 pr-4 font-medium">Type</th>
                          <th scope="col" className="py-2 pr-4 font-medium">Tier</th>
                          <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                          <th scope="col" className="py-2 pr-4 font-medium">Hash</th>
                          <th scope="col" className="py-2 font-medium">Linked</th>
                        </tr>
                      </thead>
                      <tbody>
                        {found.identifiers.map((id: Customer360Identifier, i: number) => (
                          <tr key={`${id.identifier_type}-${id.identifier_hash_prefix}-${i}`} className="border-b last:border-0">
                            <td className="py-2 pr-4">{humanize(id.identifier_type)}</td>
                            <td className="py-2 pr-4">{id.tier}</td>
                            <td className="py-2 pr-4">{id.is_active ? 'active' : 'inactive'}</td>
                            <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{id.identifier_hash_prefix}…</td>
                            <td className="py-2">{new Date(id.created_at).toLocaleDateString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
                      {found.merges.map((m: Customer360Merge) => (
                        <li key={`${m.canonical_brain_id}-${m.merged_brain_id}-${m.committed_at}`} className="text-sm">
                          <div>
                            <span className="font-mono">{m.merged_brain_id}</span>
                            {' → '}
                            <span className="font-mono">{m.canonical_brain_id}</span>
                          </div>
                          <div className="text-muted-foreground">
                            This profile was the <strong>{m.role}</strong> · confidence {m.confidence} ·{' '}
                            {m.rule_version} · {new Date(m.committed_at).toLocaleString()}
                            {m.identifier_combo.length > 0 ? ` · via ${m.identifier_combo.join(', ')}` : ''}
                          </div>
                        </li>
                      ))}
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
                    label="Lifetime orders"
                    value={Number(score.lifetime_orders).toLocaleString()}
                    icon={<ShoppingBag className="h-4 w-4" aria-hidden="true" />}
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                  <MetricCard
                    label="Lifetime value"
                    value={formatMoneyDisplay(score.lifetime_value_minor, currency)}
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                  <MetricCard
                    label="Days since last order"
                    value={score.days_since_last_order != null ? String(score.days_since_last_order) : '—'}
                    unit="recency"
                    freshness={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  />
                </div>
              ) : null}

              <SectionCard
                title="Per-order list"
                description="The itemised order history for this customer."
              >
                <EmptyState
                  icon={<ShoppingBag className="h-6 w-6" aria-hidden="true" />}
                  title="Order list not yet on the profile endpoint"
                  description="The customer profile returns identity links + merges, not this customer’s itemised orders. Order COUNT + lifetime value above come from the served RFM score. Trace any single order in the Journey tab. (Surfacing a per-customer order list is an open BFF item.)"
                  action={
                    <Button asChild variant="outline" size="sm">
                      <Link href="/journeys">Open Journeys</Link>
                    </Button>
                  }
                />
              </SectionCard>
            </TabsContent>

            {/* ── Journey (per-order trace) ────────────────────────────────── */}
            <TabsContent value="journey" className="space-y-4">
              <SectionCard
                title="Journey — visit → purchase (per order)"
                description="Enter one of this customer’s order IDs to trace its deterministically-stitched touchpoints."
                meta={<FreshnessBadge timestamp={null} prefix="Updated" />}
              >
                <TouchpointTimeline />
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Route className="h-3.5 w-3.5" aria-hidden="true" />
                  The journey grain is per ORDER today — a per-customer aggregate path (Sankey) is an
                  open item on the Journeys tab.
                </p>
              </SectionCard>
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
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <MetricCard label="Recency score" value={String(score.recency_score)} unit="R" />
                    <MetricCard label="Frequency score" value={String(score.frequency_score)} unit="F" />
                    <MetricCard label="Monetary score" value={String(score.monetary_score)} unit="M" />
                    <MetricCard label="Composite" value={String(score.composite_score)} unit="RFM" />
                  </div>
                  <SectionCard
                    title="Churn & value"
                    meta={<FreshnessBadge timestamp={score.scored_on} prefix="Scored" />}
                  >
                    <dl className="grid gap-4 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-muted-foreground">Churn risk</dt>
                        <dd className="font-medium">{humanize(score.churn_risk)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Lifetime value</dt>
                        <dd className="font-medium">{formatMoneyDisplay(score.lifetime_value_minor, currency)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Lifetime orders</dt>
                        <dd className="font-medium tabular-nums">{Number(score.lifetime_orders).toLocaleString()}</dd>
                      </div>
                    </dl>
                    <p className="mt-3 text-xs text-muted-foreground">
                      These per-customer RFM/churn scores power the named business segments (VIP /
                      Loyal / At-Risk / …). List-wide segment filtering on the Customers tab is pending
                      a BFF field that surfaces this score per row.
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
