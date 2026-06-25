'use client';

import { useState } from 'react';
import { Copy, CheckCircle2, Zap, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { FreshnessIndicator } from '@/components/ui/freshness-indicator';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  usePixelInstallation,
  useProvisionPixel,
  usePixelHealth,
  useVerifyPixel,
} from '@/lib/hooks/use-pixel';
import { StorefrontInstallCards } from '@/components/pixel/storefront-install-cards';
import { useBrandList } from '@/lib/hooks/use-workspace';
import { BffApiError } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';
import type { PixelState } from '@/lib/api/types';
import { normalizeBrandHost } from '@brain/pixel-sdk';

/**
 * Brain Pixel setup — provision → install → verify, all wired to real endpoints:
 *  - Snippet comes from pixel_installation.install_token (not a secret).
 *  - "Verify installation" calls POST /api/v1/pixel/verify (no simulation).
 *  - Status reflects pixel_status.state — ACTUAL backend state only.
 *
 * A11y: status is never colour-only — StatusBadge pairs a dot with a text label.
 */

const PIXEL_STATE: Record<PixelState, { tone: StatusTone; label: string; description: string; pulse?: boolean }> = {
  connected: {
    tone: 'success',
    label: 'Connected',
    description: 'The Brain Pixel is installed and verified.',
  },
  syncing: {
    tone: 'info',
    label: 'Syncing',
    description: 'Pixel detected — waiting for data to arrive.',
    pulse: true,
  },
  waiting_for_data: {
    tone: 'info',
    label: 'Waiting for data',
    description: 'Pixel installed, but no data has been received yet.',
    pulse: true,
  },
  error: {
    tone: 'destructive',
    label: 'Verification failed',
    description: 'We could not detect the pixel on your site. Check the install and verify again.',
  },
};

function formatVerifiedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function PixelWizard() {
  const [copied, setCopied] = useState(false);
  const { data: brandList } = useBrandList();
  // Derive the canonical host from the brand's saved website using the shared
  // normalizer (mirrors the server-authoritative normalizeBrandHost — no ad-hoc parse).
  const rawDomain = brandList?.data?.[0]?.domain ?? null;
  const brandHost = normalizeBrandHost(rawDomain);

  const {
    data: installation,
    isLoading: loadingInstall,
    error: installError,
    refetch: refetchInstall,
  } = usePixelInstallation();
  const { data: health, isLoading: loadingHealth } = usePixelHealth();
  const { mutate: verifyPixel, isPending: isVerifying } = useVerifyPixel();
  const { mutate: provisionPixel, isPending: isProvisioning } = useProvisionPixel();

  function handleGenerate() {
    const targetHost = brandHost ?? (typeof window !== 'undefined' ? window.location.host : '');
    provisionPixel(targetHost, {
      onError: () =>
        toast({ title: 'Could not generate pixel', description: 'Please try again.', variant: 'destructive' }),
    });
  }

  function handleCopy() {
    if (!installation?.snippet) return;
    navigator.clipboard.writeText(installation.snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: 'Snippet copied to clipboard' });
    });
  }

  function handleVerify() {
    verifyPixel(undefined, {
      onSuccess: () =>
        toast({ title: 'Verification started', description: 'Checking your site for the Brain Pixel…' }),
      onError: () =>
        toast({
          title: 'Verification failed',
          description: 'Could not verify the pixel. Check the installation and try again.',
          variant: 'destructive',
        }),
    });
  }

  if (loadingInstall || loadingHealth) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  if (installError) {
    if (installError instanceof BffApiError && installError.status === 403) {
      return (
        <SectionCard title="Set up the Brain Pixel">
          <EmptyState
            title="Setup required"
            description="Finish onboarding to set up the Brain Pixel for this brand."
            icon={<Zap />}
            action={
              <Button asChild>
                <Link href="/workspace/new">Continue setup</Link>
              </Button>
            }
          />
        </SectionCard>
      );
    }
    return <ErrorCard error={installError} retry={refetchInstall} />;
  }

  // ── Not provisioned yet: a single, focused generate step ──────────────────
  if (!installation || !installation.installed) {
    return (
      <SectionCard
        title="Set up the Brain Pixel"
        description={
          brandHost ? (
            <>
              Generate your pixel for <span className="font-medium text-foreground">{brandHost}</span> to
              start collecting first-party data.
            </>
          ) : (
            'Generate your pixel snippet to start collecting first-party data.'
          )
        }
        data-testid="pixel-generate-card"
      >
        <Button onClick={handleGenerate} loading={isProvisioning} data-testid="btn-generate-pixel">
          <Zap />
          {isProvisioning ? 'Generating…' : 'Generate pixel'}
        </Button>
      </SectionCard>
    );
  }

  const stateConfig = health?.state ? PIXEL_STATE[health.state] : null;

  return (
    <div className="space-y-6">
      {/* Status — honest, icon+label via StatusBadge, with verified freshness */}
      {stateConfig && (
        <SectionCard
          title="Pixel status"
          meta={
            <StatusBadge tone={stateConfig.tone} pulse={stateConfig.pulse} data-testid="pixel-status-card">
              {stateConfig.label}
            </StatusBadge>
          }
          actions={
            health?.verified_at ? (
              <FreshnessIndicator prefix="Verified" label={formatVerifiedAt(health.verified_at)} />
            ) : undefined
          }
        >
          <p className="text-sm text-muted-foreground">{stateConfig.description}</p>
          {health?.state === 'error' && health.last_error && (
            <Alert variant="destructive" title="Last verification error" className="mt-3">
              <code className="font-mono text-xs">{health.last_error}</code>
            </Alert>
          )}
        </SectionCard>
      )}

      {/* One-click install — connected-storefront-driven (Shopify, WooCommerce, …).
          Shows BOTH options only when no storefront is connected; otherwise only the
          connected storefront's install action. */}
      <StorefrontInstallCards />

      {/* Manual snippet — fallback for a custom storefront or any platform */}
      <SectionCard
        title="Install manually"
        description={
          <>
            Not on a supported storefront? Paste this snippet into the{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">&lt;head&gt;</code> of every
            page on <span className="font-medium text-foreground">{installation.target_host}</span>.
          </>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            data-testid="btn-copy-snippet"
            aria-label={copied ? 'Snippet copied to clipboard' : 'Copy snippet to clipboard'}
          >
            {copied ? <CheckCircle2 /> : <Copy />}
            {copied ? 'Copied' : 'Copy snippet'}
          </Button>
        }
        data-testid="pixel-snippet-card"
      >
        <pre
          className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/50 p-4 font-mono text-xs text-foreground"
          aria-label="Brain Pixel installation code snippet"
          data-testid="pixel-snippet"
        >
          {installation.snippet}
        </pre>
      </SectionCard>

      {/* Verify — calls the real verification endpoint */}
      <SectionCard
        title="Verify installation"
        description="Once the pixel is in place, verify it’s live. This checks your site directly — no simulation."
      >
        <Button onClick={handleVerify} loading={isVerifying} data-testid="btn-verify-pixel">
          <ShieldCheck />
          {isVerifying ? 'Verifying…' : 'Verify installation'}
        </Button>
      </SectionCard>
    </div>
  );
}
