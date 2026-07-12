'use client';

/**
 * RouteErrorFallback — the shared render-error boundary body (AUD-IMPL-001).
 *
 * Data-fetch errors were already well handled (typed BffApiError → ErrorCard); this covers the
 * OTHER failure class — an uncaught COMPONENT RENDER error — which previously fell through to
 * Next.js's default unstyled crash screen for the whole route segment. Fail safely: a calm,
 * customer-safe message, a retry (segment re-render) and the error digest as a quiet support
 * reference. Never a stack, never internals.
 */
import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from './button';

export interface RouteErrorFallbackProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** Short human label for the area that failed, e.g. "dashboard". */
  area?: string;
}

export function RouteErrorFallback({ error, reset, area }: RouteErrorFallbackProps) {
  React.useEffect(() => {
    // Surface the real error for observability tooling; the UI itself stays customer-safe.
    console.error(`[web] route render error${area ? ` in ${area}` : ''}:`, error);
  }, [error, area]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div
        className="w-full max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-6"
        role="alert"
        aria-live="assertive"
        data-testid="route-error-fallback"
      >
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-destructive">
              Something went wrong{area ? ` in the ${area} view` : ''}.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your data is safe — this is a display problem, not a data problem. Try again, and if
              it keeps happening, contact support.
            </p>
            {error.digest && (
              <p className="mt-2 text-xs text-muted-foreground">
                Support reference: <span className="font-mono">{error.digest}</span>
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
