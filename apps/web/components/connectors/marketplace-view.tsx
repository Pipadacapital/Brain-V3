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
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SyncNowControl } from '@/components/connectors/sync-now-control';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { useMarketplace, useConnectConnector, useDisconnectConnector } from '@/lib/hooks/use-connectors';
import { useEntitlements } from '@/lib/hooks/use-entitlements';
import { useEmailVerified } from '@/lib/hooks/use-auth';
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

/** Soft-gate reason copy for connecting a real store before email is verified. */
const VERIFY_TO_CONNECT = 'Verify your email to connect a store';

// ── Per-provider credential field sets (C2 / ADR-RZ-8 + GoKwik/Shopflo Track C) ──
// A field marked secret=true is stored in the backend secret bundle and NEVER echoed
// back to the client (type="password", autoComplete="off"). Non-secret fields are
// merchant identifiers visible in the provider dashboard. The backend bundles all
// fields under ONE secret_ref per connector.
interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
}

const RAZORPAY_FIELDS: CredentialField[] = [
  { key: 'key_id', label: 'Key ID', placeholder: 'rzp_live_XXXXXXXX', secret: false },
  { key: 'key_secret', label: 'Key Secret', placeholder: '••••••••••••', secret: true },
  { key: 'webhook_secret', label: 'Webhook Secret', placeholder: '••••••••••••', secret: true },
  { key: 'razorpay_account_id', label: 'Account ID', placeholder: 'acc_XXXXXXXX', secret: false },
];

// Shopflo self-serve: static API Access Token + Merchant-ID + the webhook shared
// secret the merchant pastes from Dashboard → Settings → Integrations. api_token +
// webhook_secret are secrets; merchant_id is the (non-secret) merchant identifier.
const SHOPFLO_FIELDS: CredentialField[] = [
  { key: 'api_token', label: 'API Access Token', placeholder: '••••••••••••', secret: true },
  { key: 'merchant_id', label: 'Merchant ID', placeholder: 'merchant_XXXXXXXX', secret: false },
  { key: 'webhook_secret', label: 'Webhook Secret', placeholder: '••••••••••••', secret: true },
];

// GoKwik: static appid/appsecret (both partner-issued). appsecret is the secret; appid
// is the (non-secret) app identifier used for AWB re-pull enumeration.
const GOKWIK_FIELDS: CredentialField[] = [
  { key: 'appid', label: 'App ID', placeholder: 'app_XXXXXXXX', secret: false },
  { key: 'appsecret', label: 'App Secret', placeholder: '••••••••••••', secret: true },
];

/** Resolve a provider's credential fields; defaults to Razorpay's set for any other credential tile. */
function credentialFieldsFor(tileId: string): CredentialField[] {
  switch (tileId) {
    case 'shopflo':
      return SHOPFLO_FIELDS;
    case 'gokwik':
      return GOKWIK_FIELDS;
    default:
      return RAZORPAY_FIELDS;
  }
}

