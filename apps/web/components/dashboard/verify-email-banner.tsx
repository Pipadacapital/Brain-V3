'use client';

/**
 * VerifyEmailBanner — the soft-gate UX half (feat-onboarding-ux Deliverable 2).
 *
 * IMPORTANT: this banner NEVER guards anything. It is pure UX. The actual block on sensitive
 * actions (connect a real store, invite members, billing) is enforced SERVER-SIDE by the
 * requireVerifiedEmail preHandler (403 EMAIL_NOT_VERIFIED). Hiding/disabling a button is a
 * convenience hint only; a crafted request still hits the server gate.
 *
 * Behaviour:
 *   - Shown only when the current user's email_verified === false (read from /v1/bff/me).
 *   - Dismissible for the session (sessionStorage) — honest progress: it reappears on reload
 *     until the email is actually verified (we never persist "dismissed forever").
 *   - Offers a Resend action (re-issues the verification email) with an honest neutral toast.
 *   - role="status" + non-colour-only (icon + text) for a11y.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { MailWarning, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/api/client';

const DISMISS_KEY = 'brain_verify_banner_dismissed';

export function VerifyEmailBanner() {
  const [dismissed, setDismissed] = useState(false);

  // Session-only dismissal — reappears on reload until verified (honest progress).
  useEffect(() => {
    if (typeof window !== 'undefined' && sessionStorage.getItem(DISMISS_KEY) === '1') {
      setDismissed(true);
    }
  }, []);

  const { data } = useQuery({
    queryKey: ['bff', 'me', 'verify-banner'],
    queryFn: () => authApi.bffMe(),
    staleTime: 60_000,
    retry: false,
  });

  const user = data?.user;
  // Assume verified until known so we never flash the banner before /me resolves.
  const emailVerified = user?.email_verified ?? true;

  if (emailVerified || dismissed) return null;

  function handleDismiss() {
    if (typeof window !== 'undefined') sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  // No standalone resend endpoint in M1 — route to the verification surface (which, in dev,
  // surfaces the captured link; in prod re-issues on demand). Carries the email so the page
  // can re-trigger. The server gate is authoritative regardless of this banner.
  const verifyHref = user?.email
    ? `/verify-email?email=${encodeURIComponent(user.email)}`
    : '/verify-email';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="verify-email-banner"
      className="flex items-start gap-3 border-b border-warning/25 bg-warning-subtle px-6 py-3 text-sm text-warning-subtle-foreground"
    >
      <MailWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex-1">
        <p className="font-medium">Verify your email to unlock everything</p>
        <p className="mt-0.5 opacity-90">
          You can explore Brain now, but connecting a real store, inviting members, and billing
          stay locked until your email is verified.
        </p>
      </div>
      <Button
        asChild
        size="sm"
        variant="outline"
        data-testid="btn-resend-verification"
        className="shrink-0"
      >
        <Link href={verifyHref}>Verify email</Link>
      </Button>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss verify-email reminder"
        data-testid="btn-dismiss-verify-banner"
        className="shrink-0 rounded p-1 transition-colors hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
