/**
 * @brain/metric-engine — Metric Registry (D-1)
 *
 * SINGLE SOURCE OF TRUTH for metric definitions, keyed by (metric_id, version).
 * A version bump = a NEW KEY, never a mutation of an existing key.
 * The engine resolves metric definitions via resolveMetric() before computing.
 * Models NEVER produce numbers (METRICS.md §Rules §5). This registry is
 * Tier-0 deterministic — zero model calls, zero tokens/day.
 *
 * @see METRICS.md — realized_revenue / provisional_revenue registry rows
 * @see D-1 architecture binding (03-architecture-plan.md)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type MetricId = 'realized_revenue' | 'provisional_revenue';
export type MetricVersion = `v${number}`;

export interface MetricDefinition {
  readonly metricId: MetricId;
  readonly version: MetricVersion;
  /** Human-readable definition — mirrors the METRICS.md registry row. */
  readonly description: string;
  /** The named DB read seam this metric resolves through (sole-as-of-path). */
  readonly readSeam: 'realized_gmv_as_of' | 'provisional_gmv_as_of';
  /**
   * recognition_label semantics this metric covers.
   * Cross-checked in registry unit test: realized→finalized; provisional→provisional/settling.
   * Structural documentation that the oracle uses to verify non-tautological coverage.
   */
  readonly recognitionLabels: readonly ('provisional' | 'settling' | 'finalized')[];
  /**
   * Money metrics are exact-integer (METRICS.md §Rules).
   * toleranceMinor = 0 for all money metrics. The parity oracle asserts this.
   */
  readonly toleranceMinor: 0;
}

// ── Registry (metric_id, version) keyed — immutable (as const) ───────────────

/**
 * METRIC_REGISTRY — the compile-time M1 metric registry.
 *
 * Shape: METRIC_REGISTRY[metricId][version]
 * A version bump = a NEW key (e.g. 'v2'), never a mutation of 'v1'.
 * The Postgres metric_definition table is the long-term SoR; this TS const
 * is the M1 binding (no DB lookup needed at M1).
 */
export const METRIC_REGISTRY = {
  realized_revenue: {
    v1: {
      metricId: 'realized_revenue' as const,
      version: 'v1' as const,
      readSeam: 'realized_gmv_as_of' as const,
      recognitionLabels: ['finalized'] as const,
      toleranceMinor: 0 as const,
      description:
        'Realized GMV as of a date: SUM(amount_minor) WHERE recognition_label=finalized ' +
        'AND economic_effective_at::date <= as_of, per currency_code. ' +
        'Excludes provisional/settling rows. Never blended across currencies. ' +
        'Sole emitter: metric-engine only (METRICS.md §realized_revenue).',
    },
  },
  provisional_revenue: {
    v1: {
      metricId: 'provisional_revenue' as const,
      version: 'v1' as const,
      readSeam: 'provisional_gmv_as_of' as const,
      recognitionLabels: ['provisional', 'settling'] as const,
      toleranceMinor: 0 as const,
      description:
        'Provisional GMV as of a date: SUM(amount_minor) WHERE recognition_label IN ' +
        "(provisional,settling) AND economic_effective_at::date <= as_of, per currency_code. " +
        'NEVER blended into realized_revenue. ' +
        'Sole emitter: metric-engine only (METRICS.md §provisional_revenue).',
    },
  },
} as const;

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * resolveMetric — look up a metric definition by (metricId, version).
 * Throws on unknown (metric_id, version) — the registry is the sole SoR.
 *
 * @param metricId - e.g. 'realized_revenue'
 * @param version  - e.g. 'v1'
 * @returns The frozen MetricDefinition.
 * @throws  Error if (metricId, version) is not in the registry.
 */
export function resolveMetric(
  metricId: MetricId,
  version: MetricVersion,
): MetricDefinition {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (METRIC_REGISTRY as any)[metricId]?.[version] as MetricDefinition | undefined;
  if (!def) {
    throw new Error(
      `[metric-engine] unknown metric (${metricId}, ${version}) — ` +
        'registry is the sole SoR. A version bump requires a new key (e.g. v2), ' +
        'not a mutation of the existing key.',
    );
  }
  return def;
}
