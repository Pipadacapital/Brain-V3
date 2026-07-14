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

import { useState } from 'react';
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
import { DataWindowBadge } from '@/components/ui/data-window-badge';
import { TableSearch, filterRows } from '@/components/ui/table-search';
import { VerifyLink } from '@/components/ui/verify-link';
import {
  useCapiFeedbackSummary,
  useCapiFeedbackEvents,
  useCapiFeedbackDeletions,
} from '@/lib/hooks/use-capi-feedback';
import type {
  CapiFeedbackSummaryResponse,
  CapiFeedbackEventsResponse,
  CapiFeedbackDeletionsResponse,
} from '@/lib/api/types';

type SummaryHasData = Extract<CapiFeedbackSummaryResponse, { state: 'has_data' }>;
type EventsHasData = Extract<CapiFeedbackEventsResponse, { state: 'has_data' }>;
type DeletionsHasData = Extract<CapiFeedbackDeletionsResponse, { state: 'has_data' }>;

/** A small section wrapper with a heading + labelled region. */
function Panel({
  title,
  description,
  testId,
  id,
  children,
}: {
  title: string;
  description?: string;
  testId: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-label={title} data-testid={testId} className="scroll-mt-24 space-y-3">
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
            Once a confirmed purchase is finalized for a customer who has granted{' '}
            <span className="font-medium text-foreground">advertising</span> consent, it is
            matched, checked against that consent, and recorded here. Conversions for
            customers without consent are <span className="font-medium text-foreground">blocked</span>,
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
      title="Test mode — nothing is actually sent to Meta yet"
      icon={<FlaskConical className="size-4" />}
      aria-label="Development boundary"
      data-testid="capi-dev-boundary-banner"
    >
      Conversions are matched, scrambled (hashed), and checked against consent — but this
      environment has no live Meta connection, so nothing is actually sent. These events
      show <span className="font-medium">would-send</span>; they are never sent and never
      faked. Live sending switches on with a production Meta connection.
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
        help="Conversions shared with Meta to improve its ad targeting — only ever with the customer's advertising consent."
        value={passedBack.toLocaleString('en-IN')}
        sublabel={`${Number(data.sent ?? '0').toLocaleString('en-IN')} sent · ${Number(data.would_send_dev ?? '0').toLocaleString('en-IN')} would-send (test mode)`}
        data-testid="capi-kpi-passed-back"
      />

      {/* The SLO=0 (non_consented_sends) made VISIBLE — every non-consented conversion is
          a BLOCK here, never a send. */}
      <KpiTile
        label="Blocked by consent"
        help="Conversions we refused to share because the customer hadn't given advertising consent — the target is always zero sent without consent."
        value={blocked.toLocaleString('en-IN')}
        sublabel="withheld — nothing sent without consent"
        data-testid="capi-kpi-blocked"
      />

      <KpiTile
        label="Deletions"
        help="Requests sent to Meta to delete previously shared conversions after a customer withdrew consent."
        value={deletions.toLocaleString('en-IN')}
        sublabel="after consent withdrawals"
        data-testid="capi-kpi-deletions"
      />

      <KpiTile
        label="Match quality"
        help="How completely Meta can match these conversions to real people — based on how many identifying fields (like email or phone, scrambled) each event carried."
        value={matchPct != null ? `${matchPct.toFixed(1)}%` : null}
        sublabel={
          data.avg_match_keys != null
            ? `avg ${data.avg_match_keys.toFixed(1)} of 4 match fields`
            : 'no events yet'
        }
        data-testid="capi-kpi-match-quality"
      />
    </div>
  );
}

/** Events table + a client-side search that narrows the already-loaded rows (never re-fetches). */
function EventsTableWithSearch({ data }: { data: EventsHasData }) {
  const [query, setQuery] = useState('');
  const rows = data.events ?? [];
  // Search across the human-meaningful columns: the event id, the plain-word status
  // ("blocked no consent", "would send dev", "sent"), the block reason, and the value.
  const filtered = filterRows(
    rows,
    query,
    (r) =>
      `${r.event_id_short} ${r.status.replace(/_/g, ' ')} ${r.block_reason ?? ''} ${r.currency_code} ${r.value_minor}`,
  );

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <TableSearch
          value={query}
          onChange={setQuery}
          placeholder="Search by status, id, or value…"
          aria-label="Search passback events"
        />
      </div>
      {query && filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No passback events match “{query}”. Clear the search to see all {rows.length} recent
            events.
          </CardContent>
        </Card>
      ) : (
        <CapiEventsTable data={{ ...data, events: filtered }} />
      )}
    </div>
  );
}

