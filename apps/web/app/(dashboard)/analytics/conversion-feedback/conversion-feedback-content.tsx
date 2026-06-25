'use client';

/**
 * ConversionFeedbackContent — the Conversion-Feedback / CAPI surface (Phase 6, Track C).
 *
 * The stakeholder-visible proof of the Meta CAPI conversion-passback loop, read ONLY via
 * the BFF (/api/v1/feedback/capi/*) — never the DB, never a direct send path. Three reads:
 *   1. Summary    — Passed back · BLOCKED BY CONSENT (the SLO=0 made visible) · Deletions ·
 *                   Match quality. The blocked-by-consent tile is the non_consented_sends=0
 *                   guarantee, rendered.
 *   2. Events     — the last-N passback log rows (a blocked row = gate denied; a
 *                   would_send_dev row = the honest dev boundary).
 *   3. Deletions  — the last-N retroactive deletion requests (the ≤15-min withdrawal path).
 *
 * THE DEV BOUNDARY, MADE EXPLICIT: in dev there are no live Meta CAPI credentials, so a
 * matched & gated conversion is 'would_send_dev' — matched and gated, but NOT sent. When
 * the summary's dev_boundary flag is true, a labelled banner says so. A real 'sent' only
 * ever appears with live prod creds; nothing here is faked.
 *
 * FAIL-CLOSED / HONEST STATES: skeleton (aria-busy) while loading; ErrorCard with the
 * request_id on error; honest 'no_data' empty (nothing passed back yet — NOT a fabricated
 * zero) when the 0034 tables are empty or not yet migrated.
 *
 * A11y: each block is a labelled <section>; the summary tiles are icon+label (never colour
 * alone); the tables carry captions + scope headers; the dev banner is role="note". No raw
 * PII / no subject_hash is ever rendered (counts + a truncated event_id only).
 *
 * Money: the per-event value is value_minor (bigint string) + currency_code, formatted
 * minor→major by formatMoneyDisplay at render (no float math in the client).
 */

