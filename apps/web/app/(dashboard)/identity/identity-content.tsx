'use client';

/**
 * IdentityContent — Tab #8 "Are my customer profiles clean and merged correctly?".
 *
 * Consolidation only (no new analytics): re-homes the former identity/merge-review and
 * identity/pii-vault surfaces under ONE tab with three sub-sections, plus an identity-graph
 * health summary built from the EXISTING stitch-rate + data-quality endpoints:
 *
 *   • Merge review  — the human-review queue (useMergeReviews / useResolveMergeReview).
 *                     Each candidate: Approve merge · Reject · Details (→ the canonical
 *                     customer's profile, the new /customers/[id] detail route).
 *   • PII vault     — encrypted-at-rest coverage, counts only (useVaultCoverage).
 *   • Graph health  — deterministic cart-stitch hit-rate (useJourneyStitchRate, reusing
 *                     StitchRateCard) + vault coverage + the effective-confidence trust
 *                     tier (useDataQualitySummary) as the identity-graph trust signal.
 *
 * The customer BROWSE list (/customers) and per-customer profile (/customers/[id]) moved
 * OUT of the old Identity section into their own tabs (#2/#3) — identity/customers and
 * identity/customer-360 redirect there. unmerge/erase live on the per-customer profile.
 *
 * Honesty: merge-reviews + vault-coverage carry NO server timestamp (verified in the
 * contract: MergeReviewListSchema / VaultCoverageSchema), so FreshnessBadge renders the
 * honest tone='unknown' rather than a fabricated "just now". Every section has a friendly
 * EmptyState instead of a fake zero.
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
} from 'lucide-react';
import { humanize } from '@/lib/format/humanize';
import { TabShell } from '@/components/ui/tab-shell';
import type { ExplainerPanelProps } from '@/components/ui/explainer-panel';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { StitchRateCard } from '@/components/analytics/stitch-rate-card';
import {
  useMergeReviews,
  useResolveMergeReview,
  useVaultCoverage,
} from '@/lib/hooks/use-identity';
import { useJourneyStitchRate, useDataQualitySummary } from '@/lib/hooks/use-analytics';
import type { MergeReview } from '@/lib/api/types';

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
    'The health of identity resolution: the merge-review queue, the PII vault, and identity-graph linkage health.',
  sections: [
    {
      heading: 'How to read this tab',
      body: (
        <>
          Brain resolves every event to a single person (a <code>brain_id</code>). Strong
          deterministic signals merge automatically; weaker probabilistic matches are{' '}
          <strong>never auto-merged</strong> — they land in the{' '}
          <strong>Merge review</strong> queue for a human to approve or reject. The{' '}
          <strong>PII vault</strong> shows how much customer contact data is encrypted at
          rest, and <strong>Graph health</strong> shows how well anonymous activity links to
          known customers.
        </>
      ),
    },
  ],
  metrics: [
    {
      name: 'Merge review queue',
      definition:
        'Candidate merges the resolver flagged as possibly the same person — routed for human review, never auto-merged.',
      howComputed:
        'The probabilistic matcher routes weak / sub-exact pairs to review. Approve merges profile B into the canonical A; Reject keeps them separate. (GET /api/v1/identity/merge-reviews.)',
    },
    {
      name: 'PII vault coverage',
      definition:
        'Share of resolved customers with at least one identifier (email / phone) held encrypted in the vault.',
      howComputed:
        'Counts only — never raw PII. AES-256-GCM at rest with a per-brand key; only the conversion-passback path decrypts, transiently. (GET /api/v1/identity/vault-coverage.)',
    },
    {
      name: 'Cart-stitch hit-rate',
      definition:
        'Share of anonymous journeys deterministically linked back to a known order — the core identity-graph linkage signal.',
      howComputed:
        'brain_anon_id read BACK from the order (never inferred). Silver-tier journey seam (useJourneyStitchRate).',
    },
    {
      name: 'Effective confidence',
      definition:
        'The trust tier governing whether resolved identity feeds billing and MMM — min(cost, attribution) confidence.',
      howComputed:
        'Phase-7 data-quality gate (GET /api/v1/data-quality/summary).',
    },
  ],
  refreshCadence:
    'The merge queue and vault coverage read live from the identity control-plane. Graph-health (stitch rate, confidence) refreshes on the Gold loop.',
  sources: [
    'Identity control-plane (merge reviews, vault)',
    'Silver journey tier (cart-stitch)',
    'Data-quality marts (effective confidence)',
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

function MergeReviewSection() {
  const { data, isLoading, isFetching, error, refetch } = useMergeReviews();
  const resolve = useResolveMergeReview();

  return (
    <section className="space-y-4" aria-label="Merge review queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Candidate identity merges the resolver flagged for human review. Approve to merge
          the second profile into the first (canonical), or reject to keep them separate.
        </p>
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
            title="No pending merges"
            description="The review queue is clear — no candidate merges await a decision. Strong deterministic matches merge automatically; only ambiguous ones land here."
          />
        ) : (
          <ul className="space-y-3">
            {data.reviews.map((r: MergeReview) => (
              <li key={r.review_id}>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{humanize(r.trigger_reason)}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center justify-between gap-4">
                    <div className="text-sm">
                      <div>
                        Canonical: <span className="font-mono">{r.brain_id_a}</span>
                      </div>
                      <div>
                        Merge in: <span className="font-mono">{r.brain_id_b}</span>
                      </div>
                      <div className="text-muted-foreground">
                        flagged {new Date(r.created_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        disabled={resolve.isPending}
                        onClick={() =>
                          resolve.mutate({ reviewId: r.review_id, decision: 'merge' })
                        }
                      >
                        <Check className="mr-2 h-4 w-4" aria-hidden="true" />
                        Approve merge
                      </Button>
                      <Button
                        variant="outline"
                        disabled={resolve.isPending}
                        onClick={() =>
                          resolve.mutate({ reviewId: r.review_id, decision: 'reject' })
                        }
                      >
                        <X className="mr-2 h-4 w-4" aria-hidden="true" />
                        Reject
                      </Button>
                      {/* Details → the canonical customer's profile (the new detail route). */}
                      <Button variant="ghost" asChild>
                        <Link
                          href={`/customers/${encodeURIComponent(r.brain_id_a)}`}
                          aria-label={`View profile details for canonical customer ${r.brain_id_a}`}
                        >
                          Details
                          <ArrowUpRight className="ml-2 h-4 w-4" aria-hidden="true" />
                        </Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
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

