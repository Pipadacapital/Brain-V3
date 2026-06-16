'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, MailCheck, FlaskConical } from 'lucide-react';
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

  // DEV-ONLY: there is no real inbox in dev, so fetch the verification token the
  // backend captured at register time and offer a one-click "verify now". This block
  // is dead-code-eliminated from production builds (process.env.NODE_ENV is inlined).
  const isDev = process.env.NODE_ENV !== 'production';
  const [devToken, setDevToken] = useState<string | null>(null);
  useEffect(() => {
    if (!isDev || token || !email) return;
    let cancelled = false;
    fetch(`/api/bff/v1/dev/last-email-link?email=${encodeURIComponent(email)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { token?: string; type?: string } | null) => {
        if (!cancelled && data?.token && data.type === 'email_verification') setDevToken(data.token);
      })
      .catch(() => {
        /* dev convenience only — silently ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [isDev, token, email]);

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
        {isDev && devToken && (
          <div className="mt-4 rounded-md border border-dashed border-amber-400 bg-amber-50 p-3 text-center dark:bg-amber-950/30">
            <p className="mb-2 flex items-center justify-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
              Dev mode — no real email is sent
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="btn-dev-verify-now"
              onClick={() => router.push(`/verify-email?token=${encodeURIComponent(devToken)}`)}
            >
              Verify now (dev)
            </Button>
          </div>
        )}
        <div className="mt-4 text-center">
          <Button variant="link" onClick={() => router.push('/login')}>
            Back to sign in
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
