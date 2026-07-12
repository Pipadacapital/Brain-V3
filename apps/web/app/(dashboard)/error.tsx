'use client';

/**
 * Dashboard route-group error boundary (AUD-IMPL-001) — a render crash in any dashboard page
 * degrades to a contained, retryable error state INSIDE the dashboard layout (nav stays up),
 * instead of Next.js's unstyled full-route crash screen.
 */
import { RouteErrorFallback } from '@/components/ui/route-error-fallback';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} area="dashboard" />;
}
