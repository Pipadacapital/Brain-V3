'use client';

import { Zap, CheckCircle, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useDataStatus } from '@/lib/hooks/use-dashboard';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { PixelState } from '@/lib/api/types';
import { cn } from '@/lib/utils';

/**
 * Data Status widget
 * Source: pixel_status.state, pixel_installation.installed_at
 * (Postgres control-plane ONLY — arch plan §6.4)
 *
 * A11y: status is NEVER colour-only — always paired with icon + text label.
 */

const PIXEL_STATE_CONFIG: Record<
  PixelState,
  { icon: React.ElementType; label: string; ariaLabel: string; textClass: string; bgClass: string }
> = {
  connected: {
    icon: CheckCircle,
    label: 'Connected',
    ariaLabel: 'Pixel status: Connected — data flowing',
    textClass: 'text-status-green-700',
    bgClass: 'bg-status-green-50',
  },
  syncing: {
    icon: Clock,
    label: 'Syncing',
    ariaLabel: 'Pixel status: Syncing',
    textClass: 'text-status-amber-700',
    bgClass: 'bg-status-amber-50',
  },
  waiting_for_data: {
    icon: Clock,
    label: 'Waiting for data',
    ariaLabel: 'Pixel status: Waiting for first data',
    textClass: 'text-muted-foreground',
    bgClass: 'bg-muted/50',
  },
  error: {
    icon: XCircle,
    label: 'Error',
    ariaLabel: 'Pixel status: Error — check installation',
    textClass: 'text-status-red-700',
    bgClass: 'bg-status-red-50',
  },
};

export function DataStatusCard() {
  const { data, isLoading, error, refetch } = useDataStatus();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-24" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <ErrorCard error={error} retry={refetch} />
        </CardContent>
      </Card>
    );
  }

  if (!data || !data.pixel_state) {
    return (
      <Card data-testid="data-status-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Zap className="h-4 w-4" aria-hidden="true" />
            Data Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="No tracking data yet"
            description="Install the Brain Pixel to start collecting data."
            action={
              <Link href="/settings/pixel">
                <Button size="sm" variant="outline">
                  Install Brain Pixel
                </Button>
              </Link>
            }
          />
        </CardContent>
      </Card>
    );
  }

  const config = PIXEL_STATE_CONFIG[data.pixel_state];
  const Icon = config.icon;

  return (
    <Card data-testid="data-status-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Zap className="h-4 w-4" aria-hidden="true" />
          Data Status
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Status: icon + text label — never colour-only (a11y requirement) */}
        <span
          role="status"
          aria-label={config.ariaLabel}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium',
            config.bgClass,
            config.textClass,
          )}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          {config.label}
        </span>
        {data.pixel_installed_at && (
          <p className="mt-2 text-xs text-muted-foreground">
            Installed:{' '}
            {new Date(data.pixel_installed_at).toLocaleString('en-IN', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
