'use client';

import { useState } from 'react';
import { Loader2, Copy, CheckCircle, XCircle, Clock, Zap } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { usePixelInstallation, usePixelHealth, useVerifyPixel } from '@/lib/hooks/use-pixel';
import { useBrandList } from '@/lib/hooks/use-workspace';
import { BffApiError } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';
import type { PixelState } from '@/lib/api/types';
import { cn } from '@/lib/utils';

/**
 * Brain Pixel Installation Wizard
 * - Shows the embed snippet (from pixel_installation.install_token — not a secret)
 * - "Verify Installation" calls the real verify endpoint (POST /api/v1/pixel/verify)
 * - Status shown from pixel_status.state — ACTUAL backend state only
 *
 * Scope note: this is NOT the production brain.js SDK (that is M1-data-spine).
 * This wizard covers: migration 006 + verify endpoint + status page.
 * (arch plan §2 + §5.1 pixel endpoints)
 *
 * A11y: pixel status is never colour-only — always icon + text label.
 */

const PIXEL_STATE_CONFIG: Record<
  PixelState,
  { icon: React.ElementType; label: string; description: string; textClass: string; bgClass: string }
> = {
  connected: {
    icon: CheckCircle,
    label: 'Connected',
    description: 'The Brain Pixel is installed and verified.',
    textClass: 'text-status-green-700',
    bgClass: 'bg-status-green-50',
  },
  syncing: {
    icon: Clock,
    label: 'Syncing',
    description: 'Pixel detected — waiting for data to arrive.',
    textClass: 'text-status-amber-700',
    bgClass: 'bg-status-amber-50',
  },
  waiting_for_data: {
    icon: Clock,
    label: 'Waiting for data',
    description: 'Pixel installed but no data received yet.',
    textClass: 'text-muted-foreground',
    bgClass: 'bg-muted/50',
  },
  error: {
    icon: XCircle,
    label: 'Verification failed',
    description: 'Could not detect the pixel on your site. Check the installation and try again.',
    textClass: 'text-status-red-700',
    bgClass: 'bg-status-red-50',
  },
};

export function PixelWizard() {
  const [copied, setCopied] = useState(false);
  const { data: brandList } = useBrandList();
  // Extract hostname from brand domain URL (strip protocol/path), fall back to window.location.host
  const rawDomain = brandList?.data?.[0]?.domain ?? null;
  const brandHost = rawDomain
    ? (() => { try { return new URL(rawDomain).host; } catch { return rawDomain; } })()
    : null;
  const { data: installation, isLoading: loadingInstall, error: installError, refetch: refetchInstall } = usePixelInstallation(brandHost);
  const { data: health, isLoading: loadingHealth } = usePixelHealth();
  const { mutate: verifyPixel, isPending: isVerifying } = useVerifyPixel();

  function handleCopy() {
    if (!installation?.snippet) return;
    navigator.clipboard.writeText(installation.snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: 'Copied to clipboard' });
    });
  }

  function handleVerify() {
    verifyPixel(undefined, {
      onSuccess: () => {
        toast({ title: 'Verification started', description: 'Checking your site for the Brain Pixel…' });
      },
      onError: (err) => {
        toast({ title: 'Verification failed', description: 'Could not verify the pixel. Check installation.', variant: 'destructive' });
      },
    });
  }

  if (loadingInstall || loadingHealth) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (installError) {
    if (installError instanceof BffApiError && installError.status === 403) {
      return (
        <EmptyState
          title="Setup required"
          description="Complete onboarding to set up the Brain Pixel."
          icon={<Zap className="h-8 w-8" />}
          action={
            <Link href="/workspace/new" className="text-sm text-primary underline-offset-4 hover:underline">
              Continue setup
            </Link>
          }
        />
      );
    }
    return <ErrorCard error={installError} retry={refetchInstall} />;
  }

  if (!installation) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-center text-sm text-muted-foreground">
            No Data Yet — pixel installation record not found. Contact support.
          </p>
        </CardContent>
      </Card>
    );
  }

  const pixelState = health?.state;
  const stateConfig = pixelState ? PIXEL_STATE_CONFIG[pixelState] : null;

  return (
    <div className="space-y-6">
      {/* Step 1: Current status */}
      {pixelState && stateConfig && (
        <Card data-testid="pixel-status-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Pixel Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Status: icon + label + description — never colour-only */}
            <span
              role="status"
              aria-label={`Brain Pixel status: ${stateConfig.label}. ${stateConfig.description}`}
              className={cn(
                'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium',
                stateConfig.bgClass,
                stateConfig.textClass,
              )}
            >
              {(() => {
                const Icon = stateConfig.icon;
                return <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />;
              })()}
              {stateConfig.label}
            </span>
            <p className="mt-2 text-sm text-muted-foreground">{stateConfig.description}</p>
            {health?.verified_at && (
              <p className="mt-1 text-xs text-muted-foreground">
                Verified:{' '}
                {new Date(health.verified_at).toLocaleString('en-IN', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            )}
            {health?.last_error && pixelState === 'error' && (
              <p className="mt-2 text-xs text-status-red-700 font-mono">{health.last_error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 2: Installation instructions + snippet */}
      <Card data-testid="pixel-snippet-card">
        <CardHeader>
          <CardTitle>Install the Brain Pixel</CardTitle>
          <CardDescription>
            Copy and paste this code snippet into the{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">&lt;head&gt;</code> section of
            your website.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <pre
              className="rounded-md bg-muted p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap"
              aria-label="Brain Pixel installation code snippet"
              data-testid="pixel-snippet"
            >
              {installation.snippet}
            </pre>
            <Button
              variant="outline"
              size="sm"
              className="absolute top-2 right-2"
              onClick={handleCopy}
              aria-label={copied ? 'Copied to clipboard' : 'Copy snippet to clipboard'}
              data-testid="btn-copy-snippet"
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

          <div className="rounded-md border-l-2 border-primary pl-3 py-1">
            <p className="text-xs text-muted-foreground">
              Paste this in the <code className="font-mono">&lt;head&gt;</code> of every page on{' '}
              <strong>{installation.target_host}</strong>.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Step 3: Verify */}
      <Card data-testid="pixel-verify-card">
        <CardHeader>
          <CardTitle>Verify installation</CardTitle>
          <CardDescription>
            Once you have installed the snippet, click below to verify it is live on your site.
            This calls the real verification endpoint — no simulation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={handleVerify}
            disabled={isVerifying}
            data-testid="btn-verify-pixel"
          >
            {isVerifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {isVerifying ? 'Verifying…' : 'Verify installation'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
