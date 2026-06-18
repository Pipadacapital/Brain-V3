'use client';

/**
 * ConsentComplianceContent — the per-brand Consent / Compliance surface (D13,
 * feat-d13-consent-cancontact Track C).
 *
 * Four panels, ALL read via the BFF only (/api/v1/consent/*) — never the DB, never a
 * direct send-path read:
 *   1. Consent coverage      — granted vs withdrawn subjects per category.
 *   2. Suppression summary   — the fail-closed marketing-suppression count.
 *   3. Send-window config    — the read-only 9–9 IST window (server-enforced).
 *   4. Gate activity         — the last-N can_contact() decisions by reason (default-closed proof).
 *
 * DEFAULT-CLOSED POSTURE, MADE EXPLICIT: when the consent system-of-record is empty
 * (no_data), the surface does NOT show a fabricated zero — it shows the honest
 * fail-closed message: "blocked by default until consent is recorded". This is the
 * compliance-correct empty state (no consent == no send).
 *
 * Honest states: skeleton (aria-busy) while loading; ErrorCard with the request_id on
 * error; honest fail-closed empty when the SoR has no rows yet.
 *
 * A11y: each panel is a labelled <section>; tables carry captions + scope headers;
 * every status (decision, window) is icon+label, never colour alone. No raw PII is
 * ever rendered (counts + hashes + decision metadata only).
 *
 * NO money on this surface (consent is not monetary). NO metric-registry numbers are
 * invented in the client — counts come straight from the BFF (bigint strings, display
 * formatting only, no client-side arithmetic).
 */

import { ShieldQuestion } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { CoverageCard } from '@/components/consent/coverage-card';
import { SuppressionCard } from '@/components/consent/suppression-card';
import { SendWindowCard } from '@/components/consent/send-window-card';
import { GateActivityTable } from '@/components/consent/gate-activity-table';
import {
  useConsentCoverage,
  useConsentSuppressionSummary,
  useConsentGateActivity,
  useConsentWindowConfig,
} from '@/lib/hooks/use-consent';

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

/** The honest fail-closed empty card — the default-closed posture, made explicit. */
function FailClosedEmpty({ testId }: { testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <div className="text-muted-foreground" aria-hidden="true">
          <ShieldQuestion className="h-8 w-8" />
        </div>
        <div>
          <p className="font-medium text-foreground">No consent records yet</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Sends are <span className="font-medium text-foreground">blocked by default</span>{' '}
            (fail-closed). A subject becomes contactable only once a consent grant is
            recorded — until then, can_contact() denies every marketing send.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading…">
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export function ConsentComplianceContent() {
  const coverage = useConsentCoverage();
  const suppression = useConsentSuppressionSummary();
  const gate = useConsentGateActivity();
  const window = useConsentWindowConfig();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Consent &amp; Compliance</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          Per-brand consent posture and the outbound gate. Every send passes the single
          can_contact() gate, which is{' '}
          <span className="font-medium text-foreground">default-closed</span>: unknown or
          absent consent, an unregistered DLT template, or an out-of-window time all block
          the send. Nothing here is editable — the window and registries are enforced
          server-side (DPDP / TCCCPR).
        </p>
      </div>

      {/* 2 — Suppression summary (the headline fail-closed count) */}
      <Panel
        title="Marketing suppression"
        description="How many subjects are blocked vs sendable for marketing right now."
        testId="consent-suppression-panel"
      >
        {suppression.isLoading && <PanelSkeleton />}
        {!suppression.isLoading && suppression.error && (
          <ErrorCard error={suppression.error} retry={suppression.refetch} />
        )}
        {!suppression.isLoading && !suppression.error && suppression.data?.state === 'no_data' && (
          <FailClosedEmpty testId="consent-suppression-empty" />
        )}
        {!suppression.isLoading && !suppression.error && suppression.data?.state === 'has_data' && (
          <SuppressionCard data={suppression.data} />
        )}
      </Panel>

      {/* 1 — Consent coverage by category */}
      <Panel
        title="Consent coverage"
        description="Granted vs withdrawn subjects across the four DPDP consent categories."
        testId="consent-coverage-panel"
      >
        {coverage.isLoading && <PanelSkeleton />}
        {!coverage.isLoading && coverage.error && (
          <ErrorCard error={coverage.error} retry={coverage.refetch} />
        )}
        {!coverage.isLoading && !coverage.error && coverage.data?.state === 'no_data' && (
          <FailClosedEmpty testId="consent-coverage-empty" />
        )}
        {!coverage.isLoading && !coverage.error && coverage.data?.state === 'has_data' && (
          <CoverageCard data={coverage.data} />
        )}
      </Panel>

      {/* 3 — Send-window config (read-only, server-enforced) */}
      <Panel
        title="Send window"
        description="The permitted 9am–9pm IST commercial-message window — server-enforced at the queue."
        testId="consent-window-panel"
      >
        {window.isLoading && <PanelSkeleton />}
        {!window.isLoading && window.error && (
          <ErrorCard error={window.error} retry={window.refetch} />
        )}
        {!window.isLoading && !window.error && window.data && (
          <SendWindowCard data={window.data} />
        )}
      </Panel>

      {/* 4 — Gate activity (the default-closed proof) */}
      <Panel
        title="Gate activity"
        description="Recent can_contact() decisions — the default-closed gate, made visible."
        testId="consent-gate-panel"
      >
        {gate.isLoading && <PanelSkeleton />}
        {!gate.isLoading && gate.error && (
          <ErrorCard error={gate.error} retry={gate.refetch} />
        )}
        {!gate.isLoading && !gate.error && gate.data?.state === 'no_data' && (
          <Card data-testid="consent-gate-empty">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No gate decisions recorded yet. Once a send is attempted, every can_contact()
              evaluation appears here — including the blocks that prove the gate is closed
              by default.
            </CardContent>
          </Card>
        )}
        {!gate.isLoading && !gate.error && gate.data?.state === 'has_data' && (
          <GateActivityTable data={gate.data} />
        )}
      </Panel>
    </div>
  );
}