function ConnectorTile({ tile, readinessLock }: { tile: MarketplaceTile; readinessLock?: string | null }) {
  const { mutate: connect, isPending: isConnecting } = useConnectConnector();
  const { mutate: disconnect, isPending: isDisconnecting } = useDisconnectConnector();
  const { emailVerified } = useEmailVerified();
  const [shopDomain, setShopDomain] = useState('');
  // Razorpay credential form state (only used for credential tiles).
  const [creds, setCreds] = useState<Record<string, string>>({});

  const isConnected = !!tile.instance;
  const isComingSoon = !tile.available;
  const isCredential = tile.connect_method === 'credential';
  // Per-provider credential fields (Razorpay / Shopflo / GoKwik) — not a single hardcoded set.
  const credentialFields = credentialFieldsFor(tile.id);
  const credsComplete = credentialFields.every((f) => (creds[f.key] ?? '').trim().length > 0);

  /**
   * Connect-error toast. The server is the authoritative soft-gate (feat-onboarding-ux):
   * an unverified user hitting connect gets 403 EMAIL_NOT_VERIFIED even if the UI hint was
   * bypassed — surface that as a clear, actionable message rather than a generic failure.
   */
  function handleConnectError(err: unknown) {
    if (err instanceof BffApiError && err.code === 'EMAIL_NOT_VERIFIED') {
      toast({
        title: 'Verify your email first',
        description: `${VERIFY_TO_CONNECT}. Check your inbox for the verification link.`,
        variant: 'destructive',
      });
      return;
    }
    const msg = err instanceof BffApiError ? err.message : 'Could not start connection.';
    toast({ title: 'Connection failed', description: msg, variant: 'destructive' });
  }

  function handleConnect() {
    if (isComingSoon) return; // guard: UI should never reach here for coming-soon tiles

    // ── Credential connect (Razorpay — C2 / ADR-RZ-8) ──────────────────────────
    // Sends { key_id, key_secret, webhook_secret, razorpay_account_id }. The backend
    // stores secrets server-side and returns { kind:'credential', connected:true } —
    // it NEVER echoes the secrets. On success the marketplace query invalidates and
    // the tile flips to Connected (handled by useConnectConnector.onSuccess).
    if (isCredential) {
      if (!credsComplete) {
        toast({
          title: 'All fields required',
          description: `Enter all ${tile.display_name} credentials to connect.`,
          variant: 'destructive',
        });
        return;
      }
      const credentials = Object.fromEntries(
        credentialFields.map((f) => [f.key, (creds[f.key] ?? '').trim()]),
      );
      connect(
        { type: tile.id, credentials },
        {
          onSuccess: (data) => {
            if (data.kind === 'credential') {
              // Clear the secret form fields from memory immediately after a successful connect.
              setCreds({});
              toast({
                title: `${tile.display_name} connected`,
                description:
                  tile.id === 'gokwik' || tile.id === 'shopflo'
                    ? 'Data will appear here as it syncs. CoD/RTO uses synthetic dev data until a partner sandbox is available.'
                    : 'Settlement data will appear once Razorpay sends settlements.',
              });
            }
          },
          onError: (err) => {
            const msg = err instanceof BffApiError ? err.message : 'Could not connect Razorpay.';
            toast({ title: 'Connection failed', description: msg, variant: 'destructive' });
          },
        },
      );
      return;
    }

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
          onError: handleConnectError,
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
          onError: handleConnectError,
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
          <div className="space-y-3">
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
            {/* Sync now — on-demand incremental re-pull. Status visible to all roles;
                trigger gated to brand_admin+ (hidden for manager/analyst). */}
            {tile.instance?.id && (
              <SyncNowControl
                connectorId={tile.instance.id}
                className="pt-3 border-t border-border"
              />
            )}
          </div>
        ) : readinessLock ? (
          /* Progressive unlock (P2): this category isn't ready in the data foundation yet.
             We don't offer Connect — we explain what unlocks it, so the order is guided. */
          <div className="space-y-2" data-testid={`connector-tile-${tile.id}-locked`}>
            <Button
              variant="outline"
              disabled
              aria-disabled="true"
              className="cursor-not-allowed"
              title={readinessLock}
              aria-label={`${tile.display_name} — locked. ${readinessLock}`}
              data-testid={`connector-tile-${tile.id}-connect`}
            >
              <Lock className="mr-2 h-4 w-4" aria-hidden="true" />
              Locked
            </Button>
            <p className="text-xs text-muted-foreground" role="note">
              {readinessLock}
            </p>
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

            {/* Credential connectors (Razorpay) collect their credentials inline.
                Secret fields use type="password" + autoComplete="off"; the values are
                sent once to the BFF and never read back (the server omits them). */}
            {isCredential && (
              <div className="space-y-2" data-testid={`credential-form-${tile.id}`}>
                {credentialFields.map((f) => (
                  <div key={f.key} className="space-y-1">
                    <label
                      htmlFor={`cred-${tile.id}-${f.key}`}
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {f.label}
                    </label>
                    <Input
                      id={`cred-${tile.id}-${f.key}`}
                      type={f.secret ? 'password' : 'text'}
                      value={creds[f.key] ?? ''}
                      onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && credsComplete) handleConnect();
                      }}
                      placeholder={f.placeholder}
                      aria-label={`${tile.display_name} ${f.label}`}
                      autoComplete="off"
                      data-testid={`input-${tile.id}-${f.key}`}
                    />
                  </div>
                ))}
              </div>
            )}

            <Button
              onClick={handleConnect}
              disabled={
                isConnecting ||
                !emailVerified ||
                (tile.id === 'shopify' && tile.connect_method === 'oauth' && !shopDomain.trim()) ||
                (isCredential && !credsComplete)
              }
              aria-describedby={!emailVerified ? `connect-verify-hint-${tile.id}` : undefined}
              title={!emailVerified ? VERIFY_TO_CONNECT : undefined}
              data-testid={`connector-tile-${tile.id}-connect`}
            >
              {isConnecting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {isConnecting ? 'Connecting…' : `Connect ${tile.display_name}`}
            </Button>
            {/* Soft-gate reason hint — UX guidance only; the server gate is authoritative. */}
            {!emailVerified && (
              <p
                id={`connect-verify-hint-${tile.id}`}
                className="text-xs text-status-amber-700"
                data-testid={`connect-verify-hint-${tile.id}`}
                role="note"
              >
                {VERIFY_TO_CONNECT}.
              </p>
            )}
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
  readinessLock,
}: {
  category: ConnectorCategory;
  tiles: MarketplaceTile[];
  /** Set when this category isn't unlocked by the data foundation yet (the unlock hint). */
  readinessLock?: string | null;
}) {
  return (
    <section aria-labelledby={`category-heading-${category}`} data-testid={`marketplace-category-${category}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2
          id={`category-heading-${category}`}
          className="text-sm font-semibold text-muted-foreground uppercase tracking-wide"
        >
          {CATEGORY_LABELS[category]}
        </h2>
        {readinessLock && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
            role="status"
            title={readinessLock}
          >
            <Lock className="h-3 w-3" aria-hidden="true" />
            Locked
          </span>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
        {tiles.map((tile) => (
          <ConnectorTile key={tile.id} tile={tile} readinessLock={readinessLock} />
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
  const { data: entitlements } = useEntitlements();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Progressive unlock (P2): a category locks until the data foundation supports it. Lookup by key;
  // absent → unlocked (default-allow). storefront is always unlocked (the foundation root).
  const categoryLock = (cat: ConnectorCategory): string | null => {
    const e = entitlements?.connector_categories.find((c) => c.key === cat);
    return e && !e.eligible ? (e.unlock_hint ?? 'Locked until your data foundation supports it.') : null;
  };

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
        return <CategorySection key={cat} category={cat} tiles={catTiles} readinessLock={categoryLock(cat)} />;
      })}
    </div>
  );
}
