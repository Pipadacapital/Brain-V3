'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useCurrentUser } from '@/lib/hooks/use-auth';

/**
 * Client-side session guard for the dashboard shell. The edge middleware blocks
 * requests with no session cookie; this handles the present-but-invalid case
 * (expired/revoked session): /me returns 401 → redirect to /login instead of
 * letting the page fire dashboard calls that all 401 into the console.
 */
export function RequireSession({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isError, isLoading } = useCurrentUser();

  useEffect(() => {
    if (isError) router.replace('/login');
  }, [isError, router]);

  if (isError) return null;

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-label="Loading">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }

  return <>{children}</>;
}
