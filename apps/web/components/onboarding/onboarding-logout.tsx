'use client';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLogout } from '@/lib/hooks/use-auth';

/**
 * Onboarding header logout. Mirrors the dashboard UserMenu behaviour: revoke the
 * session server-side, clear the httpOnly cookie, then land on /login regardless
 * of request outcome — so a user is never stranded on an onboarding step (or an
 * errored workspace fetch) with no way out.
 */
export function OnboardingLogout() {
  const router = useRouter();
  const { mutate: logout, isPending } = useLogout();

  function handleLogout() {
    // Best-effort BFF revoke, then ALWAYS clear the local httpOnly session cookie
    // via the web /logout route — so logout works even when the BFF is unreachable
    // (otherwise the cookie survives and the app still looks logged-in). refresh()
    // then busts the Next router cache so "/" re-renders in its signed-out state.
    const finish = async () => {
      try {
        await fetch('/logout', { method: 'POST' });
      } catch {
        /* ignore — navigate regardless so the user is never stranded */
      }
      router.replace('/');
      router.refresh();
    };
    logout(undefined, { onSuccess: finish, onError: finish });
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-2 text-muted-foreground hover:text-foreground"
      onClick={handleLogout}
      disabled={isPending}
      data-testid="btn-onboarding-logout"
    >
      <LogOut className="size-4 shrink-0" aria-hidden="true" />
      {isPending ? 'Signing out…' : 'Log out'}
    </Button>
  );
}
