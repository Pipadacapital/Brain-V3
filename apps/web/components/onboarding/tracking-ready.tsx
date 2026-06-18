'use client';

/**
 * TrackingReady — the onboarding "your tracking is ready / add your website" interstitial
 * shown right after the brand-creation step (Deliverable 3).
 *
 * Two honest states, driven by whether a website was captured at brand-create:
 *
 *   1. Website provided → the server auto-provisioned this brand's `pixel_installation`
 *      (token + target_host). We surface THIS brand's install snippet (the /pixel.js tag
 *      carrying the install_token) + copy + a "verify later in the Tracking Center" link.
 *
 *   2. Website skipped → no installation exists. We tell the honest truth — "add your
 *      website to start tracking" — and link to the Tracking Center where the user can
 *      provision later. We never fake a snippet we don't have.
 *
 * The install_token is the per-brand tenant key; it is server-derived and brand-scoped via
 * the BFF (GET /api/v1/pixel/installation), never a client-sent brand_id. We only READ here.
 *
 * Continue advances the wizard to the next onboarding step (resolved server-side).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Copy, CheckCircle, AlertCircle, ArrowRight, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { usePixelInstallation } from '@/lib/hooks/use-pixel';
import { sessionApi } from '@/lib/api/client';
import { resolveOnboardingRoute } from '@/components/auth/login-form';
import { toast } from '@/components/ui/toaster';

export interface TrackingReadyProps {
  /** Whether a website was captured at brand-create. Drives snippet vs add-website state. */
  websiteProvided: boolean;
}

export function TrackingReady({ websiteProvided }: TrackingReadyProps) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [continuing, setContinuing] = useState(false);

  const {
    data: installation,
    isLoading,
    error,
    refetch,
  } = usePixelInstallation();

  function handleCopy() {
    if (!installation?.snippet) return;
    navigator.clipboard.writeText(installation.snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: 'Copied to clipboard' });
    });
  }

  async function handleContinue() {
    setContinuing(true);
    try {
      const session = await sessionApi.refresh();
      router.push(resolveOnboardingRoute(session.onboarding_status));
    } catch {
      router.push('/onboarding/integrations');
    }
  }

  // ── Add-website state (website skipped) — honest, no faked snippet ───────────
  // Show this immediately when the user skipped; don't wait on the read (there is
  // nothing to read — no installation was provisioned).
  if (!websiteProvided) {
    return (
      <Card data-testid="tracking-ready-skipped">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Globe className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <CardTitle>Add your website to start tracking</CardTitle>
          <CardDescription>
            You skipped adding a website, so there&apos;s no tracking pixel yet. Add your store&apos;s
            website any time in the Tracking Center to generate your install snippet and start
            collecting first-party data.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <Button asChild variant="outline" data-testid="link-add-website">
            <Link href="/settings/pixel">Add website in Tracking Center</Link>
          </Button>
          <Button onClick={handleContinue} disabled={continuing} data-testid="btn-tracking-continue">
            {continuing && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Continue setup
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ── Website provided: surface THIS brand's install snippet ───────────────────
  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="tracking-ready-loading">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (error) {
    return <ErrorCard error={error} retry={refetch} />;
  }

  // Edge: website was provided but the installation isn't readable yet (provisioning lag
  // or a transient miss). Tell the truth and route the user to the Tracking Center to
  // provision/verify there — never fabricate a snippet.
  if (!installation || !installation.installed || !installation.snippet) {
    return (
      <Card data-testid="tracking-ready-pending">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-status-amber-50">
            <AlertCircle className="h-5 w-5 text-status-amber-700" aria-hidden="true" />
          </div>
          <CardTitle>Finishing your tracking setup</CardTitle>
          <CardDescription>
            Your website is saved. Your install snippet will be ready in the Tracking Center —
            head there to copy it and verify your installation.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <Button asChild variant="outline" data-testid="link-tracking-center">
            <Link href="/settings/pixel">Open Tracking Center</Link>
          </Button>
          <Button onClick={handleContinue} disabled={continuing} data-testid="btn-tracking-continue">
            {continuing && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Continue setup
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-testid="tracking-ready-snippet">
      <Card>
        <CardHeader>
          {/* Status: icon + text label — never colour-only (WCAG 1.4.1) */}
          <span
            role="status"
            className="mb-2 inline-flex w-fit items-center gap-2 rounded-full bg-status-green-50 px-3 py-1.5 text-sm font-medium text-status-green-700"
            data-testid="tracking-ready-badge"
          >
            <CheckCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            Your tracking is ready
          </span>
          <CardTitle>Install the Brain Pixel</CardTitle>
          <CardDescription>
            We generated a tracking pixel for{' '}
            <strong data-testid="tracking-ready-host">{installation.target_host}</strong>. Paste
            this snippet into the{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">&lt;head&gt;</code> of every page
            on your site.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <pre
              className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-4 font-mono text-xs"
              aria-label="Brain Pixel installation code snippet"
              data-testid="tracking-ready-snippet-code"
            >
              {installation.snippet}
            </pre>
            <Button
              variant="outline"
              size="sm"
              className="absolute right-2 top-2"
              onClick={handleCopy}
              aria-label={copied ? 'Copied to clipboard' : 'Copy snippet to clipboard'}
              data-testid="btn-copy-tracking-snippet"
            >
              {copied ? (
                <>
                  <CheckCircle className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Copy
                </>
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Already installed it? You can verify it any time in the{' '}
            <Link
              href="/settings/pixel"
              className="text-primary underline-offset-4 hover:underline"
              data-testid="link-verify-later"
            >
              Tracking Center
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <Button onClick={handleContinue} disabled={continuing} data-testid="btn-tracking-continue">
        {continuing && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        Continue setup
        <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
