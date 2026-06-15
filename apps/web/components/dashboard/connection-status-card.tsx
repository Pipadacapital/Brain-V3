'use client';

import { Plug, CheckCircle, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useConnectionStatus } from '@/lib/hooks/use-dashboard';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import type { SyncState } from '@/lib/api/types';
import { cn } from '@/lib/utils';

/**
 * Connection Status widget
 * Source: connector_instance.status, connector_sync_status.state + .last_sync_at
 * (Postgres control-plane ONLY — arch plan §6.4)
 *
 * A11y: status is NEVER colour-only — always paired with icon + text label.
 */

const SYNC_STATE_CONFIG: Record<
  SyncState,
  { icon: React.ElementType; label: string; ariaLabel: string; textClass: string; bgClass: string }
> = {
  connected: {
    icon: CheckCircle,
    label: 'Connected',
    ariaLabel: 'Connector status: Connected',
    textClass: 'text-status-green-700',
    bgClass: 'bg-status-green-50',
  },
  syncing: {
    icon: Clock,
    label: 'Syncing',
    ariaLabel: 'Connector status: Syncing data',
    textClass: 'text-status-amber-700',
    bgClass: 'bg-status-amber-50',
  },
  waiting_for_data: {
    icon: Clock,
    label: 'Waiting for data',
    ariaLabel: 'Connector status: Waiting for data',
    textClass: 'text-muted-foreground',
    bgClass: 'bg-muted/50',
  },
  error: {
    icon: XCircle,
    label: 'Error',
    ariaLabel: 'Connector status: Error',
    textClass: 'text-status-red-700',
    bgClass: 'bg-status-red-50',
  },
};

export function ConnectionStatusCard() {
  const { data, isLoading, error, refetch } = useConnectionStatus();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
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

  if (!data || !data.sync_state) {
    return (
      <Card data-testid="connection-status-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Plug className="h-4 w-4" aria-hidden="true" />
            Connection Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="No Data Yet"
            description="Connect a data source to see connection status."
            action={
              <Link href="/settings/connectors">
                <Button size="sm" variant="outline">
                  Connect data source
                </Button>
              </Link>
            }
          />
        </CardContent>
      </Card>
    );
  }

  const config = SYNC_STATE_CONFIG[data.sync_state];
  const Icon = config.icon;

  return (
    <Card data-testid="connection-status-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Plug className="h-4 w-4" aria-hidden="true" />
          Connection Status
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.provider && (
          <p className="text-xs text-muted-foreground capitalize mb-2">{data.provider}</p>
        )}
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
        {data.last_sync_at && (
          <p className="mt-2 text-xs text-muted-foreground">
            Last synced:{' '}
            {new Date(data.last_sync_at).toLocaleString('en-IN', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
