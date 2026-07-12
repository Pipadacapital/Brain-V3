'use client';

/**
 * MarketplaceView — Integration Marketplace UI (feat-connector-marketplace B1/B2/B3).
 *
 * Layout: tiles grouped by category (storefront, ads, payments, logistics, messaging, crm, analytics).
 * Each tile shows TRUTHFUL status from catalog ⨝ instance:
 *   - Not connected → [Connect] action (oauth or credential).
 *   - coming_soon / available=false → "Coming Soon" disabled state (un-connectable at UI level).
 *   - connected → health StatusBadge + safety flag; per-account Disconnect + SyncNow.
 *   - blocked/degraded safety → visible warning flag.
 *
 * Connect-method rendering (the GA4 fix):
 *   - connect_method==='oauth' WITHOUT auth_fields  → a pure "Connect" action, NO credential inputs
 *     (GA4 connects via OAuth — it must never render another connector's credential form).
 *   - connect_method==='oauth' WITH auth_fields      → "Connect" + an OPTIONAL "bring your own app"
 *     Client ID / Client Secret pair (Shopify / Meta / Google Ads), driven by the server catalog.
 *   - connect_method==='credential'                  → the catalog's required credential fields.
 *   Fields come ONLY from the server catalog (tile.auth_fields). There is no cross-connector fallback.
 *
 * Gap B (multi-account-per-provider, migration 0092):
 *   - tile.instances[] = all active accounts for this provider; each renders its own sub-row.
 *
 * A11y: status is never colour-only (StatusBadge = dot + text); disabled actions carry aria-disabled.
 *
 * data-testids (per architecture plan B2):
 *   marketplace-page, connector-tile-{id}, connector-tile-{id}-status,
 *   connector-tile-{id}-connect, connector-tile-coming-soon, connector-health-badge-{id},
 *   marketplace-category-{cat}, btn-skip-for-now
 */

import { useState, useEffect, useMemo } from 'react';
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
  PlugZap,
  Copy,
  Check,
  Webhook,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { SectionCard } from '@/components/ui/section-card';
import { EmptyState } from '@/components/ui/empty-state';
import { SyncNowControl } from '@/components/connectors/sync-now-control';
import { BackfillControl } from '@/components/connectors/backfill-control';
import { ConnectorLogo } from '@/components/connectors/connector-logo';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { useMarketplace, useConnectConnector, useDisconnectConnector, useActivateAdAccount } from '@/lib/hooks/use-connectors';
import { useEntitlements } from '@/lib/hooks/use-entitlements';
import { useEmailVerified } from '@/lib/hooks/use-auth';
import { BffApiError, userFacingMessage } from '@/lib/api/client';
import { toast } from '@/components/ui/toaster';
import type { MarketplaceTile, MarketplaceTileInstance, ConnectorCategory, HealthState, SafetyRating, ConnectWebhookSetup } from '@/lib/api/types';
import { cn } from '@/lib/utils';

// ── Health state display config (icon + tone + label — never colour-only, a11y) ──────
// Tones map onto the design-system StatusBadge semantics (success/info/warning/destructive/neutral).

const HEALTH_CONFIG: Record<HealthState, { icon: React.ElementType; label: string; tone: StatusTone; pulse?: boolean }> = {
  Healthy: { icon: CheckCircle, label: 'Healthy', tone: 'success' },
  Delayed: { icon: Clock, label: 'Delayed', tone: 'warning' },
  RateLimited: { icon: Gauge, label: 'Rate limited', tone: 'warning' },
  Failed: { icon: XCircle, label: 'Failed', tone: 'destructive' },
  Disconnected: { icon: Plug, label: 'Disconnected', tone: 'neutral' },
  TokenExpired: { icon: Key, label: 'Reconnect needed — login expired', tone: 'destructive' },
  Disabled: { icon: Ban, label: 'Disabled', tone: 'neutral' },
};

// ── Safety rating flag display ────────────────────────────────────────────────

const SAFETY_FLAG: Record<SafetyRating, { label: string; tone: 'warning' | 'destructive' } | null> = {
  safe: null,
  degraded: { label: 'Degraded — data may be incomplete', tone: 'warning' },
  blocked: { label: 'Excluded — connector failing', tone: 'destructive' },
};

// ── Category display + helper copy ─────────────────────────────────────────────

