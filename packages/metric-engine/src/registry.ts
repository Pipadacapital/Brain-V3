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

export type MetricId =
  | 'realized_revenue'
  | 'provisional_revenue'
  | 'ad_spend'
  | 'blended_roas'
  | 'cod_rto_rate'
  | 'cod_mix'
  | 'checkout_funnel';
export type MetricVersion = `v${number}`;

export interface MetricDefinition {
  readonly metricId: MetricId;
  readonly version: MetricVersion;
  /** Human-readable definition — mirrors the METRICS.md registry row. */
  readonly description: string;
  /** The named DB read seam this metric resolves through (sole-as-of-path). */
  readonly readSeam:
    | 'realized_gmv_as_of'
    | 'provisional_gmv_as_of'
    | 'ad_spend_as_of'
    // GoKwik AWB-lifecycle terminal rows in bronze_events (gokwik.awb_status.v1).
    | 'awb_terminal_states'
    // realized_revenue_ledger cod_* event_types (0030).
    | 'cod_ledger'
    // Shopflo checkout_abandoned rows in bronze_events (shopflo.checkout_abandoned.v1).
    | 'checkout_abandoned';
  /**
   * recognition_label semantics this metric covers.
   * Cross-checked in registry unit test: realized→finalized; provisional→provisional/settling.
   * Structural documentation that the oracle uses to verify non-tautological coverage.
   * Ad metrics carry NO recognition labels (spend is not a recognition-staged fact) → [].
   */
  readonly recognitionLabels: readonly ('provisional' | 'settling' | 'finalized')[];
  /**
   * Money metrics are exact-integer (METRICS.md §Rules).
   * toleranceMinor = 0 for all money metrics. The parity oracle asserts this.
   * ad_spend (BIGINT minor units) is exact-integer = 0. blended_roas is a ratio of two
   * exact integer SUMs (no float rounding silently introduced) → also 0 (exact-rational).
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
  ad_spend: {
    v1: {
      metricId: 'ad_spend' as const,
      version: 'v1' as const,
      readSeam: 'ad_spend_as_of' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Ad spend over [from,to]: SUM(spend_minor) from ad_spend_ledger via ad_spend_as_of(), ' +
        'grouped by (platform, currency_code). BIGINT minor units (I-S07, Google micros→minor ' +
        'normalized at ingest). stat_date click-anchored (canonical). NEVER blended across ' +
        'currency_code. Sole emitter: metric-engine only via the ad_spend_as_of seam.',
    },
  },
  blended_roas: {
    v1: {
      metricId: 'blended_roas' as const,
      version: 'v1' as const,
      // blended_roas reads BOTH realized_gmv_as_of (numerator) and ad_spend_as_of
      // (denominator). The registry records the spend seam — the realized seam is the
      // existing realized_revenue registry entry, re-used (not duplicated here).
      readSeam: 'ad_spend_as_of' as const,
      recognitionLabels: ['finalized'] as const,
      toleranceMinor: 0 as const,
      description:
        'Blended ROAS = realized_revenue ÷ ad_spend, per currency_code. Numerator = ' +
        'realized_gmv_as_of (finalized GMV); denominator = ad_spend_as_of SUM(spend_minor). ' +
        'Both are exact BIGINT minor units — SAME-CURRENCY ONLY (never blended across ' +
        'currency_code). ROAS is reported ONLY where spend>0; spend=0 → null (honest, ' +
        'never divide-by-zero or fabricate). Ratio carries the two integer operands so the ' +
        'consumer can re-derive it exactly. Sole emitter: metric-engine only.',
    },
  },
  cod_rto_rate: {
    v1: {
      metricId: 'cod_rto_rate' as const,
      version: 'v1' as const,
      readSeam: 'awb_terminal_states' as const,
      // RTO rate is a count ratio over AWB terminal states, not a recognition-staged fact → [].
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'RTO rate = terminal-RTO shipments ÷ all-terminal shipments, by pincode cohort, ' +
        'from gokwik.awb_status.v1 Bronze rows (is_terminal=true) via the awb_terminal_states ' +
        'seam. In-flight AWBs excluded from the denominator. Categorical only — NO numeric RTO ' +
        'score is fabricated (GoKwik exposes High/Med/Low, recorded verbatim). Synthetic source ' +
        'in dev (real shape) → data_source surfaced for the honest Synthetic (dev) badge. ' +
        'Sole emitter: metric-engine only.',
    },
  },
  cod_mix: {
    v1: {
      metricId: 'cod_mix' as const,
      version: 'v1' as const,
      readSeam: 'cod_ledger' as const,
      recognitionLabels: ['finalized'] as const,
      toleranceMinor: 0 as const,
      description:
        'CoD CM2 + CoD-vs-prepaid mix from realized_revenue_ledger cod_* event_types (0030): ' +
        'net CoD = cod_delivery_confirmed (+) + cod_rto_clawback (−), per currency_code. RTO ' +
        'clawback is the realized cost of a return — net CoD is the contribution AFTER RTO ' +
        'leakage (the honest number the placed-CoD figure hides). Mix = net CoD ÷ (net CoD + ' +
        'prepaid finalization). BIGINT minor units, signed amount_minor (engine never re-signs), ' +
        'same-currency only. Sole emitter: metric-engine only.',
    },
  },
  checkout_funnel: {
    v1: {
      metricId: 'checkout_funnel' as const,
      version: 'v1' as const,
      readSeam: 'checkout_abandoned' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Checkout-conversion funnel from shopflo.checkout_abandoned.v1 Bronze rows over a bounded ' +
        'window via the checkout_abandoned seam: abandoned count, discount-applied count ' +
        '(total_discount_minor>0), with-address count (has_address=true), and abandoned cart value ' +
        '(SUM total_price_minor, BIGINT minor units). REAL Shopflo self-serve webhook (NOT synthetic). ' +
        'PII hashed at the mapper boundary — this read touches only counts + money. Sole emitter: ' +
        'metric-engine only.',
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
  const def = (METRIC_REGISTRY as Record<string, Record<string, MetricDefinition>>)[metricId]?.[version] as MetricDefinition | undefined;
  if (!def) {
    throw new Error(
      `[metric-engine] unknown metric (${metricId}, ${version}) — ` +
        'registry is the sole SoR. A version bump requires a new key (e.g. v2), ' +
        'not a mutation of the existing key.',
    );
  }
  return def;
}
