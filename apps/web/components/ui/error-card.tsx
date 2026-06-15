import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';
import { BffApiError } from '@/lib/api/client';

interface ErrorCardProps {
  error: unknown;
  retry?: () => void;
  className?: string;
}

/**
 * ErrorCard — surfaces the request_id from BffApiError so users can cite it in support.
 * Trace context is always propagated per the engineering OS requirement.
 */
export function ErrorCard({ error, retry, className }: ErrorCardProps) {
  const message =
    error instanceof BffApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Something went wrong';

  const requestId = error instanceof BffApiError ? error.requestId : undefined;

  return (
    <div
      className={cn(
        'rounded-lg border border-destructive/50 bg-destructive/10 p-4',
        className,
      )}
      role="alert"
      aria-live="assertive"
      data-testid="error-card"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-destructive">{message}</p>
          {requestId && (
            <p className="mt-1 text-xs text-muted-foreground font-mono">
              Request ID: {requestId}
            </p>
          )}
        </div>
        {retry && (
          <Button variant="outline" size="sm" onClick={retry} className="shrink-0">
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
