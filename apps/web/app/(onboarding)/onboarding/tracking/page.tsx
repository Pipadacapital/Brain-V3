import { Suspense } from 'react';
import { TrackingReadyClient } from './tracking-ready-client';
import { Skeleton } from '@/components/ui/skeleton';
import { WizardSteps, WizardHeader } from '@/components/onboarding/wizard-steps';

export const metadata = { title: 'Tracking Setup — Brain' };

/**
 * Onboarding "tracking ready / add website" interstitial (shown after the brand step).
 * The `?w=1|0` search param tells us whether a website was captured at brand-create
 * (snippet state) or skipped (add-website state). Reading searchParams requires a client
 * boundary under <Suspense> (Next App Router) — delegated to TrackingReadyClient.
 *
 * Still part of step 1 (brand setup) — the pixel is provisioned from the brand's website,
 * so this is the tail of "Set up your brand", not its own wizard step.
 */
export default function OnboardingTrackingPage() {
  return (
    <div className="space-y-8">
      <WizardSteps current={1} />
      <WizardHeader
        title="Set up tracking"
        description="Install your tracking pixel to start collecting first-party data from your store."
      />
      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <TrackingReadyClient />
      </Suspense>
    </div>
  );
}
