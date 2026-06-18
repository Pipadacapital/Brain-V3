'use client';

/**
 * SendWindowCard — the read-only 9am–9pm IST permitted-hours send window (D13).
 *
 * The window is a TCCCPR/DLT regulatory guarantee enforced SERVER-side at the queue
 * (a send blocked only by the window is QUEUED and flushed at 09:00 IST — never
 * dropped, never sent out-of-window). This card DISPLAYS it; it is NOT an editable
 * toggle (the architect scoped it read-only). The "enforced server-side" label makes
 * that explicit so an operator never mistakes it for a client-side hint.
 *
 * in_window_now + next_window_open are COMPUTED SERVER-SIDE (the UI never derives the
 * window from the browser clock — the window is a server fact, not a render).
 *
 * A11y: the in/out-of-window status is icon + word + text, never colour alone.
 */

import { Clock, Sun, Moon, Lock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ConsentWindowConfigResponse } from '@/lib/api/types';

/** Render an ISO ts as IST wall-clock for display (the window is an IST guarantee). */
function istLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function SendWindowCard({ data }: { data: ConsentWindowConfigResponse }) {
  const inWindow = data.in_window_now;
  const StatusIcon = inWindow ? Sun : Moon;

  return (
    <Card data-testid="consent-window-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Clock className="h-4 w-4" aria-hidden="true" />
          Permitted send window
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-2xl font-bold tabular-nums text-foreground">
            {data.window_start} – {data.window_end}
          </span>
          <span className="text-sm text-muted-foreground">IST ({data.timezone})</span>
        </div>

        {/* In/out-of-window status — icon + word + text (never colour-only). */}
        <div
          className="inline-flex items-center gap-1.5 rounded-md border border-current/20 bg-muted px-2 py-1 text-xs font-medium text-foreground"
          role="status"
          aria-label={
            inWindow
              ? 'Currently inside the send window'
              : 'Currently outside the send window'
          }
          data-testid="consent-window-status"
        >
          <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {inWindow ? 'Inside the window now' : 'Outside the window now'}
        </div>

        {!inWindow && (
          <p className="text-xs text-muted-foreground" data-testid="consent-window-next-open">
            Window-blocked sends are queued and flush at the next opening:{' '}
            <span className="font-medium text-foreground">{istLabel(data.next_window_open)}</span>.
            Nothing is sent out-of-window; nothing is dropped.
          </p>
        )}

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            Enforced server-side at the queue (TCCCPR/DLT). This is a guarantee, not a UI
            hint — and not editable here.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}
