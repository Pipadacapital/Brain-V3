'use client';

/**
 * LiveVerification — the honest "waiting for your first event…" → "✅ first event
 * received" flip (Phase 1a, the stakeholder-visible proof the pixel works).
 *
 * HONESTY: the flip is driven ONLY by useTrackingHealth — it shows "received" iff a
 * real Bronze event has landed for the brand (health.state === 'has_data'). It is
 * NEVER faked, never optimistic.
 *
 * A11y:
 *   - Status is icon + text label, never colour-only.
 *   - role="status" + aria-live="polite" so a screen reader announces the flip.
 *   - The polling spinner is decorative (aria-hidden); the state text is the truth.
 */

import * as React from 'react';
import { CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorCard } from '@/components/ui/error-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTrackingHealth } from '@/lib/hooks/use-tracking-health';
import { hasFirstEvent } from './tracking-status';
import { formatRelativeTime } from '@/components/analytics/data-health-relative-time';
import { cn } from '@/lib/utils';

export function LiveVerification() {
  const { data: health, isLoading, error, refetch } = useTrackingHealth({ livePoll: true });

  if (isLoading) {
    return (
      <Card data-testid="live-verification-card">
        <CardHeader>
          <CardTitle>Live verification</CardTitle>
          <CardDescription>Checking for your first collected event…</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card data-testid="live-verification-card">
        <CardHeader>
          <CardTitle>Live verification</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorCard error={error} retry={refetch} />
        </CardContent>
      </Card>
    );
  }

  const received = hasFirstEvent(health);
  const lastEventAt = health?.state === 'has_data' ? health.lastEventAt : null;

  return (
    <Card data-testid="live-verification-card">
      <CardHeader>
        <CardTitle>Live verification</CardTitle>
        <CardDescription>
          This flips automatically the moment your first real event reaches Brain — no
          simulation.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {received ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="First event received. Your pixel is sending data to Brain."
            data-testid="verification-received"
            data-state="received"
            className={cn(
              'flex items-center gap-3 rounded-md px-4 py-3',
              'bg-status-green-50 text-status-green-700',
            )}
          >
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold">First event received</p>
              <p className="text-xs text-muted-foreground">
                Your pixel is sending data to Brain
                {lastEventAt ? <> · last event {formatRelativeTime(lastEventAt)}</> : null}.
              </p>
            </div>
          </div>
        ) : (
          <div
            role="status"
            aria-live="polite"
            aria-label="Waiting for your first event. No event has reached Brain yet."
            data-testid="verification-waiting"
            data-state="waiting"
            className="flex items-center gap-3 rounded-md bg-muted/50 px-4 py-3 text-muted-foreground"
          >
            <Loader2 className="h-5 w-5 shrink-0 animate-spin" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                Waiting for your first event…
              </p>
              <p className="text-xs">
                Install the snippet and load a page on your site. This updates live.
              </p>
            </div>
          </div>
        )}

        {!received && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            No event has reached Brain for this brand yet — nothing is faked here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
