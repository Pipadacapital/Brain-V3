'use client';

/**
 * Root route error boundary (AUD-IMPL-001) — catches render errors from any segment that does
 * not declare its own error.tsx (/, /invite, /logout). Route groups have their own boundaries
 * so their layouts (nav, sidebar) stay up while only the failed content area degrades.
 */
import { RouteErrorFallback } from '@/components/ui/route-error-fallback';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorFallback error={error} reset={reset} />;
}