/** Deletions table + a client-side search over the plain-word status column. */
function DeletionsTableWithSearch({ data }: { data: DeletionsHasData }) {
  const [query, setQuery] = useState('');
  const rows = data.deletions ?? [];
  const filtered = filterRows(
    rows,
    query,
    (r) => `${r.status.replace(/_/g, ' ')} ${r.event_count}`,
  );

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <TableSearch
          value={query}
          onChange={setQuery}
          placeholder="Search by status…"
          aria-label="Search deletion requests"
        />
      </div>
      {query && filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No deletion requests match “{query}”. Clear the search to see all {rows.length} recent
            requests.
          </CardContent>
        </Card>
      ) : (
        <CapiDeletionsTable data={{ ...data, deletions: filtered }} />
      )}
    </div>
  );
}

export function ConversionFeedbackContent() {
  const summary = useCapiFeedbackSummary();
  const events = useCapiFeedbackEvents();
  const deletions = useCapiFeedbackDeletions();

  const summaryData = summary.data;
  const devBoundary = summaryData?.state === 'has_data' && summaryData.dev_boundary === true;
  // The CAPI endpoints return an all-time aggregate + the most-recent log rows (no date
  // window to filter on), so we state the window honestly as "all time" and surface the
  // count of recent events shown — never a fabricated range.
  const recentEventsCount =
    events.data?.state === 'has_data' ? events.data.events.length : undefined;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Conversion Feedback"
        description={
          <>
            Confirmed purchases passed back to Meta to improve its ad targeting — every one
            first clears a check on the customer&apos;s{' '}
            <span className="font-medium text-foreground">advertising</span> consent, which is{' '}
            <span className="font-medium text-foreground">off by default</span>. No consent →
            no passback. Email and phone are scrambled (hashed) before sending; the raw values
            are never stored, logged, or sent.
          </>
        }
        meta={
          <span
            data-testid="capi-platform-label"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            title="Confirmed purchases passed back to Meta via its Conversions API, only with the customer's advertising consent."
          >
            <Target className="h-3 w-3" aria-hidden="true" />
            Meta CAPI
          </span>
        }
      />

      {/* Honest data window — these figures are all-time; there is no date filter to apply. */}
      <DataWindowBadge
        from={null}
        to={null}
        count={recentEventsCount}
        label="recent events"
        data-testid="capi-data-window"
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
          <div className="space-y-3">
            <SummaryBand data={summaryData} />
            {/* Drill-through — every headline count is backed by the records on this page. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="text-muted-foreground">See the records behind these numbers:</span>
              <VerifyLink href="#capi-events-panel" label="Passback events" />
              <VerifyLink href="#capi-deletions-panel" label="Deletion requests" />
            </div>
          </div>
        )}
      </Panel>

      {/* 2 — Events table (per-event gate proof + dev boundary) */}
      <Panel
        title="Passback events"
        description="Recent conversion events evaluated for Meta passback — a blocked row proves the gate denied a non-consented send."
        testId="capi-events-panel"
        id="capi-events-panel"
      >
        {events.isLoading && <PanelSkeleton />}
        {!events.isLoading && events.error && (
          <ErrorCard error={events.error} retry={events.refetch} />
        )}
        {!events.isLoading && !events.error && events.data?.state === 'no_data' && (
          <Card data-testid="capi-events-empty">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No passback events recorded yet. Once a finalized purchase is evaluated, every
              consent decision appears here — including the blocks that prove nothing is
              shared without consent.
            </CardContent>
          </Card>
        )}
        {!events.isLoading && !events.error && events.data?.state === 'has_data' && (
          <EventsTableWithSearch data={events.data} />
        )}
      </Panel>

      {/* 3 — Deletions table (the ≤15-min retroactive-withdrawal path) */}
      <Panel
        title="Retroactive deletions"
        description="Deletion requests sent to Meta within 15 minutes of a customer withdrawing advertising consent."
        testId="capi-deletions-panel"
        id="capi-deletions-panel"
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
              When a customer withdraws advertising consent, a Meta deletion request appears
              here within 15 minutes.
            </CardContent>
          </Card>
        )}
        {!deletions.isLoading && !deletions.error && deletions.data?.state === 'has_data' && (
          <DeletionsTableWithSearch data={deletions.data} />
        )}
      </Panel>

      {/* Footer provenance — BFF-only, gate-backed, hashed. */}
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <p>
          Every figure comes from Brain&apos;s own record of what was (and wasn&apos;t) shared
          with Meta. The consent check is the only way anything leaves — no consent, no
          passback.
        </p>
      </div>
    </div>
  );
}
