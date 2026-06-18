'use client';

/**
 * CapiDeletionsTable — the last-N retroactive-deletion requests (Phase 6).
 *
 * Proof the consent-withdrawal → CAPI-deletion path works: on a consent withdrawal (a
 * consent_tombstone for the 'advertising' category, or all), the CapiDeletionConsumer
 * (stream-worker) writes a deletion request within the ≤15-min SLA. Each row shows the
 * status, how many prior passback events it targeted, and the request→complete latency.
 *
 * PII: NO subject_hash is surfaced (the withdrawn subject's consent key never leaves the
 * query). In dev, status='would_delete_dev' (matched & queued, but not sent — no creds).
 *
 * A11y: a real <table> with a caption + scope headers; the status is an icon+word badge
 * (CapiStatusBadge), never colour alone; the latency carries an explicit unit label.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CapiStatusBadge } from './capi-status-badge';
import type {
  CapiFeedbackDeletionsResponse,
  CapiFeedbackDeletionRow,
} from '@/lib/api/types';

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

/** Latency render — seconds → "12s" / "3m 04s"; pending when null. Asserts the ≤15-min SLA. */
function latencyLabel(row: CapiFeedbackDeletionRow): string {
  if (row.latency_seconds == null) return 'pending';
  const s = row.latency_seconds;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${String(rem).padStart(2, '0')}s`;
}

export function CapiDeletionsTable({
  data,
}: {
  data: Extract<CapiFeedbackDeletionsResponse, { state: 'has_data' }>;
}) {
  const deletions = data.deletions ?? [];

  return (
    <Card data-testid="capi-deletions-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Retroactive deletions
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          The last {deletions.length} consent-withdrawal deletion requests — fired within
          the ≤15-minute SLA when a subject withdraws advertising consent.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              The most recent retroactive CAPI deletion requests, each showing the status,
              the number of targeted events, the request time, and the completion latency.
            </caption>
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-2 text-left font-medium">Status</th>
                <th scope="col" className="py-2 text-right font-medium">Events targeted</th>
                <th scope="col" className="py-2 text-right font-medium">Requested (IST)</th>
                <th scope="col" className="py-2 text-right font-medium">Latency</th>
              </tr>
            </thead>
            <tbody>
              {deletions.map((row, i) => (
                <tr
                  key={`${row.requested_at}-${i}`}
                  className="border-b last:border-0"
                  data-testid="capi-deletions-row"
                  data-status={row.status}
                >
                  <td className="py-2">
                    <CapiStatusBadge status={row.status} />
                  </td>
                  <td className="py-2 text-right tabular-nums text-foreground">
                    {row.event_count}
                  </td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {timeLabel(row.requested_at)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    <span aria-label={`Deletion latency: ${latencyLabel(row)}`}>
                      {latencyLabel(row)}
                    </span>
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
