/**
 * @brain/metric-engine — per-dataset serving-cache TTL resolver.
 *
 * Previously EVERY cached serving read shared ONE global TTL (TRINO_SERVING_CACHE_TTL_MS, default 5 min).
 * That is wrong for slow-moving datasets (cohorts/retention/monthly rollups barely change hour-to-hour)
 * and slightly risky for fast ones. This resolver maps each cached serving DATASET to a freshness TIER so
 * hot dashboards stay fresh while expensive-but-stable marts cache longer — the tiered-TTL model from the
 * serving spec.
 *
 * ── KEY DISCIPLINE (adversarial-verify finding, fixed) ────────────────────────────────────────────────
 * The map is keyed on the metricId string that ACTUALLY forms the cache key's 2nd segment — the
 * route-level dataset ids passed to ServingCacheReader.read()/cachedRead() in the BFF routes
 * (dashboard/analytics-core/analytics-logistics/bff.routes) — NOT the registry MetricId union (those
 * registry ids never reach the cache; a map keyed on them would be dead). If you add a new cached
 * serving read, add its id here to give it a tier; otherwise it uses the global default.
 *
 * PURE + testable (no process.env, no Redis). The composition root passes the historical global TTL as
 * `defaultMs`; an UNMAPPED id falls back to it, so this is fully backward-compatible (a dataset with no
 * tier behaves exactly as before).
 *
 * @see packages/metric-engine/src/serving-cache.ts — the reader that calls resolveServingTtlMs(metricId, …)
 * @see apps/core/src/modules/frontend-api/internal/routes/*.ts — the cachedRead call sites (id source)
 */

/** Freshness tiers (ms) — the serving-spec cadence per dataset class. */
export const SERVING_TTL_TIER_MS = {
  /** Home / executive KPIs + operational order surfaces — freshest (they head every dashboard). */
  executive: 5 * 60_000,
  /** Marketing / acquisition-source surfaces — moderately fast. */
  attribution: 10 * 60_000,
  /** Derived insight/briefing surfaces — per-visit reads over stable Gold. */
  journey: 15 * 60_000,
  /** Product / courier / catalog leaderboards. */
  product: 30 * 60_000,
  /** Slow-moving analytics: cohorts / retention / repeat-latency / monthly rollups. */
  analytics_long: 60 * 60_000,
} as const;

export type ServingTtlTier = keyof typeof SERVING_TTL_TIER_MS;

/**
 * Cache-key dataset id → freshness tier. The ids below are the EXACT strings used as the metricId
 * cache-key segment at the live call sites (swept 2026-07-02; every cachedRead / servingCache.read in
 * apps/core). An id NOT listed here has no tier and uses the caller's `defaultMs` (the historical single
 * global TTL) — so this map is purely ADDITIVE per-dataset tuning.
 */
export const METRIC_TTL_TIER: Readonly<Record<string, ServingTtlTier>> = {
  // Executive / home KPIs + operational order surfaces (5m)
  realized_revenue: 'executive',
  kpi_summary: 'executive',
  executive_metrics: 'executive',
  revenue_timeseries: 'executive',
  recognition_breakdown: 'executive',
  foundation_signals: 'executive',
  orders_timeseries: 'executive',
  order_stats: 'executive',
  orders_list: 'executive',
  // AUD-IMPL-026: the Bronze operational health endpoints (data-health / tracking-health /
  // recent-events) full-scan the unprunable collector_events_connect lift view per request —
  // brand_id/ingested_at/occurred_at are json_extract_scalar computed columns, so Trino gets no
  // predicate pushdown and the scan cost grows with the forever-retained history. The 5-minute
  // executive tier bounds that to at most one scan per (brand, params) per 5 min; AUD-IMPL-025's
  // partition spec on the Bronze table is the longer-term pruning fix.
  data_health: 'executive',
  tracking_health: 'executive',
  recent_events: 'executive',
  // Marketing / acquisition (10m)
  utm_source: 'attribution',
  // Derived insights (15m)
  insights_briefing: 'journey',
  // SPEC: B.3 — the Wave-B journey trace read surface (Trino ledger read; 15m 'journey'
  // tier keeps it warm within the p95 budget). The per-customer timeline (1) is served from the
  // A.4 real-time touchpoint cache instead, so it is NOT mapped here. (journey_compare removed
  // in the Wave-3 cleanup — AUD-IMPL-020.)
  journey_trace: 'journey',
  // Product / courier leaderboards (30m)
  product_categories: 'product',
  product_detail: 'product',
  product_affinity: 'product',
  delivery_time: 'product',
  // Slow analytics (1h)
  cohort_retention: 'analytics_long',
  cohort_users: 'analytics_long',
  repeat_latency: 'analytics_long',
  revenue_monthly: 'analytics_long',
};

/**
 * Resolve the cache TTL (ms) for a serving read.
 *
 * @param metricId  - the dataset id used as the cache-key's 2nd segment.
 * @param defaultMs - the composition-root global TTL, used for any UNMAPPED id (backward-compat).
 * @param tierOverrides - optional per-tier ms overrides (e.g. from config/env), merged over the defaults.
 */
export function resolveServingTtlMs(
  metricId: string,
  defaultMs: number,
  tierOverrides?: Partial<Record<ServingTtlTier, number>>,
): number {
  const tier = METRIC_TTL_TIER[metricId];
  if (!tier) return defaultMs;
  const overridden = tierOverrides?.[tier];
  if (typeof overridden === 'number' && Number.isFinite(overridden) && overridden > 0) return overridden;
  return SERVING_TTL_TIER_MS[tier];
}