function PiiVaultSection() {
  const { data, isLoading, isFetching, error, refetch } = useVaultCoverage();

  return (
    <section className="space-y-4" aria-label="PII vault">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Customer email and phone are stored encrypted at rest (AES-256-GCM, per-brand key).
          Raw values never leave the vault — only the conversion-passback path decrypts them
          transiently to compute match hashes. Counts only.
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
            title="No vault coverage yet"
            description="Once customers are resolved and their contact identifiers are vaulted, coverage will appear here."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                  Coverage
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-4xl font-semibold tabular-nums">
                    {data.coverage_pct}%
                  </div>
                  <div className="text-sm text-muted-foreground">
                    of resolved customers have at least one vaulted identifier
                  </div>
                </div>
                <VaultStat
                  icon={<Users className="h-5 w-5" aria-hidden="true" />}
                  label={`vaulted of ${data.resolved_customers} resolved customers`}
                  value={data.vaulted_customers}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Vaulted identifiers</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <VaultStat
                  icon={<Mail className="h-5 w-5" aria-hidden="true" />}
                  label="emails"
                  value={data.email_count}
                />
                <VaultStat
                  icon={<Phone className="h-5 w-5" aria-hidden="true" />}
                  label="phones"
                  value={data.phone_count}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </div>
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
          How well anonymous activity links into single identities, how much PII is vaulted,
          and the confidence tier governing whether resolved identity feeds billing and MMM.
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
          {/* Cart-stitch hit-rate — the core linkage signal (reuses StitchRateCard). */}
          {stitch?.state === 'has_data' ? (
            <StitchRateCard
              hitPct={stitch.hit_pct}
              stitched={stitch.stitched}
              total={stitch.total}
              data-testid="identity-graph-stitch"
            />
          ) : (
            <Card className="p-5" role="region" aria-label="Cart-stitch hit-rate: no journeys yet">
              <CardContent className="space-y-1 p-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Cart-stitch hit-rate
                </p>
                <p className="text-sm italic text-muted-foreground">No journeys yet</p>
                <p className="text-xs text-muted-foreground">
                  Linkage appears once the Brain Pixel captures sessions stitched to orders.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Vault coverage — share of resolved customers with vaulted PII. */}
          <Card
            className="p-5"
            role="region"
            aria-label={
              vault
                ? `PII vault coverage: ${vault.coverage_pct} percent`
                : 'PII vault coverage: not available yet'
            }
          >
            <CardContent className="space-y-1 p-0">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Vault coverage
              </p>
              {vault ? (
                <>
                  <p className="text-2xl font-bold leading-tight tabular-nums text-foreground">
                    {vault.coverage_pct}%
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {vault.vaulted_customers.toLocaleString('en-IN')} of{' '}
                    {vault.resolved_customers.toLocaleString('en-IN')} resolved customers
                  </p>
                </>
              ) : (
                <p className="text-sm italic text-muted-foreground">Not available yet</p>
              )}
            </CardContent>
          </Card>

          {/* Effective confidence — the identity-graph trust tier (DQ gate). */}
          <Card
            className="p-5"
            role="region"
            aria-label={
              dq && dq.state === 'has_data'
                ? `Effective confidence grade ${dq.effectiveConfidence}, ${dq.gate.tier}`
                : 'Effective confidence: not available yet'
            }
          >
            <CardContent className="space-y-1 p-0">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                Effective confidence
              </p>
              {dq && dq.state === 'has_data' ? (
                <>
                  <p className="text-2xl font-bold leading-tight tabular-nums text-foreground">
                    {dq.effectiveConfidence}
                  </p>
                  <p className="text-xs capitalize text-muted-foreground">
                    {dq.gate.tier} · governs billing &amp; MMM eligibility
                  </p>
                </>
              ) : (
                <p className="text-sm italic text-muted-foreground">
                  No quality grades yet
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Linkage is deterministic — anonymous sessions are stitched only when the{' '}
        <span className="font-mono">brain_anon_id</span> is read back from a real order,
        never inferred.
      </p>
    </section>
  );
}
