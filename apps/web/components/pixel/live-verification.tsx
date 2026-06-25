'use client';

/**
 * LiveVerification — the honest "waiting for your first event…" → "first event
 * received" flip (the stakeholder-visible proof the pixel works).
 *
 * HONESTY: the flip is driven ONLY by useTrackingHealth — it shows "received" iff a
 * real Bronze event has landed for the brand (health.state === 'has_data'). It is
 * NEVER faked, never optimistic.
 *
 * A11y: status is icon + text label, never colour-only; role="status" + aria-live so
 * a screen reader announces the flip.
 */

import * as React from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { Alert } from '@/components/ui/alert';
import { ErrorCard } from '@/components/ui/error-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTrackingHealth } from '@/lib/hooks/use-tracking-health';
import { hasFirstEvent } from './tracking-status';
import { formatRelativeTime } from '@/components/analytics/data-health-relative-time';

export function LiveVerification() {
  const { data: health, isLoading, error, refetch } = useTrackingHealth({ livePoll: true });

  if (isLoading) {
    return (
      <SectionCard
        title="Live verification"
        description="Checking for your first collected event…"
        data-testid="live-verification-card"
      >
        <Skeleton className="h-14 w-full rounded-md" />
      </SectionCard>
    );
  }

  if (error) {
    return (
      <SectionCard title="Live verification" data-testid="live-verification-card">
        <ErrorCard error={error} retry={refetch} />
      </SectionCard>
    );
  }

  const received = hasFirstEvent(health);
  const lastEventAt = health?.state === 'has_data' ? health.lastEventAt : null;

  return (
    <SectionCard
      title="Live verification"
      description="This flips automatically the moment your first real event reaches Brain — no simulation."
      data-testid="live-verification-card"
    >
      {received ? (
        <Alert
          variant="success"
          title="First event received"
          icon={<CheckCircle2 />}
          data-testid="verification-received"
          data-state="received"
        >
          Your pixel is sending data to Brain
          {lastEventAt ? <> · last event {formatRelativeTime(lastEventAt)}</> : null}.
        </Alert>
      ) : (
        <Alert
          variant="neutral"
          title="Waiting for your first event…"
          icon={<Loader2 className="animate-spin" />}
          data-testid="verification-waiting"
          data-state="waiting"
        >
          Install the snippet and load a page on your site — this updates live. No event has reached Brain
          for this brand yet; nothing is faked here.
        </Alert>
      )}
    </SectionCard>
  );
}
