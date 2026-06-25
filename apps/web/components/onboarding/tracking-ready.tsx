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
import { Copy, Check, ArrowRight, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Alert } from '@/components/ui/alert';
import { StatusBadge } from '@/components/ui/status-badge';
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

  const { data: installation, isLoading, error, refetch } = usePixelInstallation();

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

  const continueButton = (
    <Button onClick={handleContinue} loading={continuing} data-testid="btn-tracking-continue">
      Continue setup
      {!continuing && <ArrowRight className="ml-2 size-4" aria-hidden="true" />}
    </Button>
  );

  // ── Add-website state (website skipped) — honest, no faked snippet ───────────
  // Show this immediately when the user skipped; don't wait on the read (there is
  // nothing to read — no installation was provisioned).
  if (!websiteProvided) {
    return (
      <SectionCard data-testid="tracking-ready-skipped">
        <EmptyState
          icon={<Globe aria-hidden="true" />}
          title="Add your website to start tracking"
          description="You skipped adding a website, so there’s no tracking pixel yet. Add your store’s website any time in the Tracking Center to generate your install snippet and start collecting first-party data."
          action={
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild variant="outline" data-testid="link-add-website">
                <Link href="/settings/pixel">Add website in Tracking Center</Link>
              </Button>
              {continueButton}
            </div>
          }
        />
      </SectionCard>
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
      <SectionCard
        data-testid="tracking-ready-pending"
        title="Finishing your tracking setup"
        meta={<StatusBadge tone="warning" pulse>Provisioning</StatusBadge>}
        description="Your website is saved. Your install snippet will be ready in the Tracking Center — head there to copy it and verify your installation."
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button asChild variant="outline" data-testid="link-tracking-center">
            <Link href="/settings/pixel">Open Tracking Center</Link>
          </Button>
          {continueButton}
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6" data-testid="tracking-ready-snippet">
      <SectionCard
        title="Install the Brain Pixel"
        meta={
          <StatusBadge tone="success" data-testid="tracking-ready-badge">
            Your tracking is ready
          </StatusBadge>
        }
        description={
          <>
            We generated a tracking pixel for{' '}
            <strong className="text-foreground" data-testid="tracking-ready-host">
              {installation.target_host}
            </strong>
            . Paste this snippet into the{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">&lt;head&gt;</code> of every page
            on your site.
          </>
        }
      >
        <div className="space-y-4">
          <div className="relative">
            <pre
              className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/60 p-4 font-mono text-xs"
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
                  <Check className="mr-1 size-3.5" aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1 size-3.5" aria-hidden="true" />
                  Copy
                </>
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Already installed it? You can verify it any time in the{' '}
            <Link
              href="/settings/pixel"
              className="font-medium text-primary underline-offset-4 hover:underline"
              data-testid="link-verify-later"
            >
              Tracking Center
            </Link>
            .
          </p>
        </div>
      </SectionCard>

      {continueButton}
    </div>
  );
}