const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  storefront: 'Storefront',
  ads: 'Advertising',
  payments: 'Payments',
  logistics: 'Logistics',
  messaging: 'Messaging',
  crm: 'CRM',
  analytics: 'Analytics',
};

const CATEGORY_BLURB: Record<ConnectorCategory, string> = {
  storefront: 'The order spine — Brain’s source of truth for every sale.',
  ads: 'Campaign spend & performance for true blended ROAS.',
  payments: 'Settlement, CoD verification and checkout-risk signal.',
  logistics: 'Shipment lifecycle, delivery and RTO outcomes.',
  messaging: 'Customer messaging channels.',
  crm: 'Contacts and deals from your CRM.',
  analytics: 'Web session analytics and source attribution.',
};

// ── Health badge ─────────────────────────────────────────────────────────────

function HealthBadge({ tileId, healthState }: { tileId: string; healthState: HealthState }) {
  const cfg = HEALTH_CONFIG[healthState];
  const Icon = cfg.icon;
  return (
    <StatusBadge
      tone={cfg.tone}
      role="status"
      aria-label={`Connection health: ${cfg.label}`}
      data-testid={`connector-health-badge-${tileId}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {cfg.label}
    </StatusBadge>
  );
}

// ── Tile status indicator (combined connect status + health) ──────────────────

function TileStatusIndicator({ tile, instance }: { tile: MarketplaceTile; instance: MarketplaceTileInstance | null }) {
  if (!instance) return null;
  const safetyFlag = SAFETY_FLAG[instance.safety_rating];

  return (
    <div className="flex flex-col items-end gap-1.5" data-testid={`connector-tile-${tile.id}-status`}>
      <HealthBadge tileId={tile.id} healthState={instance.health_state} />
      {safetyFlag && (
        <span
          role="status"
          aria-label={safetyFlag.label}
          className={cn(
            'flex items-center gap-1 text-xs font-medium',
            safetyFlag.tone === 'destructive' ? 'text-destructive' : 'text-warning',
          )}
        >
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          {safetyFlag.label}
        </span>
      )}
    </div>
  );
}

// ── Per-provider credential field sets (server catalog = single SoR) ──────────
// credentialFieldsFor() is a no-fallback shim (returns []); the marketplace renders from the
// server-supplied tile.auth_fields.
import { credentialFieldsFor as _credentialFieldsFor, authFieldsToCredentialFields } from './credential-fields';
export type { CredentialField } from './credential-fields';

const credentialFieldsFor = _credentialFieldsFor;

// 1 brand = 1 storefront: pure helpers that mirror the backend exclusivity rule so the UI can
// disable the other storefront tiles instead of letting the user hit a 409 STOREFRONT_ALREADY_CONNECTED.
import { findConnectedStorefront, storefrontLockReason, supportsHistoricalBackfill } from './storefront-exclusivity';

/** Soft-gate reason copy for connecting a real store before email is verified. */
const VERIFY_TO_CONNECT = 'Verify your email to connect a store';

// ── Webhook setup panel (SR-2) ────────────────────────────────────────────────
// After a credential connect that minted a webhook token (Shiprocket), show the merchant the exact
// URL + routing header + token to paste into their provider dashboard. The token is returned ONCE
// (write-only in the secret bundle thereafter), so this panel persists until dismissed.

/** A single copyable label/value row with a copy-to-clipboard affordance. */
function CopyRow({ tileId, fieldKey, label, value, secret }: { tileId: string; fieldKey: string; label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: 'Copy failed', description: 'Select the value and copy it manually.', variant: 'destructive' });
    }
  };
  return (
    <div className="space-y-1">
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground"
          data-testid={`webhook-${tileId}-${fieldKey}-value`}
          title={value}
        >
          {secret ? value.replace(/.(?=.{6})/g, '•') : value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          aria-label={`Copy ${label}`}
          data-testid={`webhook-${tileId}-${fieldKey}-copy`}
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

function WebhookSetupPanel({ tileId, displayName, setup, onDismiss }: { tileId: string; displayName: string; setup: ConnectWebhookSetup; onDismiss: () => void }) {
  // Manual setup = the merchant must paste something into the provider dashboard (a minted API key
  // and/or routing header — Shiprocket/GoKwik). Shopify registers its webhooks automatically via the
  // Admin API and returns only the delivery URL (api_key null) — informational, nothing to paste.
  const manualSetup = Boolean(setup.api_key || setup.routing_header);
  return (
    <div
      className="mb-4 space-y-3 rounded-md border border-primary/30 bg-primary/5 p-4"
      role="region"
      aria-label={`${displayName} webhook setup`}
      data-testid={`webhook-setup-${tileId}`}
    >
      <div className="flex items-start gap-2">
        <Webhook className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {manualSetup ? `Finish in your ${displayName} dashboard` : 'Webhooks registered automatically'}
          </p>
          <p className="text-xs text-muted-foreground">
            {manualSetup
              ? 'Add this webhook so updates reach Brain in real time. Copy the API key now — it is shown only once.'
              : `Brain registered its webhooks on your ${displayName} store for you — no action needed. This is the delivery URL, for reference.`}
          </p>
        </div>
      </div>
      <CopyRow tileId={tileId} fieldKey="url" label="Webhook URL" value={setup.url} />
      {setup.routing_header && (
        <CopyRow
          tileId={tileId}
          fieldKey="header"
          label={`Header: ${setup.routing_header.name}`}
          value={setup.routing_header.value}
        />
      )}
      {setup.api_key && (
        <CopyRow tileId={tileId} fieldKey="apikey" label="X-Api-Key" value={setup.api_key} secret />
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onDismiss}
        className="text-xs"
        data-testid={`webhook-setup-${tileId}-done`}
      >
        I&apos;ve added the webhook
      </Button>
    </div>
  );
}

function ConnectorTile({
  tile,
  readinessLock,
  connectedStorefront,
}: {
  tile: MarketplaceTile;
  readinessLock?: string | null;
  /** The brand's already-connected storefront tile (if any) — drives the 1-storefront lock. */
  connectedStorefront?: MarketplaceTile | null;
}) {
  const { mutate: connect, isPending: isConnecting } = useConnectConnector();
  const { mutate: disconnect, isPending: isDisconnecting } = useDisconnectConnector();
  const { mutate: activateAccount, isPending: isActivating } = useActivateAdAccount();
  const { emailVerified } = useEmailVerified();
  const [shopDomain, setShopDomain] = useState('');
  const [creds, setCreds] = useState<Record<string, string>>({});
  // SR-2: webhook setup returned ONCE on connect (Shiprocket) — persists until the merchant dismisses it.
  const [webhookSetup, setWebhookSetup] = useState<ConnectWebhookSetup | null>(null);
  // OAuth tiles hide the optional "bring your own app" fields behind a disclosure to keep the tile calm.
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Gap B: derive active instances array; fall back to legacy tile.instance for back-compat.
  const activeInstances: MarketplaceTileInstance[] =
    tile.instances?.length > 0 ? tile.instances : tile.instance ? [tile.instance] : [];

  const isConnected = activeInstances.length > 0;
  const firstInstance = activeInstances[0] ?? null;
  const isComingSoon = !tile.available;

  // 1 brand = 1 storefront: a DIFFERENT storefront is locked once the brand already has one
  // connected (non-null reason ⇒ render disabled with the helper copy). Null for the connected
  // storefront itself and for every non-storefront tile.
  const storefrontLock = storefrontLockReason(tile, connectedStorefront ?? null);
  const isCredential = tile.connect_method === 'credential';
  const isOauth = tile.connect_method === 'oauth';

  // Server catalog is the SoR for fields. For OAuth tiles the catalog only declares the OPTIONAL
  // "bring your own app" Client ID/Secret pair — a field-less OAuth tile (GA4) renders NO inputs,
  // just the OAuth Connect action. The hardcoded fallback is intentionally empty (no cross-connector
  // leakage), so fields exist ONLY when the server sent them.
  const serverFields =
    tile.auth_fields && tile.auth_fields.length > 0
      ? authFieldsToCredentialFields(tile.auth_fields)
      : credentialFieldsFor(tile.id);

  // Credential connectors render their required fields inline. OAuth tiles render the optional BYO-app
  // fields ONLY when the catalog declares them (so GA4, with none, stays a pure Connect button).
  const credentialFields = isCredential ? serverFields : [];
  const oauthAppFields = isOauth ? serverFields : [];
  const hasOauthAppFields = oauthAppFields.length > 0;

  const credsComplete = credentialFields.every((f) => f.optional || (creds[f.key] ?? '').trim().length > 0);

  function handleConnectError(err: unknown) {
    if (err instanceof BffApiError && err.code === 'EMAIL_NOT_VERIFIED') {
      toast({
        title: 'Verify your email first',
        description: `${VERIFY_TO_CONNECT}. Check your inbox for the verification link.`,
        variant: 'destructive',
      });
      return;
    }
    const msg = err instanceof BffApiError ? userFacingMessage(err) : 'Could not start connection.';
    toast({ title: 'Connection failed', description: msg, variant: 'destructive' });
  }

  function handleConnect() {
    if (isComingSoon) return;

    // ── Credential connect ──────────────────────────────────────────────────
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
              setCreds({});
              // SR-2: surface the per-tenant webhook URL + token the merchant must paste into their
              // provider dashboard (Shiprocket). Returned once — persist it on the tile.
              if (data.webhook) setWebhookSetup(data.webhook);
              const description =
                tile.id === 'shopify'
                  ? 'Store connected — webhooks were registered automatically. Orders, products and customers will sync shortly.'
                  : tile.id === 'gokwik' || tile.id === 'shopflo'
                    ? 'Data will appear here as it syncs. CoD/RTO shows sample data until live courier tracking is available.'
                    : tile.id === 'shiprocket'
                      ? 'Shipment data syncs automatically. Finish the webhook setup below to get real-time delivery & RTO updates.'
                      : tile.id === 'ga4'
                        ? 'Property connected — sessions, source/medium and revenue will sync from the GA4 Data API shortly.'
                        : 'Settlement data will appear once Razorpay sends settlements.';
              toast({ title: `${tile.display_name} connected`, description });
            }
          },
          onError: (err) => {
            const msg = err instanceof BffApiError ? userFacingMessage(err) : `Could not connect ${tile.display_name}. Check your credentials and try again.`;
            toast({ title: 'Connection failed', description: msg, variant: 'destructive' });
          },
        },
      );
      return;
    }

    // ── OAuth connect ─────────────────────────────────────────────────────────
    // Include any optional BYO-app Client ID/Secret the brand entered; omitting them lets the server
    // fall back to Brain's env-registered OAuth app. (oauthAppFields is empty for GA4 → never set.)
    const oauthCredentials = (() => {
      const entries = oauthAppFields
        .map((f) => [f.key, (creds[f.key] ?? '').trim()] as const)
        .filter(([, v]) => v.length > 0);
      return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    })();

    if (tile.id === 'shopify') {
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
        { type: tile.id, shop_domain: shop, ...(oauthCredentials ? { credentials: oauthCredentials } : {}) },
        {
          onSuccess: (data) => {
            if (data.kind === 'oauth') window.location.href = data.oauth_url;
          },
          onError: handleConnectError,
        },
      );
    } else {
      // Meta / Google Ads / GA4. Pass any brand-supplied OAuth app creds (none for GA4).
      connect(
        { type: tile.id, ...(oauthCredentials ? { credentials: oauthCredentials } : {}) },
        {
          onSuccess: (data) => {
            if (data.kind === 'oauth') window.location.href = data.oauth_url;
          },
          onError: handleConnectError,
        },
      );
    }
  }

  function handleDisconnect(instanceId: string) {
    disconnect(instanceId, {
      onSuccess: () => {
        toast({ title: 'Disconnected', description: `${tile.display_name} has been disconnected.` });
      },
      onError: (err) => {
        const msg = err instanceof BffApiError ? err.message : 'Could not disconnect.';
        toast({ title: 'Disconnect failed', description: msg, variant: 'destructive' });
      },
    });
  }

  // 0106: ad-account activation. An agency/MCC login exposes many accounts; only the activated one
  // ingests (switch semantics — activating one deactivates its siblings).
  const isAdTile = tile.category === 'ads';
  const noneActive = isAdTile && activeInstances.length > 0 && !activeInstances.some((i) => i.is_active);
  const activeOrFirst = activeInstances.find((i) => i.is_active) ?? firstInstance;

  function handleActivate(instanceId: string, label: string) {
    activateAccount(instanceId, {
      onSuccess: () => {
        toast({
          title: 'Account activated',
          description: `Only ${label} will ingest ${tile.display_name} data from now on.`,
        });
      },
      onError: (err) => {
        const msg = err instanceof BffApiError ? err.message : 'Could not activate this account.';
        toast({ title: 'Activation failed', description: msg, variant: 'destructive' });
      },
    });
  }

  // ── Credential input rows (shared by credential connectors + OAuth BYO-app disclosure) ──
  const renderFields = (fields: typeof credentialFields) => (
    <div className="space-y-3" data-testid={`credential-form-${tile.id}`}>
      {fields.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label htmlFor={`cred-${tile.id}-${f.key}`} className="text-xs text-muted-foreground">
            {f.label}
          </Label>
          <Input
            id={`cred-${tile.id}-${f.key}`}
            type={f.secret ? 'password' : 'text'}
            value={creds[f.key] ?? ''}
            onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (!isCredential || credsComplete)) handleConnect();
            }}
            placeholder={f.placeholder}
            aria-label={`${tile.display_name} ${f.label}`}
            autoComplete="off"
            data-testid={`input-${tile.id}-${f.key}`}
          />
          {f.hint && (
            <p id={`cred-${tile.id}-${f.key}-hint`} className="text-[11px] text-muted-foreground" role="note">
              {f.hint}
            </p>
          )}
        </div>
      ))}
    </div>
  );

  const safetyBorder =
    firstInstance?.safety_rating === 'blocked'
      ? 'border-destructive/40'
      : firstInstance?.safety_rating === 'degraded'
        ? 'border-warning/40'
        : 'border-border';

  return (
    <div
      data-testid={`connector-tile-${tile.id}`}
      className={cn(
        'flex flex-col rounded-lg border bg-card p-5 shadow-xs transition-shadow hover:shadow-sm',
        safetyBorder,
      )}
    >
      {/* Header: logo + name + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <ConnectorLogo id={tile.id} name={tile.display_name} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold text-foreground">{tile.display_name}</h3>
              {isComingSoon && (
                <Badge variant="secondary" className="shrink-0" data-testid="connector-tile-coming-soon">
                  Coming soon
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{tile.description}</p>
          </div>
        </div>
        <TileStatusIndicator tile={tile} instance={firstInstance} />
      </div>

      {/* Action region */}
      <div className="mt-4">
        {/* SR-2: webhook setup (Shiprocket) — shown after connect, persists across the connected flip. */}
        {webhookSetup && (
          <WebhookSetupPanel
            tileId={tile.id}
            displayName={tile.display_name}
            setup={webhookSetup}
            onDismiss={() => setWebhookSetup(null)}
          />
        )}
        {isComingSoon ? (
          <Button
            variant="outline"
            disabled
            aria-label={`${tile.display_name} — Coming Soon, not yet available`}
            aria-disabled="true"
            className="w-full cursor-not-allowed"
            title="This integration is coming soon"
            data-testid={`connector-tile-${tile.id}-connect`}
          >
            Coming soon
          </Button>
        ) : isConnected ? (
          <div className="space-y-3">
            {noneActive && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground"
                data-testid={`connector-tile-${tile.id}-select-account`}
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Select <strong>one</strong> ad account to ingest. Only the activated account&apos;s
                  spend flows into this brand — the others stay connected but idle.
                </span>
              </div>
            )}
            {activeInstances.map((inst, idx) => {
              const showAccountKey = inst.account_key && inst.account_key !== '__default__';
              const accountLabel = inst.account_label ?? inst.account_key ?? tile.display_name;
              return (
                <div
                  key={inst.id}
                  className={cn(
                    'flex flex-col gap-3 sm:flex-row sm:items-center',
                    activeInstances.length > 1 && idx > 0 && 'border-t border-border pt-3',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    {showAccountKey && (
                      <>
                        {inst.account_label && (
                          <p className="truncate text-sm font-medium text-foreground">{inst.account_label}</p>
                        )}
                        <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">
                          {inst.account_key}
                        </p>
                      </>
                    )}
                    {inst.shop_domain && (
                      <p className="truncate text-sm text-muted-foreground">{inst.shop_domain}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {isAdTile &&
                      (inst.is_active ? (
                        <StatusBadge
                          tone="success"
                          role="status"
                          aria-label={`${accountLabel} is the active ingesting account`}
                          data-testid={`connector-tile-${tile.id}-active-${idx}`}
                        >
                          <CheckCircle className="h-3 w-3" aria-hidden="true" />
                          Active
                        </StatusBadge>
                      ) : (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => handleActivate(inst.id, accountLabel)}
                          loading={isActivating}
                          data-testid={`btn-activate-${tile.id}-${idx}`}
                        >
                          Activate
                        </Button>
                      ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDisconnect(inst.id)}
                      loading={isDisconnecting}
                      data-testid={`btn-disconnect-${tile.id}${activeInstances.length > 1 ? `-${idx}` : ''}`}
                    >
                      {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                    </Button>
                  </div>
                </div>
              );
            })}
            {activeOrFirst?.id && !noneActive && (
              <SyncNowControl connectorId={activeOrFirst.id} className="border-t border-border pt-3" />
            )}
            {/* G6: historical backfill trigger + live progress. Only render for providers with an
                actual backfill runner (supportsHistoricalBackfill — shopify via the bespoke queue
                runner, plus meta/google_ads/razorpay/shiprocket/ga4 via the generic ingestion
                framework). GoKwik (webhook-first) and WooCommerce (history via the SYNC lane) have no
                backfill-queue claimer, so showing the control there would orphan a 'queued' job. */}
            {activeOrFirst?.id && !noneActive && supportsHistoricalBackfill(tile) && (
              <BackfillControl connectorId={activeOrFirst.id} className="border-t border-border pt-3" />
            )}
          </div>
        ) : storefrontLock ? (
          /* 1 brand = 1 storefront: another storefront is already connected — disable, don't dead-end. */
          <div className="space-y-2" data-testid={`connector-tile-${tile.id}-storefront-locked`}>
            <Button
              variant="outline"
              disabled
              aria-disabled="true"
              className="w-full cursor-not-allowed"
              title={storefrontLock}
              aria-label={`${tile.display_name} — unavailable. ${storefrontLock}`}
              data-testid={`connector-tile-${tile.id}-connect`}
            >
              <Ban className="mr-2 h-4 w-4" aria-hidden="true" />
              One storefront per brand
            </Button>
            <p className="text-xs text-muted-foreground" role="note">
              {storefrontLock}
            </p>
          </div>
        ) : readinessLock ? (
          /* Progressive unlock (P2): category not ready yet — explain, don't offer Connect. */
          <div className="space-y-2" data-testid={`connector-tile-${tile.id}-locked`}>
            <Button
              variant="outline"
              disabled
              aria-disabled="true"
              className="w-full cursor-not-allowed"
              title={readinessLock}
              aria-label={`${tile.display_name} — locked. ${readinessLock}`}
              data-testid={`connector-tile-${tile.id}-connect`}
            >
              <Lock className="mr-2 h-4 w-4" aria-hidden="true" />
              Unlocks soon
            </Button>
            <p className="text-xs text-muted-foreground" role="note">
              {readinessLock}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Shopify needs the store domain before the OAuth redirect. */}
            {tile.id === 'shopify' && isOauth && (
              <div className="space-y-1">
                <Label htmlFor={`input-shop-${tile.id}`} className="text-xs text-muted-foreground">
                  Store domain
                </Label>
                <Input
                  id={`input-shop-${tile.id}`}
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
              </div>
            )}

            {/* Credential connectors: required fields rendered inline (server catalog SoR). */}
            {isCredential && credentialFields.length > 0 && renderFields(credentialFields)}

            <Button
              onClick={handleConnect}
              className="w-full"
              loading={isConnecting}
              disabled={
                isConnecting ||
                !emailVerified ||
                (tile.id === 'shopify' && isOauth && !shopDomain.trim()) ||
                (isCredential && !credsComplete)
              }
              aria-describedby={!emailVerified ? `connect-verify-hint-${tile.id}` : undefined}
              title={!emailVerified ? VERIFY_TO_CONNECT : undefined}
              data-testid={`connector-tile-${tile.id}-connect`}
            >
              {!isConnecting && <PlugZap className="mr-2 h-4 w-4" aria-hidden="true" />}
              {isConnecting ? 'Connecting…' : `Connect ${tile.display_name}`}
            </Button>

            {/* OAuth BYO-app: optional Client ID/Secret tucked behind a disclosure (catalog-declared only). */}
            {isOauth && hasOauthAppFields && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  aria-expanded={showAdvanced}
                  data-testid={`oauth-advanced-toggle-${tile.id}`}
                >
                  {showAdvanced ? 'Use Brain’s app instead' : 'Use your own OAuth app (optional)'}
                </button>
                {showAdvanced && renderFields(oauthAppFields)}
              </div>
            )}

            {!emailVerified && (
              <p
                id={`connect-verify-hint-${tile.id}`}
                className="text-xs text-warning"
                data-testid={`connect-verify-hint-${tile.id}`}
                role="note"
              >
                {VERIFY_TO_CONNECT}.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Category section ──────────────────────────────────────────────────────────

function CategorySection({
  category,
  tiles,
  readinessLock,
  connectedStorefront,
}: {
  category: ConnectorCategory;
  tiles: MarketplaceTile[];
  readinessLock?: string | null;
  connectedStorefront?: MarketplaceTile | null;
}) {
  const connectedCount = tiles.filter((t) => (t.instances?.length ?? 0) > 0 || t.instance).length;

  return (
    <SectionCard
      data-testid={`marketplace-category-${category}`}
      aria-labelledby={`category-heading-${category}`}
      title={<span id={`category-heading-${category}`}>{CATEGORY_LABELS[category]}</span>}
      description={CATEGORY_BLURB[category]}
      meta={
        <>
          {connectedCount > 0 && (
            <StatusBadge tone="success" role="status">
              {connectedCount} connected
            </StatusBadge>
          )}
          {readinessLock && (
            <StatusBadge tone="neutral" role="status" title={readinessLock}>
              <Lock className="h-3 w-3" aria-hidden="true" />
              Locks until ready
            </StatusBadge>
          )}
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
        {tiles.map((tile) => (
          <ConnectorTile
            key={tile.id}
            tile={tile}
            readinessLock={readinessLock}
            connectedStorefront={connectedStorefront}
          />
        ))}
      </div>
    </SectionCard>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function MarketplaceSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading marketplace…">
      {[1, 2, 3].map((i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-5">
          <Skeleton className="mb-4 h-4 w-28" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
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

  const categoryLock = (cat: ConnectorCategory): string | null => {
    const e = entitlements?.connector_categories.find((c) => c.key === cat);
    return e && !e.eligible ? (e.unlock_hint ?? 'Unlocks automatically once your data is ready.') : null;
  };

  // The OAuth callback redirects back here with ?connected=<type> or ?connect_error=<code>.
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

  // Group tiles by category in canonical order.
  const byCategory = useMemo(() => {
    const map = new Map<ConnectorCategory, MarketplaceTile[]>();
    for (const cat of CATEGORY_ORDER) map.set(cat, []);
    for (const tile of tiles ?? []) {
      const cat = tile.category as ConnectorCategory;
      if (map.has(cat)) map.get(cat)!.push(tile);
    }
    return map;
  }, [tiles]);

  if (isLoading) return <MarketplaceSkeleton />;
  if (error) return <ErrorCard error={error} retry={refetch} />;

  if (!tiles || tiles.length === 0) {
    return (
      <SectionCard>
        <EmptyState
          icon={<Plug />}
          title="No integrations available yet"
          description="The connector catalog is empty. Check back shortly — integrations appear here as soon as they are enabled for your workspace."
        />
      </SectionCard>
    );
  }

  const connectedTotal = (tiles ?? []).filter((t) => (t.instances?.length ?? 0) > 0 || t.instance).length;

  // 1 brand = 1 storefront: find the brand's connected storefront (if any) once, then disable the
  // other storefront tiles below (the backend would otherwise 409 STOREFRONT_ALREADY_CONNECTED).
  const connectedStorefront = findConnectedStorefront(tiles ?? []);

  return (
    <div className="space-y-6">
      {connectedTotal === 0 && (
        <div
          className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3"
          role="note"
        >
          <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            Start with your <span className="font-medium text-foreground">Storefront</span> — it’s the
            order spine and the source of truth everything else builds on.
          </p>
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const catTiles = byCategory.get(cat) ?? [];
        if (catTiles.length === 0) return null;
        return (
          <CategorySection
            key={cat}
            category={cat}
            tiles={catTiles}
            readinessLock={categoryLock(cat)}
            connectedStorefront={connectedStorefront}
          />
        );
      })}
    </div>
  );
}
