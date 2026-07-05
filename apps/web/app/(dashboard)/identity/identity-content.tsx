'use client';

/**
 * IdentityContent — Tab #8 "Are my customer profiles clean and merged correctly?".
 *
 * Consolidation only (no new analytics): re-homes the former identity/merge-review and
 * identity/pii-vault surfaces under ONE tab with three sub-sections, plus an identity-graph
 * health summary built from the EXISTING stitch-rate + data-quality endpoints:
 *
 *   • Merge review  — the human-review queue (useMergeReviews / useResolveMergeReview).
 *                     Each candidate: side-by-side profile refs, a plain-language match
 *                     reason, Approve merge (green) / Reject (red), Details (→ the
 *                     canonical customer's profile).
 *   • PII vault     — encrypted-at-rest coverage, counts only (useVaultCoverage), plus the
 *                     PII deletion-request feed (useCapiFeedbackDeletions — the EXISTING
 *                     retroactive-deletion endpoint; status pills, relative times).
 *   • Graph health  — deterministic cart-stitch hit-rate (useJourneyStitchRate, reusing
 *                     StitchRateCard) + "Profile completeness" (vault coverage) + the
 *                     "Data Trust Score" (useDataQualitySummary; display-name only — the
 *                     underlying field is still effectiveConfidence).
 *
 * The customer BROWSE list (/customers) and per-customer profile (/customers/[id]) moved
 * OUT of the old Identity section into their own tabs (#2/#3) — identity/customers and
 * identity/customer-360 redirect there. unmerge/erase live on the per-customer profile.
 *
 * Honesty: merge-reviews + vault-coverage carry NO server timestamp (verified in the
 * contract: MergeReviewListSchema / VaultCoverageSchema), so FreshnessBadge renders the
 * honest tone='unknown' rather than a fabricated "just now". The merge-review payload
 * carries ONLY { review_id, brain_id_a, brain_id_b, trigger_reason, created_at } — no
 * masked email / order counts / spend / confidence %, so the cards show exactly what
 * exists: public BRN- refs (canonical brainRef derivation, never invented), the humanized
 * trigger reason, and when it was flagged. Every section has a friendly EmptyState
 * instead of a fake zero.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  GitMerge,
  Check,
  X,
  ShieldCheck,
  Mail,
  Phone,
  Users,
  Gauge,
  ArrowUpRight,
  Trash2,
} from 'lucide-react';
import { brainRef } from '@brain/contracts';
import { humanize } from '@/lib/format/humanize';
import { relativeTime } from '@/lib/format/relative-time';
import { TabShell } from '@/components/ui/tab-shell';
import type { ExplainerPanelProps } from '@/components/ui/explainer-panel';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { MetricTitle } from '@/components/ui/metric-title';
import { StatusPill, type StatusPillStatus } from '@/components/ui/status-pill';
import { StitchRateCard } from '@/components/analytics/stitch-rate-card';
import {
  useMergeReviews,
  useResolveMergeReview,
  useVaultCoverage,
} from '@/lib/hooks/use-identity';
import { useCapiFeedbackDeletions } from '@/lib/hooks/use-capi-feedback';
import { useJourneyStitchRate, useDataQualitySummary } from '@/lib/hooks/use-analytics';
import type { MergeReview, CapiDeletionStatus } from '@/lib/api/types';

const TAB_KEYS = ['merge-review', 'pii-vault', 'graph-health'] as const;
type TabKey = (typeof TAB_KEYS)[number];

function normalizeTab(tab?: string): TabKey {
  return (TAB_KEYS as readonly string[]).includes(tab ?? '')
    ? (tab as TabKey)
    : 'merge-review';
}

const EXPLAINER: ExplainerPanelProps = {
  title: 'Identity — clean, correctly-merged profiles',
  description:
    'The health of customer profiles: the merge-review queue, the privacy vault, and how well activity links to known customers.',
  sections: [
    {
      heading: 'How to read this tab',
      body: (
        <>
          Brain works out which events belong to which person, so every customer has ONE
          profile. When the proof is strong (the same email or phone), profiles merge
          automatically. When the match is only <em>likely</em> — say the same device or
          network — Brain <strong>never merges on its own</strong>: those pairs land in{' '}
          <strong>Merge review</strong> for you to approve or reject. The{' '}
          <strong>PII vault</strong> shows how much customer contact data is stored safely
          encrypted, and <strong>Graph health</strong> shows how well anonymous visits
          connect to known customers.
        </>
      ),
    },
  ],
  metrics: [
    {
      name: 'Merge review queue',
      definition:
        'Pairs of profiles the system suspects belong to the same person but is not certain about — held for a human decision, never merged automatically.',
      howComputed:
        'Weaker signals (same device, browser, or network) flag a possible match. Approve merges the second profile into the first; Reject keeps them separate.',
    },
    {
      name: 'Profile completeness',
      definition:
        'The share of customers with at least one email or phone number securely on file.',
      howComputed:
        'Counts only — the actual details stay encrypted in the vault and are never shown here.',
    },
    {
      name: 'Linked journeys',
      definition:
        'The share of anonymous browsing journeys we could connect to a real customer order.',
      howComputed:
        'A journey is linked only when an order carries definite proof it came from that browser — never by guessing.',
    },
    {
      name: 'Data Trust Score',
      definition:
        'An overall grade for how much this data can be trusted when making spend and business decisions.',
      howComputed:
        'The lower of the cost-data and attribution-data quality grades — the weakest link sets the score.',
    },
  ],
  refreshCadence:
    'The merge queue and vault coverage read live. Graph-health numbers refresh with the analytics pipeline.',
  sources: [
    'Identity system (merge reviews, vault)',
    'Journey data (linked journeys)',
    'Data-quality checks (Data Trust Score)',
  ],
};

export function IdentityContent({ initialTab }: { initialTab?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = React.useState<TabKey>(() => normalizeTab(initialTab));

  const onTabChange = React.useCallback(
    (next: string) => {
      const key = normalizeTab(next);
      setTab(key);
      // Keep the URL shareable/back-button-friendly without a full navigation.
      router.replace(`${pathname}?tab=${key}`, { scroll: false });
    },
    [router, pathname],
  );

  return (
    <TabShell
      title="Identity"
      description="Are my customer profiles clean and merged correctly?"
      explainer={EXPLAINER}
    >
      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList aria-label="Identity sections">
          <TabsTrigger value="merge-review">Merge review</TabsTrigger>
          <TabsTrigger value="pii-vault">PII vault</TabsTrigger>
          <TabsTrigger value="graph-health">Graph health</TabsTrigger>
        </TabsList>

        <TabsContent value="merge-review">
          <MergeReviewSection />
        </TabsContent>
        <TabsContent value="pii-vault">
          <PiiVaultSection />
        </TabsContent>
        <TabsContent value="graph-health">
          <GraphHealthSection />
        </TabsContent>
      </Tabs>
    </TabShell>
  );
}

// ── Merge review queue ────────────────────────────────────────────────────────

/**
 * matchReason — humanize the resolver's trigger_reason into ONE plain sentence.
 *
 * Known machine shapes (write side: stream-worker DecisionEngine / IdentityResolver /
 * ProbabilisticMatcher): 'probabilistic_match: …', 'cycle_guard:alias_loop',
 * 'cycle-guard: alias chain collision (…)', 'weak_agree:<type>' fragments, plus the
 * curated enums humanize() already covers (shared_device, shared_email_hash, …).
 * The raw code is NEVER rendered — unknown values fall back to a cleaned Title Case.
 */
