'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { SectionCard } from '@/components/ui/section-card';
import { sessionApi } from '@/lib/api/client';
import { BffApiError, userFacingMessage } from '@/lib/api/client';

/**
 * Step 3 of 3 — Done.
 *
 * Acknowledges the wizard completion. Calls advance {to:'complete'} → /dashboard.
 * Summary of what was set up shown; no fabricated numbers (Brain rule: no empty charts as a
 * success state — we only state what is actually provisioned, never invent metrics).
 */

const SETUP_ITEMS = [
  { label: 'Workspace created', detail: 'Your organisation’s home in Brain.' },
  { label: 'Brand configured', detail: 'Currency, timezone and revenue recognition set.' },
  { label: 'Store connection reviewed', detail: 'Order truth flows in as your store syncs.' },
] as const;

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
          ? userFacingMessage(err)
          : 'Could not complete setup. Please try again.';
      setError(msg);
      setIsPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionCard title="What’s set up" description="Brain keeps building on this foundation as data arrives.">
        <ul className="space-y-4">
          {SETUP_ITEMS.map((item) => (
            <li key={item.label} className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>

      {error && <Alert variant="destructive">{error}</Alert>}

      <div className="flex flex-col gap-3">
        <Button
          size="lg"
          onClick={handleGoToDashboard}
          loading={isPending}
          className="w-full"
          data-testid="btn-go-to-dashboard"
        >
          {isPending ? (
            'Setting up…'
          ) : (
            <>
              <LayoutDashboard className="mr-2 size-4" aria-hidden="true" />
              Go to your dashboard
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
