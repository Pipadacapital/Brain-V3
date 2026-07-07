'use client';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCurrentUser, useLogout } from '@/lib/hooks/use-auth';

/**
 * Sidebar footer: shows the signed-in user's email and a Log out control.
 * Logout revokes the session server-side and clears the httpOnly cookie, then
 * lands on the public home page. Even if the request errors, we still navigate
 * home so the user is never stranded in a half-authenticated shell.
 */
export function UserMenu() {
  const router = useRouter();
  const { data } = useCurrentUser();
  const { mutate: logout, isPending } = useLogout();

  const email = data?.user?.email;

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
    <div className="border-t border-border p-3">
      {email && (
        <div className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase text-muted-foreground"
            aria-hidden="true"
          >
            {email.charAt(0)}
          </span>
          <p
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={email}
            data-testid="current-user-email"
          >
            {email}
          </p>
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="mt-0.5 w-full justify-start gap-2.5 text-muted-foreground hover:text-foreground"
        onClick={handleLogout}
        disabled={isPending}
        data-testid="btn-logout"
      >
        <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
        {isPending ? 'Signing out…' : 'Log out'}
      </Button>
    </div>
  );
}
