'use client';

/**
 * GateActivityTable — the last-N can_contact() gate decisions (D13).
 *
 * This is the surface that makes the DEFAULT-CLOSED posture VISIBLE: every row is a
 * real gate evaluation from audit_log (action='notification.can_contact'), showing the
 * decision (allow / block / queue) + the reason + the channel/purpose. A
 * 'Blocked — consent_absent' row is the proof the gate denied an un-consented send.
 *
 * PII: rows carry channel + purpose + reason ONLY — never a recipient (the engine
 * audits a subject_hash, which we do not surface here). No raw email/phone.
 *
 * A11y: a real <table> with a caption + scope headers; the decision is an icon+word
 * badge (GateDecisionBadge), never colour alone; the reason is a human-readable word.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { GateDecisionBadge } from './gate-decision-badge';
import type { ConsentGateActivityResponse, ConsentGateActivityRow } from '@/lib/api/types';

/** Map an engine reason code → a human label (display only; the code is the source). */
const REASON_LABEL: Record<string, string> = {
  transactional_exempt: 'Transactional (exempt)',
  allowed: 'Consent on file',
  consent_absent: 'No consent recorded',
  consent_withdrawn: 'Consent withdrawn',
  dlt_unregistered: 'DLT template not registered',
  ncpr_dnd: 'On DND / NCPR registry',
  unknown: 'Unknown (fail-closed)',
  out_of_window: 'Outside 9–9 IST window',
};

function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}

function timeLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function ChannelCell({ row }: { row: ConsentGateActivityRow }) {
  const parts = [row.channel, row.purpose].filter(Boolean);
  return (
    <span className="text-muted-foreground">
      {parts.length > 0 ? parts.join(' · ') : '—'}
    </span>
  );
}

export function GateActivityTable({
  data,
}: {
  data: Extract<ConsentGateActivityResponse, { state: 'has_data' }>;
}) {
  return (
    <Card data-testid="consent-gate-activity-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Recent gate decisions
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          The last {data.decisions.length} can_contact() evaluations —{' '}
          {data.allow_count} allowed, {data.block_count} blocked, {data.queue_count} queued.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              The most recent can_contact() gate decisions, each showing the decision,
              the reason, the channel and purpose, and the time.
            </caption>
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-2 text-left font-medium">Decision</th>
                <th scope="col" className="py-2 text-left font-medium">Reason</th>
                <th scope="col" className="py-2 text-left font-medium">Channel · purpose</th>
                <th scope="col" className="py-2 text-right font-medium">When (IST)</th>
              </tr>
            </thead>
            <tbody>
              {data.decisions.map((row, i) => (
                <tr
                  key={`${row.occurred_at}-${i}`}
                  className="border-b last:border-0"
                  data-testid="consent-gate-activity-row"
                  data-decision={row.decision}
                  data-reason={row.reason}
                >
                  <td className="py-2">
                    <GateDecisionBadge decision={row.decision} />
                  </td>
                  <td className="py-2 text-foreground">{reasonLabel(row.reason)}</td>
                  <td className="py-2">
                    <ChannelCell row={row} />
                  </td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {timeLabel(row.occurred_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
