'use client';

/**
 * Auth route-group error boundary (AUD-IMPL-001) — login/registration render crashes degrade
 * to a contained, retryable error state inside the auth layout.
 */
import { RouteErrorFallback } from '@/components/ui/route-error-fallback';

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} area="sign-in" />;
}
