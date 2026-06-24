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
  | 'checkout_funnel'
  | 'order_status_mix'
  | 'journey_first_touch_mix'
  | 'journey_stitch_rate'
  | 'journey_timeline'
  | 'attribution_credit'
  | 'attribution_reconciliation_rate'
  | 'attribution_confidence'
  // Phase 7 Data Quality — computed grade OUTPUTS (frozen letter, no persisted float).
  | 'cost_confidence'
  | 'effective_confidence'
  // H9 — executive headline metrics over the Gold serving marts (registry-as-SoR; parity-oracle'd).
  | 'aov'
  | 'cac'
  | 'ltv'
  | 'repeat_rate'
  | 'top_products'
  | 'cohort_retention';
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
    | 'checkout_abandoned'
    // Silver mart silver.order_state (StarRocks brain_silver), read via withSilverBrand.
    | 'silver_order_state'
    // Silver mart silver.touchpoint (StarRocks brain_silver), read via withSilverBrand
    // (Phase 4 — journey: first-touch mix, stitch hit-rate, touchpoint timeline).
    | 'silver_touchpoint'
    // Silver mart silver_shipment (StarRocks brain_silver), read via withSilverBrand
    // (Slice 2 — multi-source logistics: RTO%/courier/pincode, GoKwik AWB + Shiprocket).
    | 'silver_shipment'
    // attribution_credit_ledger (Postgres Gold, 0032) — the credit/clawback SoR.
    // Read seams: attributed_gmv_as_of / channel_contribution_as_of / attribution_confidence_mart
    // (all SECURITY INVOKER). The WRITER (the metric engine) appends credit + clawback rows;
    // these named seams are the SOLE attributed-sum read path (no ad-hoc SUM).
    | 'attribution_credit_ledger'
    // dq_check_result (Postgres, 0035) — the append-only DQ grade store the stream-worker
    // executors write (RLS FORCE per brand). cost_confidence/effective_confidence read the
    // LATEST grade per (category,target) here at metric-engine time — a computed grade OUTPUT,
    // never a persisted confidence float (I-ST01).
    | 'dq_check_result'
    // H9 — Gold serving marts (StarRocks brain_gold), read via withSilverBrand (I-ST01 sole reader).
    // gold_executive_metrics: brand-level additive components (realized value, orders, distinct
    // customers) — AOV/LTV/repeat_rate derived NON-additively at read in the engine (ADR-004).
    | 'gold_executive_metrics'
    // gold_cac: ad spend ÷ newly-acquired customers per acquisition_month (the CAC components).
    | 'gold_cac'
    // gold_revenue_analytics: month × lifecycle × currency realized rollup — the repeat/nth-order
    // and cohort-retention reads fold over the order spine via silver_order_state / gold_cohorts.
    | 'gold_revenue_analytics'
    // gold_cohorts: acquisition cohorts (first-seen month) → cohort_retention curve at read.
    | 'gold_cohorts'
    // silver_order_line rollup → top_products (per-SKU; non-additive at read, ADR-004).
    | 'silver_order_line';
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
      readSeam: 'silver_shipment' as const,
      // RTO rate is a count ratio over terminal shipment states, not a recognition-staged fact → [].
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'RTO rate = terminal-RTO shipments ÷ all-terminal shipments, by pincode cohort, from the ' +
        'multi-source silver_shipment mart (is_terminal=1; GoKwik AWB + Shiprocket via the shared ' +
        'terminal_class authority) through the withSilverBrand seam. In-flight shipments excluded ' +
        'from the denominator. Categorical only — NO numeric RTO score is fabricated. Synthetic ' +
        'source in dev (is_synthetic) → data_source surfaced for the honest Synthetic (dev) badge. ' +
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
        'CoD CM2 + CoD-vs-prepaid mix from the gold revenue ledger cod_* recognition event_types: ' +
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
  order_status_mix: {
    v1: {
      metricId: 'order_status_mix' as const,
      version: 'v1' as const,
      // The FIRST Silver-tier read: silver.order_state mart (StarRocks brain_silver),
      // read via the withSilverBrand seam (ADR-002 / I-ST01 sole reader). This is a
      // NON-additive aggregation (COUNT + share) over the additive dbt mart — it lives
      // in the engine, NOT dbt (ADR-004).
      readSeam: 'silver_order_state' as const,
      // Order lifecycle is a deterministic latest-state fold, not a recognition-staged
      // fact (the recognition label lives on the ledger, not the lifecycle) → [].
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Order-status-mix: COUNT + share-of-total + SUM(order_value_minor) by lifecycle_state ' +
        '(placed|confirmed|delivered|cancelled|rto|refunded) over a state_effective_at window, ' +
        'from the Silver mart silver.order_state (1 row per (brand_id,order_id), latest state). ' +
        'Non-additive aggregation → metric-engine, NOT dbt (ADR-004). Share is integer basis-point ' +
        'math (no float); money is BIGINT minor units + currency_code (I-S07). Honest no_data when ' +
        'the window has zero Silver rows. Read through withSilverBrand (brand predicate injected at ' +
        'the seam; I-ST01 sole reader). Sole emitter: metric-engine only.',
    },
  },
  journey_first_touch_mix: {
    v1: {
      metricId: 'journey_first_touch_mix' as const,
      version: 'v1' as const,
      // Phase 4 Silver read: silver.touchpoint mart (StarRocks brain_silver), read via
      // the withSilverBrand seam (I-ST01 sole reader). NON-additive aggregation (COUNT +
      // share) over the additive dbt mart — lives in the engine, NOT dbt (ADR-004).
      readSeam: 'silver_touchpoint' as const,
      // A first-touch channel mix is a deterministic count fold, not a recognition fact → [].
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Journey first-touch mix: COUNT(DISTINCT brain_anon_id) + share-of-total by ' +
        'deterministic channel (paid_meta|paid_google|paid_tiktok|paid|email|organic_social|' +
        'referral|direct) over an occurred_at window, WHERE is_first_touch, from the Silver mart ' +
        'silver.touchpoint (1 row per (brand_id,brain_anon_id,touch_seq)). Channel is a fixed ' +
        'deterministic CASE ladder in dbt (click_id→paid, else utm.medium, else referrer, else ' +
        'direct) — NEVER a classifier/ML (D-5). Non-additive aggregation → metric-engine, NOT dbt ' +
        '(ADR-004). Share is integer basis-point math (no float). NO money column (touchpoints are ' +
        'not monetary). Honest no_data when the window has zero Silver touchpoints. Read through ' +
        'withSilverBrand (brand predicate injected at the seam; I-ST01 sole reader). Sole emitter: ' +
        'metric-engine only.',
    },
  },
  journey_stitch_rate: {
    v1: {
      metricId: 'journey_stitch_rate' as const,
      version: 'v1' as const,
      readSeam: 'silver_touchpoint' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Journey cart-stitch hit-rate: stitched ÷ total distinct anon journeys over an occurred_at ' +
        'window, from silver.touchpoint. stitched = COUNT(DISTINCT brain_anon_id) WHERE ' +
        'stitched_brain_id IS NOT NULL; total = COUNT(DISTINCT brain_anon_id). The stitch is ' +
        'DETERMINISTIC — stitched_brain_id is read BACK from the order via the ' +
        'connector_journey_stitch_map (read-back, NEVER inferred/probabilistic — D-5). Integer ' +
        'basis-point math (no float); hitPct null when total=0 (honest, never divide-by-zero). ' +
        'Honest no_data on zero rows. Non-additive → metric-engine, NOT dbt (ADR-004). Read through ' +
        'withSilverBrand (I-ST01 sole reader). Sole emitter: metric-engine only.',
    },
  },
  journey_timeline: {
    v1: {
      metricId: 'journey_timeline' as const,
      version: 'v1' as const,
      readSeam: 'silver_touchpoint' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Journey touchpoint timeline: the ordered touch rows (touch_seq asc) for ONE journey — ' +
        'resolved by brain_anon_id directly OR by order_id via the deterministic ' +
        'connector_journey_stitch_map (read-back, D-5). A read projection (channel, utm_*, click_ids, ' +
        'occurred_at, is_first/last_touch) over silver.touchpoint — no aggregation, but still through ' +
        'the brand-scoped withSilverBrand seam (I-ST01 sole reader). NO money column. Honest no_data ' +
        'when the journey resolves to zero touches. Sole emitter: metric-engine only.',
    },
  },
  attribution_credit: {
    v1: {
      metricId: 'attribution_credit' as const,
      version: 'v1' as const,
      // The WRITER metric: per-touch weight_fraction (DECIMAL(9,8)) + credited_revenue_minor
      // appended to attribution_credit_ledger (Postgres Gold, 0032). Clawback mirrors negative
      // rows with the SAVED weight. The attributed-read path is attributed_gmv_as_of /
      // channel_contribution_as_of (named seams over this ledger).
      readSeam: 'attribution_credit_ledger' as const,
      // Credit is realized-revenue-derived (the order's finalized realized revenue is the basis).
      recognitionLabels: ['finalized'] as const,
      toleranceMinor: 0 as const,
      description:
        'Attribution credit (position-based, brand-configurable model set first/last/linear/' +
        'position_based default 40-40-20): per-touch weight_fraction DECIMAL(9,8) (Σ=1.0 exactly, ' +
        'scaled-integer math, NO float) over silver.touchpoint + the order realized_revenue_minor; ' +
        'credited_revenue_minor = largest-remainder apportionment so Σ credited = realized exactly. ' +
        'Clawback on RTO/refund/chargeback appends mirrored SIGNED-NEGATIVE rows with ' +
        'reversed_of_credit_id using the SAVED weight_fraction (never re-apportioned) — fully-RTO ' +
        'closed-sum=0. Append-only, deterministic credit_id (idempotent replay). Writer = ' +
        'metric-engine only (Tier-0 deterministic; I-E03/E04). SoR = attribution_credit_ledger (0032).',
    },
  },
  attribution_reconciliation_rate: {
    v1: {
      metricId: 'attribution_reconciliation_rate' as const,
      version: 'v1' as const,
      // attributed_gmv_as_of (numerator) + realized_gmv_as_of (existing 0018 seam) — same
      // pattern as blended_roas (records one seam; the other is re-used). channel_contribution_as_of
      // feeds the per-channel residual + the closed-sum oracle.
      readSeam: 'attribution_credit_ledger' as const,
      recognitionLabels: ['finalized'] as const,
      toleranceMinor: 0 as const,
      description:
        'Attribution reconciliation rate = (attributed_gmv_minor / realized_gmv_minor) × 100, ' +
        'NUMERIC(5,2), integer-basis-point math (no float). attributed_gmv_minor = ' +
        'attributed_gmv_as_of (Σ credited net of clawback); realized_gmv_minor = realized_gmv_as_of ' +
        '(0018). The unattributed residual = realized − attributed is ALWAYS rendered (never hidden). ' +
        'The closed-sum parity oracle: Σ channel_contribution_minor + unattributed_minor = ' +
        'realized_gmv_minor (CI-blocking, exact-integer tolerance 0). Sole emitter: metric-engine only.',
    },
  },
  attribution_confidence: {
    v1: {
      metricId: 'attribution_confidence' as const,
      version: 'v1' as const,
      readSeam: 'attribution_credit_ledger' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Attribution confidence: a DETERMINISTIC grade floor over a journey\'s touches — ' +
        'strong/1.000 (stitched + all deterministic channels), partial/0.700 (stitched but ≥1 ' +
        'cookieless/direct touch), weak/0.400 (unstitched/synthetic). FROZEN constants (no runtime ' +
        'float, no model — I-E03/E04). Stamped onto each credit row at credit time, carried verbatim ' +
        'onto clawback. Feeds effective_confidence = min(cost_confidence, attribution_confidence) ' +
        '(Phase-6 CM2/CAC). Read seam: attribution_confidence_mart (SECURITY INVOKER over the ledger). ' +
        'Sole emitter: metric-engine only.',
    },
  },
  cost_confidence: {
    v1: {
      metricId: 'cost_confidence' as const,
      version: 'v1' as const,
      readSeam: 'dq_check_result' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Cost confidence: a DETERMINISTIC letter grade (A+|A|B|C|D) = the FLOOR (ordinal min) over ' +
        'the COST-RELEVANT DQ grades — spend/settlement freshness + completeness + reconciliation — ' +
        'stamped into dq_check_result (0035) by the stream-worker DQ executors. FROZEN lookup (no ' +
        'runtime float, no model — I-E03/E04). Empty cost grades → D (honest, no data). A computed ' +
        'grade OUTPUT read at metric-engine time over dq_check_result (latest per (category,target)), ' +
        'never a persisted confidence float (I-ST01). Reads spend/settlement freshness, never re-floats ' +
        'money (money stays BIGINT minor + currency_code). Sole emitter: metric-engine only.',
    },
  },
  effective_confidence: {
    v1: {
      metricId: 'effective_confidence' as const,
      version: 'v1' as const,
      readSeam: 'dq_check_result' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Effective confidence = min(cost_confidence, attribution_confidence) by grade ordinal ' +
        '(A+ > A > B > C > D). The SINGLE grade the quality gate + the Data Quality UI read. ' +
        'DETERMINISTIC frozen ordinal min (no runtime float, no model — I-E03/E04); a computed grade ' +
        'OUTPUT at metric-engine time, never a persisted float (I-ST01). Drives the trust gate: ' +
        'Trusted (A+|A|B) → full recommendations + billing-cap applies + included in MMM; ' +
        'Estimated (C)/Untrusted (D) → degraded/blocked, no billing cap, excluded from MMM, ' +
        'blocks high-risk recommendations. Sole emitter: metric-engine only.',
    },
  },
  // ── H9 — executive headline metrics over the Gold serving marts ─────────────
  aov: {
    v1: {
      metricId: 'aov' as const,
      version: 'v1' as const,
      readSeam: 'gold_executive_metrics' as const,
      recognitionLabels: ['finalized'] as const,
      toleranceMinor: 0 as const,
      description:
        'Average Order Value = realized_value_minor ÷ total_orders, per currency_code, from the Gold ' +
        'mart gold_executive_metrics (additive components: SUM realized value + COUNT orders). ' +
        'NON-ADDITIVE ratio derived at READ in the engine (ADR-004) — Gold stores only the additive ' +
        'components. Integer division of BIGINT minor units (no float); null when orders=0 (honest, ' +
        'never divide-by-zero). SAME-CURRENCY ONLY. Read through withSilverBrand (I-ST01 sole reader). ' +
        'Sole emitter: metric-engine only.',
    },
  },
  cac: {
    v1: {
      metricId: 'cac' as const,
      version: 'v1' as const,
      readSeam: 'gold_cac' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Customer Acquisition Cost = acquisition_spend_minor ÷ new_customers per acquisition_month, ' +
        'per currency_code, from the Gold mart gold_cac (ad spend joined to first-order customers). ' +
        'BIGINT minor units (no float); null when new_customers=0 (honest, never divide-by-zero). ' +
        'SAME-CURRENCY ONLY. CAC is not a recognition-staged fact. Read through withSilverBrand ' +
        '(I-ST01 sole reader). Sole emitter: metric-engine only.',
    },
  },
  ltv: {
    v1: {
      metricId: 'ltv' as const,
      version: 'v1' as const,
      readSeam: 'gold_executive_metrics' as const,
      recognitionLabels: ['finalized'] as const,
      toleranceMinor: 0 as const,
      description:
        'Lifetime Value (cohort-naive M1) = realized_value_minor ÷ distinct_customers, per ' +
        'currency_code, from gold_executive_metrics. The honest realized-revenue-per-customer figure ' +
        '(NOT a predicted/discounted LTV — no model, no forecast; predictive LTV is deferred to the ' +
        'feature layer). NON-ADDITIVE ratio derived at READ (ADR-004). Integer division of BIGINT ' +
        'minor units (no float); null when distinct_customers=0. SAME-CURRENCY ONLY. Read through ' +
        'withSilverBrand (I-ST01 sole reader). Sole emitter: metric-engine only.',
    },
  },
  repeat_rate: {
    v1: {
      metricId: 'repeat_rate' as const,
      version: 'v1' as const,
      readSeam: 'gold_cohorts' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Repeat-purchase rate = customers with ≥2 lifetime orders ÷ all customers, per currency_code, ' +
        'folded over the customer order spine (gold_cohorts cohort_orders vs cohort_size). Integer ' +
        'basis-point math (no float); null when there are zero customers (honest). A deterministic ' +
        'count fold, not a recognition fact. NO subscription/repeat-billing connector (deferred) — ' +
        'repeat is over realized orders only. Read through withSilverBrand (I-ST01 sole reader). Sole ' +
        'emitter: metric-engine only.',
    },
  },
  top_products: {
    v1: {
      metricId: 'top_products' as const,
      version: 'v1' as const,
      readSeam: 'silver_order_line' as const,
      recognitionLabels: ['finalized'] as const,
      toleranceMinor: 0 as const,
      description:
        'Top products = per-SKU realized units + realized value rollup over silver.order_line, ranked ' +
        'desc by realized value, capped to top-N. NON-ADDITIVE rank/cap over the additive Silver mart ' +
        '→ metric-engine, NOT dbt (ADR-004). MONEY = BIGINT minor units + currency_code (I-S07). Honest ' +
        'no_data on zero lines. Read through withSilverBrand (I-ST01 sole reader). Sole emitter: ' +
        'metric-engine only.',
    },
  },
  cohort_retention: {
    v1: {
      metricId: 'cohort_retention' as const,
      version: 'v1' as const,
      readSeam: 'gold_cohorts' as const,
      recognitionLabels: [] as const,
      toleranceMinor: 0 as const,
      description:
        'Cohort retention curve = per-acquisition-cohort (first-seen month) customer counts + their ' +
        'lifetime orders/value, from the Gold mart gold_cohorts. Retention RATIOS are derived ' +
        'NON-ADDITIVELY at read (ADR-004); Gold holds only the additive cohort components. Integer ' +
        'basis-point math (no float). A deterministic count fold, not a recognition fact. Read through ' +
        'withSilverBrand (I-ST01 sole reader). Sole emitter: metric-engine only.',
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
