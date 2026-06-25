import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';
import { userFacingMessage, getSupportReference } from '@/lib/api/client';

interface ErrorCardProps {
  error: unknown;
  retry?: () => void;
  className?: string;
}

/**
 * ErrorCard — shows a clean, customer-safe message. The request_id is NOT shown as a prominent
 * "Request ID:" line (bad UX); it appears only as a quiet support reference for true server errors,
 * where the user genuinely can't self-resolve. 4xx (validation, not-verified, …) show just the
 * specific message.
 */
export function ErrorCard({ error, retry, className }: ErrorCardProps) {
  const message = userFacingMessage(error);
  const supportReference = getSupportReference(error);

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
          {supportReference && (
            <p className="mt-1 text-xs text-muted-foreground">
              If this keeps happening, contact support and mention{' '}
              <span className="font-mono">{supportReference}</span>.
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