const WEAK_SIGNAL_LABELS: Record<string, string> = {
  device_fingerprint: 'device',
  cookie_id: 'browser cookie',
  session_id: 'browsing session',
  ip: 'IP address',
};

function matchReason(reason: string): string {
  const r = reason.toLowerCase();

  // Which weak signals agreed (e.g. 'weak_agree:device_fingerprint') → "Same device and IP address".
  const signals = [...reason.matchAll(/weak_agree:([a-z_]+)/gi)]
    .map((m) => WEAK_SIGNAL_LABELS[m[1]?.toLowerCase() ?? ''] ?? null)
    .filter((s): s is string => s !== null);
  if (signals.length > 0) {
    const list =
      signals.length === 1
        ? signals[0]
        : `${signals.slice(0, -1).join(', ')} and ${signals[signals.length - 1]}`;
    return `Same ${list}`;
  }

  if (r.includes('probabilistic')) {
    if (r.includes('email')) return 'Possible match — same email';
    if (r.includes('phone')) return 'Possible match — same phone';
    return 'Similar device and browsing signals suggest the same person';
  }
  if (r.includes('cycle_guard') || r.includes('cycle-guard')) {
    return 'These profiles are linked in a conflicting way and need a human decision';
  }
  if (r.includes('phone_guard')) {
    return 'The same phone number appears on an unusually large number of profiles';
  }

  // Curated enum labels (shared_device → 'Same device', …), else cleaned Title Case —
  // strip any '(canonical=… merged=…)' machine payload and separators first.
  const cleaned = reason.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[:\s]+/g, '_').replace(/^_+|_+$/g, '');
  return humanize(cleaned);
}

