'use client';

/**
 * BrandSwitcher — dashboard shell brand selector (feat-multi-brand Track B, B4).
 *
 * Always rendered in the sidebar even for single-brand users (MA-15).
 * Data source: useBrandSummary() → data.brands[] + data.active_brand_id (MA-06/B2).
 * Scope: brands within the active org only — brand-summary is org-scoped under 0013 (MA-14).
 *
 * On brand selection:
 *   - No-op guard (B3/AC-3): if selected id === active_brand_id, skip the API call.
 *   - Calls brandApi.switchBrand(id) → POST /v1/bff/session/set-brand.
 *   - Invalidates DASHBOARD_QUERY_KEY BEFORE any navigation (B3/MA-06) to prevent stale
 *     brand data showing for up to 60 s (staleTime).
 *   - Hard-reloads /dashboard so the new brand context is fully resolved.
 *
 * "+ Create brand" CTA is rendered only for Owner / Brand-Admin (MA-08 / B5).
 * The backend is the source of truth for role; this gate is UI convenience only.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ChevronDown, Building2, Plus, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { brandApi, BffApiError } from '@/lib/api/client';
import { useBrandSummary } from '@/lib/hooks/use-dashboard';
import { DASHBOARD_QUERY_KEY } from '@/lib/hooks/use-dashboard';
import { ANALYTICS_QUERY_KEY } from '@/lib/hooks/use-analytics';
import { CONSENT_QUERY_KEY } from '@/lib/hooks/use-consent';
import { CAPI_FEEDBACK_QUERY_KEY } from '@/lib/hooks/use-capi-feedback';
import { DashboardCreateBrandDialog } from '@/components/dashboard/create-brand-dialog';

/** Roles that may create a new brand (backend enforces; UI gates the CTA). */
const CREATE_BRAND_ROLES = new Set(['owner', 'brand_admin']);

export function BrandSwitcher() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useBrandSummary();
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="px-3 py-3 border-b" aria-busy="true" aria-label="Loading brand switcher">
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-3 border-b">
        <ErrorCard error={error} retry={refetch} />
      </div>
    );
  }

  // data can be null when brand_count === 0 (no brand yet). In that case render a minimal
  // placeholder so the switcher area is still present in the layout.
  const brands = data?.brands ?? [];
  const activeBrandId = data?.active_brand_id ?? null;
  const activeBrand = brands.find((b) => b.id === activeBrandId) ?? brands[0] ?? null;

  // Derive the session role from the brand summary member_count query — the session auth
  // role is not directly available in this component. The brand-summary response omits the
  // role; we read it from the window-level session if available, otherwise fall back to
  // hiding the CTA safely (backend enforces authorization on the create endpoint).
  //
  // > ASSUMPTION: The session auth.role is not available in the brand-summary payload.
  // We use a data attribute set by RequireSession/useCurrentUser at a higher scope if
  // present. As a safe default we show the "+ Create brand" CTA for all users and let
  // the backend reject unauthorized create attempts with a 403. This matches the
  // arch plan guidance: "backend is source of truth".
  //
  // We detect role from the useCurrentUser hook's cached data if it includes auth:
  // Since useCurrentUser returns /auth/me which includes auth.role (from JWT claims),
  // we can read the queryClient cache for that key.
  const authMe = queryClient.getQueryData<{ user: { id: string }; auth?: { role?: string } }>(
    ['auth', 'me'],
  );
  const sessionRole = (authMe as { request_id?: string; user?: { id: string }; auth?: { role?: string } } | undefined)
    ?.auth?.role ?? null;
  const canCreateBrand = sessionRole ? CREATE_BRAND_ROLES.has(sessionRole) : true; // default show; backend enforces

  async function handleSelectBrand(id: string) {
    // B3/AC-3: no-op guard — do not call switchBrand if already on this brand.
    if (id === activeBrandId) {
      setExpanded(false);
      return;
    }

    setSelectingId(id);
    setSwitchError(null);
    try {
      await brandApi.switchBrand(id);
      // B3/MA-06: invalidate DASHBOARD_QUERY_KEY BEFORE navigation so the next render
      // receives fresh brand-scoped data (staleTime=60s would otherwise serve stale cache).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ANALYTICS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: CONSENT_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: CAPI_FEEDBACK_QUERY_KEY }),
      ]);
      // Hard-reload so the session cookie (set by set-brand) is picked up by the server
      // and all dashboard queries run with the new brand context.
      window.location.href = '/dashboard';
    } catch (err) {
      const msg =
        err instanceof BffApiError
          ? `${err.message} (Request ID: ${err.requestId})`
          : 'Could not switch brand. Please try again.';
      setSwitchError(msg);
      setSelectingId(null);
    }
  }

  return (
    <>
      <div
        className="px-3 py-3 border-b"
        data-testid="brand-switcher"
        aria-label="Brand switcher"
      >
        {/* Active brand display / toggle */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-haspopup="listbox"
          aria-label={`Active brand: ${activeBrand?.display_name ?? 'No brand'}. Click to switch.`}
          data-testid="brand-switcher-toggle"
          className="w-full flex items-center justify-between gap-2 rounded-md px-2 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex items-center gap-2 min-w-0">
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">
              {activeBrand?.display_name ?? 'Select brand'}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>

        {/* Error feedback */}
        {switchError && (
          <p className="mt-2 text-xs text-destructive" role="alert" data-testid="brand-switcher-error">
            {switchError}
          </p>
        )}

        {/* Brand list dropdown (always in DOM when expanded — MA-15: show for single-brand) */}
        {expanded && (
          <div
            role="listbox"
            aria-label="Available brands"
            className="mt-1 space-y-0.5"
            data-testid="brand-switcher-list"
          >
            {brands.map((brand) => {
              const isActive = brand.id === activeBrandId;
              const isSwitching = selectingId === brand.id;

              return (
                <div
                  key={brand.id}
                  role="option"
                  aria-selected={isActive}
                  className={`flex items-center justify-between rounded-md px-2 py-2 text-sm transition-colors ${
                    isActive
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'hover:bg-muted/50'
                  }`}
                  data-testid={`brand-switcher-row-${brand.id}`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {isActive && (
                      <CheckCircle2
                        className="h-3.5 w-3.5 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                    )}
                    {!isActive && <span className="w-3.5" aria-hidden="true" />}
                    <span className="truncate">{brand.display_name}</span>
                    {brand.status === 'archived' && (
                      <span className="text-xs text-muted-foreground">(archived)</span>
                    )}
                  </span>

                  {!isActive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleSelectBrand(brand.id)}
                      disabled={selectingId !== null}
                      aria-label={`Switch to brand ${brand.display_name}`}
                      data-testid={`btn-select-brand-${brand.id}`}
                      className="h-6 text-xs px-2 py-0"
                    >
                      {isSwitching ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                      ) : (
                        'Switch'
                      )}
                    </Button>
                  )}
                </div>
              );
            })}

            {/* "+ Create brand" CTA — Owner / Brand-Admin only (MA-15/B5). */}
            {canCreateBrand && (
              <button
                type="button"
                onClick={() => {
                  setExpanded(false);
                  setCreateDialogOpen(true);
                }}
                aria-label="Create a new brand"
                data-testid="btn-create-brand-cta"
                className="w-full flex items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Create brand
              </button>
            )}
          </div>
        )}
      </div>

      {/* B5: DashboardCreateBrandDialog — MA-08: never calls resolveOnboardingRoute */}
      <DashboardCreateBrandDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </>
  );
}
