'use client';

/**
 * OnboardingGate — forward-only wizard guard (feat-onboarding-ux Deliverable 5).
 *
 * Wraps a wizard step. On mount it reads the authoritative `onboarding_status` from the BFF
 * (/v1/bff/me) and, if the user is PAST this step, replaces the route forward to where they
 * belong. This kills the live-test bug where browser Back to a completed create step
 * re-showed an already-submitted form: status `brand_created`+ on /onboarding/start →
 * forward-redirect to /onboarding/integrations; the create form is never re-rendered.
 *
 * Defense-in-depth: even if the gate is bypassed, the merged provision command is idempotent
 * per user (already-a-member → returns the existing org/brand 200), so no duplicate is created.
 *
 * `minStatus` is the lowest status for which THIS page is still the right place. If the user's
 * rank exceeds it, we forward-redirect. While the status is loading we render a skeleton (no
 * flash of a step the user has already completed).
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '@/lib/api/client';
import { resolveOnboardingRoute, onboardingRank } from '@/lib/onboarding-route';
import { Skeleton } from '@/components/ui/skeleton';
import type { OnboardingStatus } from '@/lib/api/types';

interface OnboardingGateProps {
  /** The status this page handles. If the user is strictly past it, redirect forward. */
  step: OnboardingStatus | null;
  children: React.ReactNode;
}

export function OnboardingGate({ step, children }: OnboardingGateProps) {
  const router = useRouter();

  const { data, isLoading } = useQuery({
    queryKey: ['bff', 'me', 'onboarding'],
    queryFn: () => authApi.bffMe(),
    // Always re-check on mount (incl. browser Back) — never serve a stale "you're on step 1".
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });

  const status = data?.onboarding_status ?? null;
  const isPast = data ? onboardingRank(status) > onboardingRank(step) : false;

  useEffect(() => {
    if (isPast) {
      router.replace(resolveOnboardingRoute(status));
    }
  }, [isPast, status, router]);

  // While resolving status, or while a forward-redirect is in flight, don't render the step.
  if (isLoading || isPast) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading your setup…">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return <>{children}</>;
}
