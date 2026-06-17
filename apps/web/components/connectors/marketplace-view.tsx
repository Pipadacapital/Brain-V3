'use client';

/**
 * MarketplaceView — Integration Marketplace UI (feat-connector-marketplace B1/B2/B3).
 *
 * Layout: tiles grouped by category (storefront, ads, payments, logistics, messaging, crm, analytics).
 * Each tile shows TRUTHFUL status from catalog ⨝ instance:
 *   - Not connected → [Connect] button (oauth or credential).
 *   - coming_soon / available=false → [Coming Soon] disabled button (un-connectable at UI level).
 *   - connected → health_state badge + safety_rating indicator; [Disconnect].
 *   - blocked/degraded safety → visible warning flag ("excluded — connector failing").
 *
 * A11y:
 *   - Status never colour-only: icon + label + role="status" on every badge.
 *   - Coming-soon button: disabled + aria-disabled="true" + aria-label.
 *   - Health badges: icon + text label (CheckCircle/Clock/XCircle/Plug/Gauge/Key/Ban).
 *
 * data-testids (per architecture plan B2):
 *   marketplace-page, connector-tile-{id}, connector-tile-{id}-status,
 *   connector-tile-{id}-connect, connector-tile-coming-soon, connector-health-badge-{id},
 *   marketplace-category-{cat}, btn-skip-for-now
 */

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  CheckCircle,
  Clock,
  XCircle,
  Plug,
  Gauge,
  Key,
  Ban,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { useMarketplace, useConnectConnector, useDisconnectConnector } from '@/lib/hooks/use-connectors';
import { BffApiError } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';
import type { MarketplaceTile, ConnectorCategory, HealthState, SafetyRating } from '@/lib/api/types';
import { cn } from '@/lib/utils';

// ── Health state display config (icon + label — never colour-only, a11y) ──────

const HEALTH_CONFIG: Record<
  HealthState,
  { icon: React.ElementType; label: string; badgeClass: string; textClass: string }
> = {
  Healthy: {
    icon: CheckCircle,
    label: 'Healthy',
    badgeClass: 'bg-status-green-50 text-status-green-700 border-status-green-200',
    textClass: 'text-status-green-700',
  },
  Delayed: {
    icon: Clock,
    label: 'Delayed',
    badgeClass: 'bg-status-amber-50 text-status-amber-700 border-status-amber-200',
    textClass: 'text-status-amber-700',
  },
  RateLimited: {
    icon: Gauge,
    label: 'Rate Limited',
    badgeClass: 'bg-status-amber-50 text-status-amber-700 border-status-amber-200',
    textClass: 'text-status-amber-700',
  },
  Failed: {
    icon: XCircle,
    label: 'Failed',
    badgeClass: 'bg-status-red-50 text-status-red-700 border-status-red-200',
    textClass: 'text-status-red-700',
  },
  Disconnected: {
    icon: Plug,
    label: 'Disconnected',
    badgeClass: 'bg-muted text-muted-foreground border-border',
    textClass: 'text-muted-foreground',
  },
  TokenExpired: {
    icon: Key,
    label: 'Token Expired',
    badgeClass: 'bg-status-red-50 text-status-red-700 border-status-red-200',
    textClass: 'text-status-red-700',
  },
  Disabled: {
    icon: Ban,
    label: 'Disabled',
    badgeClass: 'bg-muted text-muted-foreground border-border',
    textClass: 'text-muted-foreground',
  },
};

// ── Safety rating flag display ────────────────────────────────────────────────

const SAFETY_FLAG: Record<SafetyRating, { label: string; className: string } | null> = {
  safe: null,
  degraded: {
    label: 'degraded — data may be incomplete',
    className: 'text-status-amber-700',
  },
  blocked: {
    label: 'excluded — connector failing',
    className: 'text-status-red-700',
  },
};

// ── Category display names ────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  storefront: 'Storefront',
  ads: 'Advertising',
  payments: 'Payments',
  logistics: 'Logistics',
  messaging: 'Messaging',
  crm: 'CRM',
  analytics: 'Analytics',
};

// ── Health badge ─────────────────────────────────────────────────────────────

