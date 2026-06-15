'use client';

import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCurrentUser, useLogout } from '@/lib/hooks/use-auth';

/**
 * Sidebar footer: shows the signed-in user's email and a Log out control.
 * Logout revokes the session server-side and clears the httpOnly cookie, then
 * redirects to /login. Even if the request errors, we still navigate to /login
 * so the user is never stranded in a half-authenticated shell.
 */
export function UserMenu() {
  const router = useRouter();
  const { data } = useCurrentUser();
  const { mutate: logout, isPending } = useLogout();

  const email = data?.user?.email;

  function handleLogout() {
    logout(undefined, {
      onSuccess: () => router.replace('/login'),
      onError: () => router.replace('/login'),
    });
  }

  return (
    <div className="border-t px-3 py-4">
      {email && (
        <p
          className="px-3 pb-2 text-xs text-muted-foreground truncate"
          title={email}
          data-testid="current-user-email"
        >
          {email}
        </p>
      )}
      <Button
        variant="ghost"
        className="w-full justify-start gap-3 text-muted-foreground hover:text-foreground"
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
