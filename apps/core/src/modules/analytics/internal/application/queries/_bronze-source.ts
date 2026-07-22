/**
 * _bronze-source.ts — shared helper for the operational-read collector-events source.
 *
 * REPOINTED Bronze → Silver (2026-07-20): these operational reads (data/tracking health, recent
 * events) used to scan the RAW Bronze lift view `brain_bronze.collector_events_connect_lifted` —
 * a full-table scan of the high-churn Kafka-Connect table with per-row JSON parsing. At scale that
 * blew past the 25s serving timeout (504s). They now read the COMPACTED, deduped Silver serving view
 * `brain_serving.mv_silver_collector_event` (canonicalized: event_id/event_type/occurred_at/
 * ingested_at/payload + anonymous_id/device_id, MERGE-deduped on brand_id/event_id) — fast, and the
 * canonical truth. The medallion-journey page keeps its own cheap Bronze *probe* (it must show the
 * Bronze stage); it does NOT use this seam. The read path goes through the metric-engine
 * withSilverBrand seam, which injects the tenant predicate at ${BRAND_PREDICATE} — so a query cannot
 * omit brand isolation. When the serving tier isn't wired (srPool absent), reads return honest no_data.
 */

import type { EngineDeps, SilverPool } from '@brain/metric-engine';

/** Deps for an operational read that sources collector events from the serving tier (duckdb-serving). */
export interface BronzeReadDeps extends EngineDeps {
  /** Serving pool — required to read the collector-events view. Absent → honest no_data. */
  readonly srPool?: SilverPool;
}

/**
 * The collector-events source over duckdb-serving: the COMPACTED Silver serving view (repointed off
 * the slow raw-Bronze lift view). Standard brain_serving.mv_* serving name — the metric-engine seam
 * injects ${BRAND_PREDICATE} for tenant isolation.
 */
export const COLLECTOR_EVENTS_VIEW = 'brain_serving.mv_silver_collector_event';
/**
 * Collector-lane predicate — the view is SINGLE-LANE (collector only), so this is a constant no-op
 * `TRUE`. Kept as an export so the callers' `AND ${COLLECTOR_PREDICATE}` SQL shape stays uniform.
 */
export const COLLECTOR_PREDICATE = 'TRUE';

/**
 * ADR-0018 F4/D4 — the pre-baked top-N recent-events RING (gold_recent_events / mv_gold_recent_events).
 * The transform tier runs the expensive ROW_NUMBER() top-200-per-brand sort ONCE per 5-min tick, so a
 * cache-miss reads a bounded ≤200-rows/brand table instead of full-scanning + global-top-N-sorting the
 * growing keystone mv_silver_collector_event (the last single-query-ceiling violation on this read).
 * `is_pixel` is precomputed; `details_json` carries the raw properties (the read side scrubs PII).
 */
export const RECENT_EVENTS_MART_VIEW = 'brain_serving.mv_gold_recent_events';

/**
 * Flag-gated source selector for getRecentEvents (ADR-0018 F4). DEFAULT OFF (staged, staging-first):
 * OFF ⇒ today's keystone-scan behavior (mv_silver_collector_event); ON ⇒ the pre-baked mart. Set
 * RECENT_EVENTS_FROM_MART=1|true to flip. The RecentEventsResult contract is byte-identical either
 * way — only the SQL + source view change. Default-OFF = merging this changes NOTHING in prod until
 * the mart + view are shipped and the flag is flipped.
 */
export function recentEventsFromMart(): boolean {
  const v = (process.env.RECENT_EVENTS_FROM_MART ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * True when the serving pool is wired (the only Bronze source now). Guards srPool presence so
 * a deployment without the serving tier returns honest no_data instead of erroring.
 */
export function hasSilver(deps: BronzeReadDeps): deps is BronzeReadDeps & { srPool: SilverPool } {
  return deps.srPool != null;
}