function HealthBadge({ tileId, healthState }: { tileId: string; healthState: HealthState }) {
  const cfg = HEALTH_CONFIG[healthState];
  const Icon = cfg.icon;
  return (
    <span
      role="status"
      aria-label={`Connection health: ${cfg.label}`}
      data-testid={`connector-health-badge-${tileId}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
        cfg.badgeClass,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {cfg.label}
    </span>
  );
}

// ── Tile status indicator (combined connect status + health) ──────────────────

function TileStatusIndicator({ tile }: { tile: MarketplaceTile }) {
  if (!tile.instance) return null;

  const safetyFlag = SAFETY_FLAG[tile.instance.safety_rating];

  return (
    <div
      className="flex flex-col items-end gap-1"
      data-testid={`connector-tile-${tile.id}-status`}
    >
      <HealthBadge tileId={tile.id} healthState={tile.instance.health_state} />
      {safetyFlag && (
        <span
          role="status"
          aria-label={safetyFlag.label}
          className={cn('flex items-center gap-1 text-xs font-medium', safetyFlag.className)}
        >
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          {safetyFlag.label}
        </span>
      )}
    </div>
  );
}

// ── ConnectorTile ─────────────────────────────────────────────────────────────

function ConnectorTile({ tile }: { tile: MarketplaceTile }) {
  const { mutate: connect, isPending: isConnecting } = useConnectConnector();
  const { mutate: disconnect, isPending: isDisconnecting } = useDisconnectConnector();
  const [shopDomain, setShopDomain] = useState('');

  const isConnected = !!tile.instance;
  const isComingSoon = !tile.available;

  function handleConnect() {
    if (isComingSoon) return; // guard: UI should never reach here for coming-soon tiles

    if (tile.connect_method === 'oauth' && tile.id === 'shopify') {
      const shop = shopDomain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!shop) {
        toast({
          title: 'Store domain required',
          description: 'Enter your Shopify store domain (e.g. my-store.myshopify.com).',
          variant: 'destructive',
        });
        return;
      }
      connect(
        { type: tile.id, shop_domain: shop },
        {
          onSuccess: (data) => {
            if (data.kind === 'oauth') {
              // Redirect to provider OAuth URL (D-10: data is already unwrapped)
              window.location.href = data.oauth_url;
            }
          },
          onError: (err) => {
            const msg =
              err instanceof BffApiError ? err.message : 'Could not start connection.';
            toast({ title: 'Connection failed', description: msg, variant: 'destructive' });
          },
        },
      );
    } else if (tile.connect_method === 'oauth') {
      // Non-shopify oauth (future)
      connect(
        { type: tile.id },
        {
          onSuccess: (data) => {
            if (data.kind === 'oauth') {
              window.location.href = data.oauth_url;
            }
          },
          onError: (err) => {
            const msg =
              err instanceof BffApiError ? err.message : 'Could not start connection.';
            toast({ title: 'Connection failed', description: msg, variant: 'destructive' });
          },
        },
      );
    }
  }

  function handleDisconnect() {
    if (!tile.instance) return;
    disconnect(tile.instance.id, {
      onSuccess: () => {
        toast({ title: 'Disconnected', description: `${tile.display_name} has been disconnected.` });
      },
      onError: (err) => {
        const msg = err instanceof BffApiError ? err.message : 'Could not disconnect.';
        toast({ title: 'Disconnect failed', description: msg, variant: 'destructive' });
      },
    });
  }

  return (
    <Card
      data-testid={`connector-tile-${tile.id}`}
      className={cn(
        'transition-shadow',
        tile.instance?.safety_rating === 'blocked' && 'border-status-red-200',
        tile.instance?.safety_rating === 'degraded' && 'border-status-amber-200',
      )}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              {tile.display_name}
              {isComingSoon && (
                <Badge
                  variant="outline"
                  className="text-xs"
                  data-testid="connector-tile-coming-soon"
                >
                  Coming Soon
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1 text-sm">{tile.description}</CardDescription>
          </div>
          {/* Status — icon + label, never colour-only (a11y) */}
          <TileStatusIndicator tile={tile} />
        </div>
      </CardHeader>

      <CardContent>
        {isComingSoon ? (
          /* Coming-soon: disabled + aria-disabled — structurally un-connectable at UI level */
          <Button
            variant="outline"
            disabled
            aria-label={`${tile.display_name} — Coming Soon, not yet available`}
            aria-disabled="true"
            className="cursor-not-allowed"
            title="This integration is coming soon"
            data-testid={`connector-tile-${tile.id}-connect`}
          >
            Coming Soon
          </Button>
        ) : isConnected ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {tile.instance?.shop_domain && (
              <p className="text-sm text-muted-foreground truncate">{tile.instance.shop_domain}</p>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              data-testid={`btn-disconnect-${tile.id}`}
            >
              {isDisconnecting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Shopify needs the store domain before OAuth redirect */}
            {tile.id === 'shopify' && tile.connect_method === 'oauth' && (
              <Input
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConnect();
                }}
                placeholder="my-store.myshopify.com"
                aria-label="Shopify store domain"
                autoComplete="off"
                data-testid={`input-shop-${tile.id}`}
              />
            )}
            <Button
              onClick={handleConnect}
              disabled={
                isConnecting ||
                (tile.id === 'shopify' && tile.connect_method === 'oauth' && !shopDomain.trim())
              }
              data-testid={`connector-tile-${tile.id}-connect`}
            >
              {isConnecting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {isConnecting ? 'Connecting…' : `Connect ${tile.display_name}`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Category section ──────────────────────────────────────────────────────────

function CategorySection({
  category,
  tiles,
}: {
  category: ConnectorCategory;
  tiles: MarketplaceTile[];
}) {
  return (
    <section aria-labelledby={`category-heading-${category}`} data-testid={`marketplace-category-${category}`}>
      <h2
        id={`category-heading-${category}`}
        className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3"
      >
        {CATEGORY_LABELS[category]}
      </h2>
      <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
        {tiles.map((tile) => (
          <ConnectorTile key={tile.id} tile={tile} />
        ))}
      </div>
    </section>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function MarketplaceSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading marketplace…">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-36 w-full" />
        </div>
      ))}
    </div>
  );
}

// ── MarketplaceView (exported) ────────────────────────────────────────────────

const CATEGORY_ORDER: ConnectorCategory[] = [
  'storefront',
  'ads',
  'payments',
  'logistics',
  'messaging',
  'crm',
  'analytics',
];

/** Friendly messages for the OAuth callback's ?connect_error= codes. */
const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  auth_failed: 'We could not verify the response from the provider. Please try connecting again.',
  state_invalid: 'The connection session expired. Please start the connection again.',
  shop_invalid: 'That store domain looks invalid. Check it and try again.',
  unknown_connector: 'That connector is not available yet.',
  unexpected: 'Something went wrong completing the connection. Please try again.',
};

export function MarketplaceView() {
  const { data: tiles, isLoading, error, refetch } = useMarketplace();
  const searchParams = useSearchParams();
  const router = useRouter();

  // The OAuth callback redirects back here with ?connected=<type> or ?connect_error=<code>.
  // Surface it as a toast, then strip the param so it doesn't re-fire on refetch/navigation.
  useEffect(() => {
    const connected = searchParams.get('connected');
    const connectError = searchParams.get('connect_error');
    if (!connected && !connectError) return;
    if (connected) {
      const name = connected.charAt(0).toUpperCase() + connected.slice(1);
      toast({ title: `${name} connected`, description: 'Your store is connected. You can now run a backfill.' });
    } else if (connectError) {
      toast({
        variant: 'destructive',
        title: 'Connection failed',
        description: CONNECT_ERROR_MESSAGES[connectError] ?? CONNECT_ERROR_MESSAGES['unexpected'],
      });
    }
    router.replace('/settings/connectors');
  }, [searchParams, router]);

  if (isLoading) return <MarketplaceSkeleton />;

  if (error) {
    return (
      <ErrorCard
        error={error}
        retry={refetch}
      />
    );
  }

  // Group tiles by category in canonical order
  const byCategory = new Map<ConnectorCategory, MarketplaceTile[]>();
  for (const cat of CATEGORY_ORDER) {
    byCategory.set(cat, []);
  }
  for (const tile of tiles ?? []) {
    const cat = tile.category as ConnectorCategory;
    if (byCategory.has(cat)) {
      byCategory.get(cat)!.push(tile);
    }
  }

  return (
    <div
      className="space-y-8"
    >
      {CATEGORY_ORDER.map((cat) => {
        const catTiles = byCategory.get(cat) ?? [];
        if (catTiles.length === 0) return null;
        return <CategorySection key={cat} category={cat} tiles={catTiles} />;
      })}
    </div>
  );
}
