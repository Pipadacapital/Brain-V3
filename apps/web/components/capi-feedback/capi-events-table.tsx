'use client';

/**
 * CapiEventsTable — the last-N CAPI passback log rows (Phase 6).
 *
 * Makes the gate VISIBLE per-event: a 'Blocked — no consent' row is the proof the gate
 * denied a non-consented passback (the SLO=0 / non_consented_sends made visible); a
 * 'Would send (dev)' row is the honest dev boundary (matched & gated, but not sent).
 *
 * PII: rows carry a TRUNCATED event_id (a deterministic sha256 — NEVER PII), the status,
 * the value (minor units + currency, formatted minor→major at render), the match-key
 * count (0..4), and timestamps. NO subject_hash, NO raw email/phone.
 *
 * Money: value_minor is a bigint string + currency_code; formatMoneyDisplay does the
 * minor→major locale-aware render (no float math in the client). A blocked row still
 * carries the order value (the conversion that WOULD have been passed back).
 *
 * A11y: a real <table> with a caption + scope headers; the status is an icon+word badge
 * (CapiStatusBadge), never colour alone; the match-key count is a number + label.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CapiStatusBadge } from './capi-status-badge';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CapiFeedbackEventsResponse, CapiFeedbackEventRow } from '@/lib/api/types';
import type { CurrencyCode } from '@brain/money';

const SUPPORTED_CURRENCIES = new Set<string>(['INR', 'AED', 'SAR']);

/** Map an engine block reason code → a human label (display only). */
const REASON_LABEL: Record<string, string> = {
  consent_absent: 'No advertising consent',
  consent_withdrawn: 'Advertising consent withdrawn',
  unknown: 'Unknown (fail-closed)',
};

function reasonLabel(reason: string | null): string {
  if (!reason) return '';
  return REASON_LABEL[reason] ?? reason;
}

/** Safe money render — falls back to a plain minor+code string for an unsupported currency. */
function money(row: CapiFeedbackEventRow): string {
  const code = row.currency_code;
  if (SUPPORTED_CURRENCIES.has(code)) {
    try {
      return formatMoneyDisplay(row.value_minor, code as CurrencyCode);
    } catch {
      return `${row.value_minor} ${code}`;
    }
  }
  return `${row.value_minor} ${code}`;
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

export function CapiEventsTable({
  data,
}: {
  data: Extract<CapiFeedbackEventsResponse, { state: 'has_data' }>;
}) {
  const events = data.events ?? [];

  return (
    <Card data-testid="capi-events-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Recent passback events
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          The last {events.length} conversion events evaluated for Meta passback — each
          gated by can_contact(advertising). A blocked row is the proof the gate denied a
          non-consented passback.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              The most recent CAPI passback events, each showing a truncated event id, the
              status, the order value, the Meta match-key count, and the time.
            </caption>
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-2 text-left font-medium">Event</th>
                <th scope="col" className="py-2 text-left font-medium">Status</th>
                <th scope="col" className="py-2 text-right font-medium">Value</th>
                <th scope="col" className="py-2 text-right font-medium">Match keys</th>
                <th scope="col" className="py-2 text-right font-medium">When (IST)</th>
              </tr>
            </thead>
            <tbody>
              {events.map((row, i) => (
                <tr
                  key={`${row.event_id_short}-${i}`}
                  className="border-b last:border-0"
                  data-testid="capi-events-row"
                  data-status={row.status}
                >
                  <td className="py-2 font-mono text-xs text-muted-foreground">
                    {row.event_id_short || '—'}
                  </td>
                  <td className="py-2">
                    <CapiStatusBadge status={row.status} />
                    {row.status === 'blocked_no_consent' && row.block_reason && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {reasonLabel(row.block_reason)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums text-foreground">
                    {money(row)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    <span aria-label={`${row.match_key_count} of 4 Meta match keys`}>
                      {row.match_key_count}/4
                    </span>
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
