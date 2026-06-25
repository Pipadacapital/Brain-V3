'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, MailCheck, FlaskConical } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
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
            toast({ title: 'Email verified', description: 'Connecting a store, inviting your team, and billing are now unlocked.' });
            router.push('/login');
          },
        },
      );
    }
  }, [token, verify, router]);

  if (token) {
    return (
      <Card className="shadow-md">
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
    <Card className="shadow-md">
      <CardHeader>
        <div className="mb-1 flex justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
            <MailCheck className="h-6 w-6" />
          </span>
        </div>
        <CardTitle className="text-center text-lg">Check your email</CardTitle>
        <CardDescription className="text-center">
          {email
            ? `We sent a verification link to ${email}.`
            : 'We sent a verification link to your email address.'}
          <br />
          Click the link to verify your email and unlock connecting a store, inviting your team, and billing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-center text-xs text-muted-foreground">
          Once verified, you will be redirected to sign in automatically.
        </p>
        {isDev && devToken && (
          <Alert
            variant="warning"
            className="mt-4"
            icon={<FlaskConical className="h-4 w-4" aria-hidden="true" />}
            title="Dev mode — no real email is sent"
          >
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              data-testid="btn-dev-verify-now"
              onClick={() => router.push(`/verify-email?token=${encodeURIComponent(devToken)}`)}
            >
              Verify now (dev)
            </Button>
          </Alert>
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
