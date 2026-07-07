// SPEC:C.4
/**
 * measurement-migration.ts — the CAC/ROAS/executive marts-migration read seam (flag: measurement.marts_migration).
 *
 * SPEC:C.4 — CAC/ROAS/executive-KPI reads switch their SPEND input to the Wave-C measurement
 * namespace BEHIND the per-brand flag `measurement.marts_migration` (default OFF). This module is the
 * single place that resolves which spend serving-view a read uses:
 *
 *   OFF (default, pre-wave) → brain_serving.mv_silver_marketing_spend   (legacy input — byte-identical)
 *   ON                      → brain_serving.mv_gold_measurement_spend    (Wave-C measurement fact)
 *
 * WHY THIS IS PARITY-SAFE (AMD-16 R1): the measurement spend fact IS silver_marketing_spend — the
 * Wave-C `gold_measurement_spend` is a VIEW ALIAS over the exact same Iceberg rows (with the lineage
 * columns source_event_id/source_system added). So switching the FROM changes NO spend value and NO
 * revenue: CAC (spend÷new), ROAS (attributed÷spend) and executive spend KPIs are byte-identical either
 * way. The only program-wide non-zero deltas come from NEW cost/fee facts folding into
 * gold_order_economics (C.3) — never into these spend-denominated marts, and never into revenue
 * (C.4's "explained deltas from fees/costs, never revenue" rule). See the parity note:
 * knowledge-base/gates/wave-c-c4-parity-note.md.
 *
 * Threaded additively: each spend-reading metric fn takes an optional `measurementMartsMigration`
 * boolean on its deps; undefined/false → legacy view (every existing caller is unchanged). The flag is
 * read once per request at the BFF boundary (flagService.isFlagEnabled) and passed down.
 */

/** Legacy spend serving-view (pre-wave, default). */
export const LEGACY_SPEND_VIEW = 'brain_serving.mv_silver_marketing_spend';
/** Wave-C measurement spend serving-view (alias over the same silver fact + lineage cols; AMD-16). */
export const MEASUREMENT_SPEND_VIEW = 'brain_serving.mv_gold_measurement_spend';

/**
 * Resolve the spend serving-view for a read given the per-brand marts-migration flag.
 * @param measurementMartsMigration - the resolved `measurement.marts_migration` flag (default OFF).
 */
export function spendView(measurementMartsMigration?: boolean): string {
  return measurementMartsMigration ? MEASUREMENT_SPEND_VIEW : LEGACY_SPEND_VIEW;
}
