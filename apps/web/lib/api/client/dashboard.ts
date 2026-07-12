// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import {
  RevenueSnapshotSchema,
} from '@brain/contracts';
import type {
  BrandStatus,
  DashboardBrandSummaryResponse,
  DashboardConnectionStatusResponse,
  DashboardDataStatusResponse,
  DashboardOnboardingResponse,
  DashboardRealizedRevenueResponse,
} from '../types';
import { bffFetch, parseData, type BffEnvelope } from './core';

// ── Dashboard (Postgres-only reads — arch plan §6.4) ─────────────────────────
//
// The BFF wraps every dashboard payload in a { request_id, data } envelope and uses
// its own field names (org_name, shopify.syncState, step.key, …). These adapters
// unwrap the envelope and map the BFF shape onto the component-facing types declared
// in ./types, so the card components and their types stay unchanged.

interface RawBrandSummary {
  org_name: string | null;
  // B2/MA-06: active_brand_id is new in 0013 — = auth.brandId from JWT.
  active_brand_id: string | null;
  brand_count: number;
  member_count: number;
  // status is server-trusted from the BFF brand-summary contract ('active' | 'archived').
  brands: Array<{ id: string; display_name: string; domain: string | null; status: BrandStatus }>;
}

interface RawConnectionStatus {
  shopify: {
    connected: boolean;
    status: string | null;
    syncState: string | null;
    lastSyncAt: string | null;
  };
  meta: { coming_soon: boolean };
  google: { coming_soon: boolean };
}

interface RawDataStatus {
  pixel: { installed: boolean; state: string | null; verifiedAt: string | null };
}

interface RawOnboarding {
  steps: Array<{ key: string; label: string; completed: boolean }>;
  completed_count: number;
  total_count: number;
  all_complete: boolean;
}

/** Maps an onboarding step key to the route that completes it (none for already-done steps). */
const ONBOARDING_STEP_ROUTE: Record<string, string | undefined> = {
  email_verified: undefined,
  workspace_created: '/workspace/new',
  brand_created: '/brand/new',
  shopify_connected: '/settings/connectors',
  pixel_installed: '/settings/pixel',
};

// ── Realized Revenue raw + mapped types (D-5 — raw and mapped SEPARATELY) ────
//
// RawRealizedRevenue = the BFF data payload (inside BffEnvelope<T>).
// DashboardRealizedRevenueResponse (in ./types) = the component-facing model.
// These two types are DISTINCT — mapping happens in getRealizedRevenue(), not in the card.

export const dashboardApi = {
  // null → no brand yet → card renders its "No Data Yet" empty state.
  getBrandSummary: async (): Promise<DashboardBrandSummaryResponse | null> => {
    const { data } = await bffFetch<BffEnvelope<RawBrandSummary>>('/v1/dashboard/brand-summary');
    if (!data || data.brand_count === 0) return null;
    // MA-06: active brand by id, not array index.
    // Prefer the brand matching active_brand_id; fall back to brands[0] only as last resort
    // (e.g. legacy sessions where active_brand_id may be null before 0013 deploys).
    const active = data.brands.find((b) => b.id === data.active_brand_id);
    return {
      workspace_name: data.org_name ?? '',
      brand_name: active?.display_name ?? data.brands[0]?.display_name ?? '',
      member_count: data.member_count,
      active_brand_id: data.active_brand_id ?? null,
      brands: data.brands,
    };
  },

  getConnectionStatus: async (): Promise<DashboardConnectionStatusResponse> => {
    const { data } = await bffFetch<BffEnvelope<RawConnectionStatus>>(
      '/v1/dashboard/connection-status',
    );
    const s = data?.shopify;
    return {
      connector_status: (s?.status ?? null) as DashboardConnectionStatusResponse['connector_status'],
      // null sync_state → card shows its empty state.
      sync_state: (s?.connected ? s.syncState : null) as DashboardConnectionStatusResponse['sync_state'],
      last_sync_at: s?.lastSyncAt ?? null,
      provider: (s?.connected ? 'shopify' : null) as DashboardConnectionStatusResponse['provider'],
    };
  },

  getDataStatus: async (): Promise<DashboardDataStatusResponse> => {
    const { data } = await bffFetch<BffEnvelope<RawDataStatus>>('/v1/dashboard/data-status');
    const p = data?.pixel;
    return {
      // null pixel_state → card shows its empty state.
      pixel_state: (p?.installed ? p.state : null) as DashboardDataStatusResponse['pixel_state'],
      pixel_installed_at: p?.verifiedAt ?? null,
    };
  },

  getOnboardingProgress: async (): Promise<DashboardOnboardingResponse> => {
    const { data } = await bffFetch<BffEnvelope<RawOnboarding>>(
      '/v1/dashboard/onboarding-progress',
    );
    const steps = (data?.steps ?? []).map((s) => ({
      id: s.key,
      label: s.label,
      completed: s.completed,
      route: ONBOARDING_STEP_ROUTE[s.key],
    }));
    return { steps, all_complete: data?.all_complete ?? false };
  },

  /**
   * GET /api/v1/dashboard/realized-revenue — § 4 contract.
   * Unwraps BffEnvelope<RawRealizedRevenue> → DashboardRealizedRevenueResponse.
   *
   * ENVELOPE: const { data } = await bffFetch<BffEnvelope<RawRealizedRevenue>>(...)
   * This is the ONE canonical unwrap — no flat-shape read (prevents the 9th mismatch).
   *
   * Amounts: minor-unit strings from the BFF (bigint serialized). The card uses
   * formatMoneyDisplay(minorString, currencyCode) — no /100, no parseFloat (D-7).
   *
   * state:'no_data' → realized/provisional are null → card shows "No data yet" (D-2).
   * realized and provisional are NEVER blended or summed (D-4).
   *
   * @param asOf - Optional YYYY-MM-DD date. If omitted, server defaults to today.
   */
  getRealizedRevenue: async (asOf?: string): Promise<DashboardRealizedRevenueResponse> => {
    const qs = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    // Validate at the seam against the single-source-of-truth contract (RevenueSnapshotSchema).
    // The discriminated union preserves the no_data/has_data arms EXACTLY — realized/provisional
    // are null only in no_data; money stays bigint-minor strings (never /100, never BigInt(undefined)).
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/dashboard/realized-revenue${qs}`,
    );
    return parseData(RevenueSnapshotSchema, env);
  },
};