import Link from 'next/link';
import { ShieldCheck, FlaskConical, Send, Trash2, Target, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { CapiEventsTable } from '@/components/capi-feedback/capi-events-table';
import { CapiDeletionsTable } from '@/components/capi-feedback/capi-deletions-table';
import {
  useCapiFeedbackSummary,
  useCapiFeedbackEvents,
  useCapiFeedbackDeletions,
} from '@/lib/hooks/use-capi-feedback';
import type { CapiFeedbackSummaryResponse } from '@/lib/api/types';

type SummaryHasData = Extract<CapiFeedbackSummaryResponse, { state: 'has_data' }>;

/** A small section wrapper with a heading + labelled region. */
function Panel({
  title,
  description,
  testId,
  children,
}: {
  title: string;
  description?: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} data-testid={testId} className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading…">
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

/** The honest empty card — nothing passed back yet (NOT a fabricated zero). */
function NoConversionsEmpty({ testId }: { testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <Send className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No conversions matched yet</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Once a realized purchase is finalized for a subject who has granted{' '}
            <span className="font-medium text-foreground">advertising</span> consent, it is
            matched, gated by can_contact(), and recorded here. Conversions for
            non-consented subjects are <span className="font-medium text-foreground">blocked</span>,
            never passed back.
          </p>
        </div>
        <Link href="/settings/connectors">
          <Button variant="outline" size="sm" data-testid="capi-feedback-connect-cta">
            Connect Meta
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

/** The dev-boundary banner — explicit "would-send in dev, no live Meta creds". */
function DevBoundaryBanner() {
  return (
    <Alert
      variant="warning"
      title="Would-send in dev — no live Meta CAPI credentials"
      icon={<FlaskConical className="size-4" />}
      aria-label="Development boundary"
      data-testid="capi-dev-boundary-banner"
    >
      Conversions are matched, hashed, and gated by can_contact() — but the actual Meta
      send is a default-closed stub in development (no access token / pixel id). These
      events show <span className="font-medium">would-send</span>; they are never sent and
      never faked. Live sending is a platform follow-up.
    </Alert>
  );
}

/** The summary band — Passed back · Blocked by consent (SLO=0) · Deletions · Match quality. */
function SummaryBand({ data }: { data: SummaryHasData }) {
  const passedBack = Number(data.passed_back ?? '0');
  const blocked = Number(data.blocked_by_consent ?? '0');
  const deletions = Number(data.deletion_requests ?? '0');
  const matchPct = data.match_quality_pct;

  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="capi-summary-band"
    >
      <KpiTile
        label="Passed back"
        value={passedBack.toLocaleString('en-IN')}
        sublabel={`${Number(data.sent ?? '0').toLocaleString('en-IN')} sent · ${Number(data.would_send_dev ?? '0').toLocaleString('en-IN')} would-send (dev)`}
        data-testid="capi-kpi-passed-back"
      />

      {/* The SLO=0 (non_consented_sends) made VISIBLE — every non-consented conversion is
          a BLOCK here, never a send. */}
      <KpiTile
        label="Blocked by consent"
        value={blocked.toLocaleString('en-IN')}
        sublabel="non-consented passbacks denied (SLO target: 0 sent)"
        data-testid="capi-kpi-blocked"
      />

      <KpiTile
        label="Deletions"
        value={deletions.toLocaleString('en-IN')}
        sublabel="retroactive withdrawal requests"
        data-testid="capi-kpi-deletions"
      />

      <KpiTile
        label="Match quality"
        value={matchPct != null ? `${matchPct.toFixed(1)}%` : null}
        sublabel={
          data.avg_match_keys != null
            ? `avg ${data.avg_match_keys.toFixed(1)} of 4 Meta keys`
            : 'no events yet'
        }
        data-testid="capi-kpi-match-quality"
      />
    </div>
  );
}

export function ConversionFeedbackContent() {
  const summary = useCapiFeedbackSummary();
  const events = useCapiFeedbackEvents();
  const deletions = useCapiFeedbackDeletions();

  const summaryData = summary.data;
  const devBoundary = summaryData?.state === 'has_data' && summaryData.dev_boundary === true;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Conversion Feedback"
        description={
          <>
            Realized conversions passed back to Meta to improve optimization — every passback
            first clears the single <span className="font-medium text-foreground">can_contact()</span>{' '}
            gate on the <span className="font-medium text-foreground">advertising</span> consent
            category, which is{' '}
            <span className="font-medium text-foreground">default-closed</span>. No consent →
            no passback. PII is SHA-256-hashed at the boundary (Meta match spec); raw email and
            phone are never stored, logged, or sent.
          </>
        }
        meta={
          <span
            data-testid="capi-platform-label"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Realized conversions passed back to Meta via the Conversions API, behind the can_contact() consent gate."
          >
            <Target className="h-3 w-3" aria-hidden="true" />
            Meta CAPI
          </span>
        }
      />

      {/* The dev boundary — explicit when any event is 'would_send_dev'. */}
      {devBoundary && <DevBoundaryBanner />}

      {/* 1 — Summary band (the SLO=0 made visible) */}
      <Panel
        title="Passback summary"
        description="Passed back vs blocked by consent, retroactive deletions, and Meta match quality."
        testId="capi-summary-panel"
      >
        {summary.isLoading && <PanelSkeleton />}
        {!summary.isLoading && summary.error && (
          <ErrorCard error={summary.error} retry={summary.refetch} />
        )}
        {!summary.isLoading && !summary.error && summaryData?.state === 'no_data' && (
          <NoConversionsEmpty testId="capi-summary-empty" />
        )}
        {!summary.isLoading && !summary.error && summaryData?.state === 'has_data' && (
          <SummaryBand data={summaryData} />
        )}
      </Panel>

      {/* 2 — Events table (per-event gate proof + dev boundary) */}
      <Panel
        title="Passback events"
        description="Recent conversion events evaluated for Meta passback — a blocked row proves the gate denied a non-consented send."
        testId="capi-events-panel"
      >
        {events.isLoading && <PanelSkeleton />}
        {!events.isLoading && events.error && (
          <ErrorCard error={events.error} retry={events.refetch} />
        )}
        {!events.isLoading && !events.error && events.data?.state === 'no_data' && (
          <Card data-testid="capi-events-empty">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No passback events recorded yet. Once a finalized purchase is evaluated for a
              consented subject, every can_contact() decision appears here — including the
              blocks that prove the gate is closed by default.
            </CardContent>
          </Card>
        )}
        {!events.isLoading && !events.error && events.data?.state === 'has_data' && (
          <CapiEventsTable data={events.data} />
        )}
      </Panel>

      {/* 3 — Deletions table (the ≤15-min retroactive-withdrawal path) */}
      <Panel
        title="Retroactive deletions"
        description="Consent-withdrawal deletion requests — fired within the ≤15-minute SLA when a subject withdraws advertising consent."
        testId="capi-deletions-panel"
      >
        {deletions.isLoading && <PanelSkeleton />}
        {!deletions.isLoading && deletions.error && (
          <ErrorCard error={deletions.error} retry={deletions.refetch} />
        )}
        {!deletions.isLoading && !deletions.error && deletions.data?.state === 'no_data' && (
          <Card data-testid="capi-deletions-empty">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                No consent withdrawals yet.
              </span>{' '}
              When a subject withdraws advertising consent, a retroactive Meta deletion is
              requested here within 15 minutes.
            </CardContent>
          </Card>
        )}
        {!deletions.isLoading && !deletions.error && deletions.data?.state === 'has_data' && (
          <CapiDeletionsTable data={deletions.data} />
        )}
      </Panel>

      {/* Footer provenance — BFF-only, gate-backed, hashed. */}
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <p>
          Every figure is read via the BFF over the CAPI passback log — never a direct send
          path. The can_contact() gate is the sole outbound chokepoint; no consent, no
          passback.
        </p>
      </div>
    </div>
  );
}
