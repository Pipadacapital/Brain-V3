'use client';

import { CheckCircle, Circle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { useOnboardingProgress } from '@/lib/hooks/use-dashboard';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Onboarding Progress widget
 * Source: deterministic from existence of Postgres rows (arch plan §6.4)
 * No OLAP, no analytics, no fake data.
 */
export function OnboardingProgressCard() {
  const { data, isLoading, error, refetch } = useOnboardingProgress();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <ErrorCard error={error} retry={refetch} />
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return null;
  }

  const completedCount = data.steps.filter((s) => s.completed).length;
  const progress = Math.round((completedCount / data.steps.length) * 100);

  return (
    <Card data-testid="onboarding-progress-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Onboarding Progress
        </CardTitle>
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs text-muted-foreground">
            {completedCount} of {data.steps.length} steps complete
          </span>
          <span className="text-xs font-semibold text-foreground">{progress}%</span>
        </div>
        {/* Progress bar */}
        <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Onboarding ${progress}% complete`}>
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ol className="space-y-2" aria-label="Onboarding steps">
          {data.steps.map((step) => (
            <li key={step.id} className="flex items-center gap-3">
              {step.completed ? (
                <CheckCircle
                  className="h-5 w-5 shrink-0 text-status-green-700"
                  aria-label="Completed"
                  aria-hidden="true"
                />
              ) : (
                <Circle
                  className="h-5 w-5 shrink-0 text-muted-foreground"
                  aria-label="Not yet complete"
                  aria-hidden="true"
                />
              )}
              <span
                className={cn(
                  'text-sm',
                  step.completed ? 'text-muted-foreground line-through' : 'text-foreground',
                )}
              >
                {step.route && !step.completed ? (
                  <Link
                    href={step.route}
                    className="hover:text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  >
                    {step.label}
                  </Link>
                ) : (
                  step.label
                )}
              </span>
              {/* Non-visible status for screen readers */}
              <span className="sr-only">{step.completed ? '— done' : '— not done'}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
