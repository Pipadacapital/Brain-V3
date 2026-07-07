// SPEC:C.5.1
/**
 * getMetricLineage — analytics use-case (Wave C · C.5.1 measurement-lineage endpoint).
 *
 * Thin wrapper around computeMetricLineage (metric engine). It produces NO metric numbers — only the
 * provenance descriptor: for an executive/measurement metric, the Measurement fact tables it derives
 * from, each with a brand+as-of-scoped row count and the producing job version(s). This is the
 * auditor's proof that "every executive metric traces to Measurement facts" (§C.5.1).
 *
 * Isolation: computeMetricLineage reads exclusively through the withSilverBrand ${BRAND_PREDICATE}
 * Trino seam, so brand A's lineage never counts brand B's rows. Brand from session (D-1).
 *
 * @see packages/metric-engine/src/metric-lineage.ts
 */

import type { SilverPool, MetricLineage, LineageMetricId } from '@brain/metric-engine';
import { computeMetricLineage, isLineageMetric, listLineageMetrics } from '@brain/metric-engine';

export type MetricLineageResult =
  | { state: 'unknown_metric'; metric: string; supported: LineageMetricId[] }
  | ({ state: 'ok' } & MetricLineage);

/**
 * getMetricLineage — returns a metric's Measurement lineage.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param metric  - The metric id from the path.
 * @param date    - Optional as-of date (YYYY-MM-DD) — counts computed `<= date`. null → all-time.
 * @param deps    - { srPool } — the Trino serving pool (withSilverBrand seam).
 */
export async function getMetricLineage(
  brandId: string,
  metric: string,
  date: string | null,
  deps: { srPool: SilverPool },
): Promise<MetricLineageResult> {
  if (!isLineageMetric(metric)) {
    return { state: 'unknown_metric', metric, supported: listLineageMetrics() };
  }
  const lineage = await computeMetricLineage(brandId, metric, date, deps);
  return { state: 'ok', ...lineage };
}
