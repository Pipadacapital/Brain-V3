'use client';

import { useSearchParams } from 'next/navigation';
import { TrackingReady } from '@/components/onboarding/tracking-ready';

/**
 * Client boundary that reads `?w=1|0` (website provided vs skipped) and renders the
 * TrackingReady interstitial. Default (no/unknown param) is the honest add-website state
 * — we never claim a snippet exists unless `w=1`.
 */
export function TrackingReadyClient() {
  const params = useSearchParams();
  const websiteProvided = params.get('w') === '1';
  return <TrackingReady websiteProvided={websiteProvided} />;
}
