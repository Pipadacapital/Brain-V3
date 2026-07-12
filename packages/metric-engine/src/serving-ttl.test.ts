/**
 * serving-ttl — per-dataset TTL resolver (Gap 1, serving-layer gaps).
 *
 * Contract under test:
 *   • a dataset id mapped in METRIC_TTL_TIER resolves to its tier's TTL;
 *   • an UNMAPPED id falls back to the caller's defaultMs (backward-compat with the
 *     historical single global TRINO_SERVING_CACHE_TTL_MS behavior);
 *   • tierOverrides beat the built-in tier ms, but only when finite and > 0;
 *   • every METRIC_TTL_TIER value is a real tier (map integrity);
 *   • the map keys are the LIVE cache-key ids (adversarial-verify finding: a map keyed on
 *     registry MetricIds was dead — the route-level ids are what reach the resolver).
 */
import { describe, expect, it } from 'vitest';
import {
  METRIC_TTL_TIER,
  SERVING_TTL_TIER_MS,
  resolveServingTtlMs,
  type ServingTtlTier,
} from './serving-ttl.js';

const DEFAULT_MS = 300_000; // the historical global default (5 min)

describe('resolveServingTtlMs', () => {
  it('resolves a mapped dataset to its tier TTL (one per tier)', () => {
    expect(resolveServingTtlMs('kpi_summary', DEFAULT_MS)).toBe(SERVING_TTL_TIER_MS.executive);
    expect(resolveServingTtlMs('utm_source', DEFAULT_MS)).toBe(SERVING_TTL_TIER_MS.attribution);
    expect(resolveServingTtlMs('insights_briefing', DEFAULT_MS)).toBe(SERVING_TTL_TIER_MS.journey);
    expect(resolveServingTtlMs('product_detail', DEFAULT_MS)).toBe(SERVING_TTL_TIER_MS.product);
    expect(resolveServingTtlMs('cohort_retention', DEFAULT_MS)).toBe(SERVING_TTL_TIER_MS.analytics_long);
  });

  it('AUD-IMPL-026: the Bronze health endpoint ids sit on the executive (5 min) tier', () => {
    expect(resolveServingTtlMs('data_health', DEFAULT_MS)).toBe(SERVING_TTL_TIER_MS.executive);
    expect(resolveServingTtlMs('tracking_health', DEFAULT_MS)).toBe(SERVING_TTL_TIER_MS.executive);
    expect(resolveServingTtlMs('recent_events', DEFAULT_MS)).toBe(SERVING_TTL_TIER_MS.executive);
  });

  it('covers the full live cache-key id set (swept from the BFF route call sites)', () => {
    // The metricId strings passed to ServingCacheReader.read()/cachedRead() in apps/core —
    // dashboard.routes.ts, analytics-core.routes.ts, analytics-logistics.routes.ts, bff.routes.ts.
    // If a new cached read is added without a tier it still works (defaultMs), but keeping this
    // list in sync keeps the tiering real rather than decorative.
    const LIVE_IDS = [
      'realized_revenue', 'kpi_summary', 'executive_metrics', 'revenue_timeseries',
      'recognition_breakdown', 'foundation_signals', 'orders_timeseries', 'order_stats',
      'orders_list', 'utm_source', 'insights_briefing', 'product_categories', 'product_detail',
      'product_affinity', 'delivery_time', 'cohort_retention', 'cohort_users', 'repeat_latency',
      'revenue_monthly',
      // AUD-IMPL-026 — the Bronze health endpoints (tracking.routes.ts / analytics-marketing.routes.ts)
      // are now cache-wrapped; their full-Bronze-scan reads must sit on the 5-min executive tier.
      'data_health', 'tracking_health', 'recent_events',
    ];
    for (const id of LIVE_IDS) {
      expect(METRIC_TTL_TIER[id], `live id ${id} has no tier`).toBeDefined();
    }
  });

  it('falls back to defaultMs for an unmapped id (backward-compat)', () => {
    expect(resolveServingTtlMs('some_future_metric', DEFAULT_MS)).toBe(DEFAULT_MS);
    expect(resolveServingTtlMs('', DEFAULT_MS)).toBe(DEFAULT_MS);
    // Registry MetricIds that are NOT cache-key ids stay unmapped by design.
    expect(resolveServingTtlMs('journey_timeline', DEFAULT_MS)).toBe(DEFAULT_MS);
    expect(resolveServingTtlMs('top_products', DEFAULT_MS)).toBe(DEFAULT_MS);
  });

  it('honors per-tier overrides for mapped ids', () => {
    expect(resolveServingTtlMs('kpi_summary', DEFAULT_MS, { executive: 1_000 })).toBe(1_000);
    // Override on a DIFFERENT tier does not affect this id.
    expect(resolveServingTtlMs('kpi_summary', DEFAULT_MS, { journey: 1_000 })).toBe(
      SERVING_TTL_TIER_MS.executive,
    );
  });

  it('ignores non-finite / non-positive overrides', () => {
    expect(resolveServingTtlMs('kpi_summary', DEFAULT_MS, { executive: 0 })).toBe(
      SERVING_TTL_TIER_MS.executive,
    );
    expect(resolveServingTtlMs('kpi_summary', DEFAULT_MS, { executive: -5 })).toBe(
      SERVING_TTL_TIER_MS.executive,
    );
    expect(resolveServingTtlMs('kpi_summary', DEFAULT_MS, { executive: Number.NaN })).toBe(
      SERVING_TTL_TIER_MS.executive,
    );
    expect(
      resolveServingTtlMs('kpi_summary', DEFAULT_MS, { executive: Number.POSITIVE_INFINITY }),
    ).toBe(SERVING_TTL_TIER_MS.executive);
  });

  it('overrides never apply to unmapped ids (they still get defaultMs)', () => {
    expect(resolveServingTtlMs('some_future_metric', DEFAULT_MS, { executive: 1_000 })).toBe(DEFAULT_MS);
  });

  it('every METRIC_TTL_TIER entry points at a defined tier', () => {
    const tiers = Object.keys(SERVING_TTL_TIER_MS) as ServingTtlTier[];
    for (const [id, tier] of Object.entries(METRIC_TTL_TIER)) {
      expect(tiers, `id ${id} maps to unknown tier ${String(tier)}`).toContain(tier);
    }
  });
});
