import { Suspense } from 'react';
import { TrackingReadyClient } from './tracking-ready-client';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata = { title: 'Tracking Setup — Brain' };

/**
 * Onboarding "tracking ready / add website" interstitial (shown after the brand step).
 * The `?w=1|0` search param tells us whether a website was captured at brand-create
 * (snippet state) or skipped (add-website state). Reading searchParams requires a client
 * boundary under <Suspense> (Next App Router) — delegated to TrackingReadyClient.
 */
export default function OnboardingTrackingPage() {
  return (
    <div>
      <div className="mb-8">
        <p
          className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          aria-label="Step 1 of 3"
          data-testid="step-indicator"
        >
          Step 1 of 3
        </p>
        <h2 className="text-2xl font-bold text-foreground">Set up tracking</h2>
        <p className="mt-1 text-muted-foreground">
          Install your tracking pixel to start collecting first-party data from your store.
        </p>
      </div>
      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <TrackingReadyClient />
      </Suspense>
    </div>
  );
}
