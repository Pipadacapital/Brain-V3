'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2, LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { sessionApi } from '@/lib/api/client';
import { BffApiError } from '@/lib/api/client';

/**
 * Step 4 of 4 — Done.
 *
 * Acknowledges the wizard completion. Calls advance {to:'complete'} → /dashboard.
 * Summary of what was set up shown; no fabricated numbers.
 */
export function OnboardingDoneStep() {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoToDashboard() {
    setIsPending(true);
    setError(null);
    try {
      await sessionApi.advanceOnboarding({ to: 'complete' });
      router.push('/dashboard');
    } catch (err) {
      const msg =
        err instanceof BffApiError
          ? `${err.message} (Request ID: ${err.requestId})`
          : 'Could not complete setup. Please try again.';
      setError(msg);
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Summary of completed steps */}
      <div className="space-y-4">
        <SetupItem label="Workspace created" />
        <SetupItem label="Brand configured" />
        <SetupItem label="Integration step complete" />
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <Button
          size="lg"
          onClick={handleGoToDashboard}
          disabled={isPending}
          className="w-full"
          data-testid="btn-go-to-dashboard"
        >
          {isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Setting up…
            </>
          ) : (
            <>
              <LayoutDashboard className="mr-2 h-4 w-4" aria-hidden="true" />
              Go to Dashboard
            </>
          )}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          You can always add more connectors and team members from Settings.
        </p>
      </div>
    </div>
  );
}

function SetupItem({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <CheckCircle2
        className="h-5 w-5 text-green-600 shrink-0"
        aria-hidden="true"
      />
      <span className="text-sm text-foreground">{label}</span>
    </div>
  );
}
