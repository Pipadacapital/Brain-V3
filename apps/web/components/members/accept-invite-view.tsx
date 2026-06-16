'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle, AlertTriangle, MailCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ErrorCard } from '@/components/ui/error-card';
import { useAcceptInvite } from '@/lib/hooks/use-members';
import { BffApiError } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';

/**
 * Invite accept view — handles AC-7 error states:
 * - EMAIL_MISMATCH: invite was sent to a different email address.
 * - USER_UNVERIFIED: accepting user has not verified their email yet.
 * - Generic errors: shown via ErrorCard with request ID.
 */
export function AcceptInviteView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const { mutate: acceptInvite, isPending, error, isSuccess } = useAcceptInvite();

  useEffect(() => {
    if (token) {
      acceptInvite(
        { token },
        {
          onSuccess: () => {
            toast({ title: 'Invitation accepted', description: 'Welcome to the workspace!' });
          },
        },
      );
    }
  }, [token, acceptInvite]);

  if (!token) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-center text-sm text-destructive">
            Invalid invitation link. Please check your email for the correct link.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isPending) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Accepting your invitation…</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    // AC-7: Specific guided messages for invite hardening errors.
    if (error instanceof BffApiError) {
      if (error.code === 'EMAIL_MISMATCH') {
        return (
          <Card>
            <CardHeader>
              <div className="flex justify-center mb-2">
                <AlertTriangle className="h-10 w-10 text-amber-500" aria-hidden="true" />
              </div>
              <CardTitle className="text-center">Wrong email address</CardTitle>
              <CardDescription className="text-center">
                This invite was sent to a different email address. Please sign in with the email
                that received the invitation and try again.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center space-y-3">
              <Button onClick={() => router.push('/login')} data-testid="btn-invite-wrong-email-login">
                Sign in with another account
              </Button>
            </CardContent>
          </Card>
        );
      }

      if (error.code === 'USER_UNVERIFIED') {
        return (
          <Card>
            <CardHeader>
              <div className="flex justify-center mb-2">
                <MailCheck className="h-10 w-10 text-blue-500" aria-hidden="true" />
              </div>
              <CardTitle className="text-center">Verify your email first</CardTitle>
              <CardDescription className="text-center">
                You need to verify your email address before you can accept this invitation.
                Check your inbox for a verification link.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <Button
                variant="outline"
                onClick={() => router.push('/verify-email')}
                data-testid="btn-invite-verify-email"
              >
                Go to email verification
              </Button>
            </CardContent>
          </Card>
        );
      }
    }

    return (
      <Card>
        <CardContent className="py-6">
          <ErrorCard error={error} />
          <div className="mt-4 text-center">
            <Button variant="outline" onClick={() => router.push('/login')}>
              Go to sign in
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isSuccess) {
    return (
      <Card>
        <CardHeader>
          <div className="flex justify-center mb-2">
            <CheckCircle className="h-10 w-10 text-green-600" aria-hidden="true" />
          </div>
          <CardTitle className="text-center">You&apos;re in!</CardTitle>
          <CardDescription className="text-center">
            Your invitation has been accepted. Sign in to access the workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Button onClick={() => router.push('/login')} data-testid="btn-invite-accepted-login">
            Sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  return null;
}