/** One side of the candidate pair — the public BRN- ref (canonical derivation) + profile link. */
function MergeProfileRef({
  role,
  brainId,
}: {
  role: string;
  brainId: string;
}) {
  const publicRef = brainRef(brainId);
  return (
    <div className="min-w-0 rounded-md border p-3">
      <div className="text-xs font-medium text-muted-foreground">{role}</div>
      <div className="truncate font-mono text-sm" title={publicRef ?? brainId}>
        {publicRef ?? brainId}
      </div>
      <Link
        href={`/customers/${encodeURIComponent(brainId)}`}
        className="mt-1 inline-flex items-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        aria-label={`View the profile ${publicRef ?? brainId}`}
      >
        View profile
        <ArrowUpRight className="ml-1 h-3 w-3" aria-hidden="true" />
      </Link>
    </div>
  );
}

function MergeReviewSection() {
  const { data, isLoading, isFetching, error, refetch } = useMergeReviews();
  const resolve = useResolveMergeReview();

  return (
    <section className="space-y-4" aria-label="Merge review queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-2xl space-y-1">
          <MetricTitle
            label={<span className="text-sm font-medium">Needs your review</span>}
            help="These are profiles the system suspects belong to the same person but isn't certain — approve only if you're sure."
          />
          <p className="text-sm text-muted-foreground">
            Approve to combine the two profiles into one customer, or reject to keep them
            separate. Nothing is merged without your decision.
          </p>
        </div>
        {/* No server timestamp on this endpoint → honest 'unknown'. */}
        <FreshnessBadge timestamp={undefined} prefix="Queue" />
      </div>

      <div aria-live="polite" aria-busy={isLoading || isFetching}>
        {isLoading ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : !data || data.reviews.length === 0 ? (
          <EmptyState
            icon={<GitMerge className="h-6 w-6" aria-hidden="true" />}
            title="All good! No customer merges need your attention."
            description="When the system spots two profiles that might be the same person, they'll appear here for you to decide."
          />
        ) : (
          <ul className="space-y-3">
            {data.reviews.map((r: MergeReview) => {
              const flagged = relativeTime(r.created_at);
              return (
                <li key={r.review_id}>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">
                        {matchReason(r.trigger_reason)}
                      </CardTitle>
                      <p className="text-xs text-muted-foreground">
                        Flagged{' '}
                        <span title={flagged.absolute ?? undefined}>{flagged.label}</span>
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Side-by-side: exactly the data the endpoint returns — the two
                          profile refs. (No emails / order counts / spend in the payload.) */}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <MergeProfileRef role="Profile that stays" brainId={r.brain_id_a} />
                        <MergeProfileRef
                          role="Profile merged in (if you approve)"
                          brainId={r.brain_id_b}
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="success"
                          disabled={resolve.isPending}
                          onClick={() =>
                            resolve.mutate({ reviewId: r.review_id, decision: 'merge' })
                          }
                        >
                          <Check className="mr-2 h-4 w-4" aria-hidden="true" />
                          Approve merge
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={resolve.isPending}
                          onClick={() =>
                            resolve.mutate({ reviewId: r.review_id, decision: 'reject' })
                          }
                        >
                          <X className="mr-2 h-4 w-4" aria-hidden="true" />
                          Reject
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        {resolve.isError ? (
          <p className="mt-3 text-sm text-destructive">Action failed — please try again.</p>
        ) : null}
      </div>
    </section>
  );
}

// ── PII vault ─────────────────────────────────────────────────────────────────

function VaultStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="text-muted-foreground" aria-hidden="true">
        {icon}
      </div>
      <div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

/** Deletion-request status → StatusPill state + human label (raw code never rendered). */
const DELETION_STATUS: Record<CapiDeletionStatus, { status: StatusPillStatus; label: string }> = {
  requested: { status: 'waiting', label: 'In progress' },
  would_delete_dev: { status: 'waiting', label: 'Queued (test mode)' },
  deleted: { status: 'healthy', label: 'Deleted' },
  failed: { status: 'error', label: 'Failed' },
};

/**
 * PII deletion requests — reuses the EXISTING retroactive-deletion endpoint
 * (useCapiFeedbackDeletions): when a customer withdraws consent, their previously shared
 * data is deleted from ad platforms. Status pills + relative times; honest empty state.
 */
function DeletionRequestsCard() {
  const { data, isLoading, error, refetch } = useCapiFeedbackDeletions();

  const deletions = data && data.state === 'has_data' ? data.deletions : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trash2 className="h-5 w-5" aria-hidden="true" />
          <MetricTitle
            label="Deletion requests"
            help="When a customer asks for their data to be removed, the request and its progress show here."
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full" aria-hidden="true" />
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : deletions.length === 0 ? (
          <EmptyState
            icon={<Trash2 className="h-6 w-6" aria-hidden="true" />}
            title="No PII deletion requests."
            description="When a customer withdraws consent, the deletion request and its progress will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                The most recent data-deletion requests, each showing its status, how many
                shared events it covers, and when it was requested and completed.
              </caption>
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-2 text-left font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Events covered
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Requested
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Completed
                  </th>
                </tr>
              </thead>
              <tbody>
                {deletions.map((row, i) => {
                  const pill = DELETION_STATUS[row.status] ?? {
                    status: 'waiting' as StatusPillStatus,
                    label: humanize(row.status),
                  };
                  const requested = relativeTime(row.requested_at);
                  const completed = row.completed_at ? relativeTime(row.completed_at) : null;
                  return (
                    <tr
                      key={`${row.requested_at}-${i}`}
                      className="border-b last:border-0"
                      data-testid="pii-deletion-row"
                      data-status={row.status}
                    >
                      <td className="py-2">
                        <StatusPill status={pill.status} label={pill.label} />
                      </td>
                      <td className="py-2 text-right tabular-nums text-foreground">
                        {row.event_count}
                      </td>
                      <td
                        className="py-2 text-right tabular-nums text-muted-foreground"
                        title={requested.absolute ?? undefined}
                      >
                        {requested.label}
                      </td>
                      <td
                        className="py-2 text-right tabular-nums text-muted-foreground"
                        title={completed?.absolute ?? undefined}
                      >
                        {completed ? completed.label : 'Not yet'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PiiVaultSection() {
  const { data, isLoading, isFetching, error, refetch } = useVaultCoverage();

  return (
    <section className="space-y-4" aria-label="PII vault">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Customer emails and phone numbers are stored safely encrypted. The actual details
          never leave the vault — this page only ever shows counts.
        </p>
        <FreshnessBadge timestamp={undefined} prefix="Coverage" />
      </div>

      <div aria-live="polite" aria-busy={isLoading || isFetching}>
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : !data ? (
          <EmptyState
            icon={<ShieldCheck className="h-6 w-6" aria-hidden="true" />}
            title="Nothing in the vault yet"
            description="Once customers are identified and their contact details are stored, coverage will appear here."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                  <MetricTitle
                    label="Profile completeness"
                    help="The share of customers with at least one email or phone number securely on file."
                  />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-4xl font-semibold tabular-nums">
                    {data.coverage_pct}%
                  </div>
                  <div className="text-sm text-muted-foreground">
                    of customers have an email or phone number securely on file
                  </div>
                </div>
                <VaultStat
                  icon={<Users className="h-5 w-5" aria-hidden="true" />}
                  label={`with contact details, of ${data.resolved_customers} customers`}
                  value={data.vaulted_customers}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <MetricTitle
                    label="Contact details on file"
                    help="How many email addresses and phone numbers are stored encrypted in the vault."
                  />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <VaultStat
                  icon={<Mail className="h-5 w-5" aria-hidden="true" />}
                  label="email addresses"
                  value={data.email_count}
                />
                <VaultStat
                  icon={<Phone className="h-5 w-5" aria-hidden="true" />}
                  label="phone numbers"
                  value={data.phone_count}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <DeletionRequestsCard />
    </section>
  );
}

// ── Graph health ──────────────────────────────────────────────────────────────

function GraphHealthSection() {
  const stitchQ = useJourneyStitchRate();
  const vaultQ = useVaultCoverage();
  const dqQ = useDataQualitySummary();

  const stitch = stitchQ.data;
  const vault = vaultQ.data;
  const dq = dqQ.data;

  const isLoading = stitchQ.isLoading || vaultQ.isLoading || dqQ.isLoading;

  return (
    <section className="space-y-4" aria-label="Identity-graph health">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          How well anonymous visits connect to known customers, how complete your customer
          profiles are, and how much this data can be trusted for decisions.
        </p>
        {/* Graph-health marts refresh on the Gold loop; no per-row served-at exposed. */}
        <FreshnessBadge timestamp={undefined} prefix="Marts" />
      </div>

      {isLoading ? (
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
          aria-busy="true"
          aria-label="Loading identity-graph health…"
        >
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* Linked journeys — the core linkage signal (reuses StitchRateCard). */}
          {stitch?.state === 'has_data' ? (
            <StitchRateCard
              hitPct={stitch.hit_pct}
              stitched={stitch.stitched}
              total={stitch.total}
              data-testid="identity-graph-stitch"
            />
          ) : (
            <Card className="p-5" role="region" aria-label="Linked journeys: no data yet">
              <CardContent className="space-y-1 p-0">
                <MetricTitle
                  className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  label="Linked journeys"
                  help="The share of anonymous browsing journeys we could connect to a real customer order."
                />
                <p className="text-sm italic text-muted-foreground">No data yet</p>
                <p className="text-xs text-muted-foreground">
                  This appears once your tracking pixel captures visits that lead to orders.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Profile completeness — share of customers with vaulted contact details. */}
          <Card
            className="p-5"
            role="region"
            aria-label={
              vault
                ? `Profile completeness: ${vault.coverage_pct} percent`
                : 'Profile completeness: no data yet'
            }
          >
            <CardContent className="space-y-1 p-0">
              <MetricTitle
                className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    Profile completeness
                  </span>
                }
                help="The share of customers with at least one email or phone number securely on file."
              />
              {vault ? (
                <>
                  <p className="text-2xl font-bold leading-tight tabular-nums text-foreground">
                    {vault.coverage_pct}%
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {vault.vaulted_customers.toLocaleString('en-IN')} of{' '}
                    {vault.resolved_customers.toLocaleString('en-IN')} customers have an
                    email or phone on file
                  </p>
                </>
              ) : (
                <p className="text-sm italic text-muted-foreground">No data yet</p>
              )}
            </CardContent>
          </Card>

          {/* Data Trust Score — display name for the DQ effective-confidence gate. */}
          <Card
            className="p-5"
            role="region"
            aria-label={
              dq && dq.state === 'has_data'
                ? `Data Trust Score grade ${dq.effectiveConfidence}, ${dq.gate.tier}`
                : 'Data Trust Score: no data yet'
            }
          >
            <CardContent className="space-y-1 p-0">
              <MetricTitle
                className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                    Data Trust Score
                  </span>
                }
                help="An overall grade for how much this data can be trusted when making spend and business decisions."
              />
              {dq && dq.state === 'has_data' ? (
                <>
                  <p className="text-2xl font-bold leading-tight tabular-nums text-foreground">
                    {dq.effectiveConfidence}
                  </p>
                  <p className="text-xs capitalize text-muted-foreground">
                    {dq.gate.tier} · decides whether this data guides spending decisions
                  </p>
                </>
              ) : (
                <p className="text-sm italic text-muted-foreground">No quality grades yet</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Journeys are linked only on hard proof — an anonymous visit is connected to a
        customer when a real order confirms it came from that browser, never by guessing.
      </p>
    </section>
  );
}
