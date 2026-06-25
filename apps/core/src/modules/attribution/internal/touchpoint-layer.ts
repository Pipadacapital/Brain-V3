/**
 * touchpoint-layer.ts — the attribution module's descriptor for the Silver layer it owns.
 *
 * `silver.touchpoint` is a DERIVED Silver mart (StarRocks brain_silver) built by dbt from
 * Bronze SDK journey events (page.viewed / cart.viewed / cart.item_added), sessionized into
 * first/last-touch with deterministic channel + deterministic cart-stitch. The attribution
 * bounded context OWNS this layer; this descriptor is the single declarative source of truth
 * for its grain, key columns, and the deterministic-only invariant (D-5).
 *
 * This is intentionally a PURE domain descriptor — no I/O, no framework, no DB driver
 * (domain layer of the bounded context per DDD). The metric-engine is the SOLE reader of
 * the mart (I-ST01); this file never queries it.
 *
 * @see db/iceberg/spark/silver/ + brain_serving.mv_silver_touchpoint — the V4 mart (dbt removed)
 * @see packages/metric-engine/src/journey-mix.ts — the SOLE reader of this layer
 */

export interface TouchpointLayerDescriptor {
  /** The Silver mart name (StarRocks brain_silver schema). */
  readonly mart: 'silver_touchpoint';
  /** The grain: one row per (brand_id, brain_anon_id, touch_seq). */
  readonly grain: readonly ['brand_id', 'brain_anon_id', 'touch_seq'];
  /** Whether the layer is monetary. Touchpoints are NOT — counts only, no money column. */
  readonly hasMoney: false;
  /** The cart-stitch is deterministic (read-back from the order), NEVER probabilistic (D-5). */
  readonly stitch: 'deterministic';
  /** Replay-safe: re-running dbt yields byte-identical rows (idempotent from Bronze). */
  readonly replaySafe: true;
}

/** The frozen descriptor for the silver.touchpoint layer this module owns. */
export const TOUCHPOINT_LAYER: TouchpointLayerDescriptor = Object.freeze({
  mart: 'silver_touchpoint',
  grain: Object.freeze(['brand_id', 'brain_anon_id', 'touch_seq'] as const),
  hasMoney: false,
  stitch: 'deterministic',
  replaySafe: true,
});

/**
 * describeTouchpointLayer — return the ownership descriptor for `silver.touchpoint`.
 * The attribution module's first concrete public capability: it declares (not infers)
 * the shape + invariants of the Silver layer it owns, for Phase 5 Attribution to consume.
 */
export function describeTouchpointLayer(): TouchpointLayerDescriptor {
  return TOUCHPOINT_LAYER;
}
