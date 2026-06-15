'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ErrorCard } from '@/components/ui/error-card';
import { useAcceptInvite } from '@/lib/hooks/use-members';
import { toast } from '@/components/ui/toaster';

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
          <Button onClick={() => router.push('/login')}>Sign in</Button>
        </CardContent>
      </Card>
    );
  }

  return null;
}
