'use client';

/**
 * Onboarding route-group error boundary (AUD-IMPL-001) — a render crash mid-onboarding degrades
 * to a contained, retryable error state inside the onboarding layout (progress is server-side;
 * retry re-renders the segment without losing the user's place in the flow).
 */
import { RouteErrorFallback } from '@/components/ui/route-error-fallback';

export default function OnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} area="onboarding" />;
}
