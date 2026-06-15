'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, MailCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ErrorCard } from '@/components/ui/error-card';
import { useVerifyEmail } from '@/lib/hooks/use-auth';
import { toast } from '@/components/ui/toaster';

export function VerifyEmailForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const email = searchParams.get('email');

  const { mutate: verify, isPending, error, isSuccess } = useVerifyEmail();

  // Auto-verify if token is in the URL (email link click)
  useEffect(() => {
    if (token) {
      verify(
        { token },
        {
          onSuccess: () => {
            toast({ title: 'Email verified', description: 'You can now sign in.' });
            router.push('/login');
          },
        },
      );
    }
  }, [token, verify, router]);

  if (token) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center gap-4">
            {isPending && (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">Verifying your email…</p>
              </>
            )}
            {error && <ErrorCard error={error} />}
            {isSuccess && (
              <p className="text-sm text-muted-foreground">Redirecting to sign in…</p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-center mb-2">
          <MailCheck className="h-10 w-10 text-primary" aria-hidden="true" />
        </div>
        <CardTitle className="text-center">Check your email</CardTitle>
        <CardDescription className="text-center">
          {email
            ? `We sent a verification link to ${email}.`
            : 'We sent a verification link to your email address.'}
          <br />
          Click the link to verify and activate your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-center text-xs text-muted-foreground">
          Once verified, you will be redirected to sign in automatically.
        </p>
        <div className="mt-4 text-center">
          <Button variant="link" onClick={() => router.push('/login')}>
            Back to sign in
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
