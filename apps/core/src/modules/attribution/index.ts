/**
 * Public interface for the `attribution` module (core monolith bounded context).
 * RULE: only this file may be imported by other modules — enforced by the ESLint
 * boundary rule. All implementation lives under ./internal/ and is private.
 * Spec: docs/05_Brain_Implementation_Build_Plan.md §3.
 *
 * ── OWNERSHIP (Phase 4 — Journey, feat-journey-touchpoint) ─────────────────────
 * The attribution bounded context OWNS the derived Silver layer `silver.touchpoint`
 * (sessionized SDK journey events → first/last-touch + deterministic cart-stitch).
 * This is the module's FIRST real capability: it defines the touchpoint layer
 * descriptor and the journey read contract that Phase 5 Attribution (the credit
 * ledger over touchpoints) will consume.
 *
 * The journey READS themselves are non-additive aggregations in the metric-engine
 * (ADR-004) surfaced through the analytics sole-read-path (ADR-002 / I-ST01) — the
 * attribution module names the layer + contract here; the metric-engine is the SOLE
 * reader of the Silver tier. Deterministic only — cart-stitch reads brain_anon_id
 * BACK from the order, never inferred (D-5).
 */

import {
  getJourneyFirstTouchMix,
  getJourneyStitchRate,
  getJourneyTimeline,
} from '../analytics/index.js';
import type {
  JourneyFirstTouchMixResult,
  JourneyStitchRateResult,
  JourneyTimelineResult,
} from '../analytics/index.js';

export {
  describeTouchpointLayer,
  TOUCHPOINT_LAYER,
} from './internal/touchpoint-layer.js';
export type { TouchpointLayerDescriptor } from './internal/touchpoint-layer.js';

/**
 * Phase 5 Attribution (feat-attribution-ledger) — the credit-ledger WRITER.
 * MEDALLION REALIGNMENT (Epic 2): appends credit + clawback rows to the LAKEHOUSE ledger
 * brain_gold.gold_attribution_credit (StarRocks) — NOT PostgreSQL (dropped). The metric engine is the
 * SOLE math layer (Tier-0 deterministic); this is the I/O adapter. (createAttributionReversalHook was
 * removed — its only caller, the live-ledger consumer, was deleted with the PG revenue write path.)
 */
export { AttributionCreditWriter } from './internal/credit-writer.js';
export type {
  WriteCreditParams,
  WriteClawbackParams,
  WriteResult,
} from './internal/credit-writer.js';

/**
 * The attribution WRITE pipeline driver — idempotently populates attribution_credit_ledger from
 * the realized ledger + Silver touches (credit on finalized orders, clawback on reversals). This is
 * what makes the dead writer live; the analytics attribution reads flip not_computed→has_data once
 * a brand has been reconciled.
 */
export { reconcileAttribution, reconcileDataDrivenAttribution } from './internal/reconcile-attribution.js';
export type { ReconcileResult, ReconcileDeps } from './internal/reconcile-attribution.js';

/**
 * The journey read contract this bounded context owns over `silver.touchpoint`.
 * Phase 5 Attribution consumes these reads; the implementations are the analytics
 * sole-read-path use-cases over the metric-engine Silver seam (I-ST01).
 */
export const journeyReads = {
  firstTouchMix: getJourneyFirstTouchMix,
  stitchRate: getJourneyStitchRate,
  timeline: getJourneyTimeline,
} as const;

export type {
  JourneyFirstTouchMixResult,
  JourneyStitchRateResult,
  JourneyTimelineResult,
};
