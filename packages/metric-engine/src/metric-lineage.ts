// SPEC:C.5.1
/**
 * @brain/metric-engine — computeMetricLineage (Wave C · C.5.1)
 *
 * The machine-readable measurement-lineage seam. For an executive/measurement metric it returns the
 * MEASUREMENT fact tables that metric derives from, each with a live row count (brand + as-of scoped)
 * and the producing job version(s) — the auditor's proof that "every executive metric traces to
 * Measurement facts" (§C.5.1). NO metric NUMBERS are produced here; this is a provenance descriptor,
 * not a compute path.
 *
 * ── ISOLATION (§0.5 / §1.9-6) ─────────────────────────────────────────────────────────────────────
 * Every count/version read runs through withSilverBrand (the ${BRAND_PREDICATE} Trino seam), so the
 * lineage of brand A can never count brand B's rows. The as-of date is regex-validated (YYYY-MM-DD)
 * and inlined as a Trino DATE literal — brand isolation stays on the parameterized seam.
 *
 * ── MONEY / FACTS ──────────────────────────────────────────────────────────────────────────────────
 * The referenced facts are the Wave-C measurement namespace (AMD-16) + the recognition ledger + the
 * new per-order economics (AMD-17). Absent facts (honest-empty dev/golden) degrade to row_count 0 via
 * withSilverBrand's table-not-found → [] degradation — never a 500.
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

// ── Fact descriptors (the measurement provenance registry) ──────────────────────────────────────────

type FactSchema = 'brain_gold' | 'brain_silver';

interface FactDescriptor {
  readonly schema: FactSchema;
  readonly table: string;
  /** The recognition/economic date column filtered `<= as_of` (CAST to date). null → no date filter. */
  readonly dateColumn: string | null;
  /** A per-row job_version column (real, distinct-read) or null (fall back to the producer constant). */
  readonly jobVersionColumn: string | null;
  /** Documented producing Spark job version when no per-row column exists. */
  readonly producerVersion: string;
  /** What this fact contributes to the metric. */
  readonly role: string;
  /**
   * Optional extra row predicate ANDed into the count/version reads — used when a metric consumes
   * only a slice of the physical fact (e.g. GAP-C: spend readers pin level = 'campaign'), so the
   * audited row_count matches the rows the metric actually derives from.
   */
  readonly predicate?: string;
}

/** The measurement fact registry — one entry per physical Iceberg fact table. */
const FACTS = {
  revenue_ledger: {
    schema: 'brain_gold', table: 'gold_revenue_ledger', dateColumn: 'economic_effective_at',
    jobVersionColumn: null, producerVersion: 'gold_revenue.py',
    role: 'revenue recognition + reversal (net/RTO/refund/clawback) — money SoR',
  },
  order_economics: {
    schema: 'brain_gold', table: 'gold_order_economics', dateColumn: 'order_recognized_at',
    jobVersionColumn: 'job_version', producerVersion: 'c3.economics.v1',
    role: 'per-order CM1/CM2/CM3 + is_new_customer + economics_state (AMD-17)',
  },
  product_economics: {
    schema: 'brain_gold', table: 'gold_product_economics', dateColumn: 'econ_date',
    jobVersionColumn: 'job_version', producerVersion: 'c3.product_economics.v1',
    role: 'daily per-product economics rollup',
  },
  refunds: {
    schema: 'brain_gold', table: 'gold_measurement_refunds', dateColumn: 'occurred_at',
    jobVersionColumn: null, producerVersion: 'gold_measurement_refunds.py',
    role: 'refund/return/RTO value reversal to customer (reason_code taxonomy)',
  },
  settlements: {
    schema: 'brain_gold', table: 'gold_measurement_settlements', dateColumn: 'occurred_at',
    jobVersionColumn: null, producerVersion: 'gold_measurement_settlements.py',
    role: 'gateway settlements (gross/fees/net) reconciled vs ledger recognition',
  },
  fees: {
    schema: 'brain_gold', table: 'gold_measurement_fees', dateColumn: 'occurred_at',
    jobVersionColumn: null, producerVersion: 'gold_measurement_fees.py',
    role: 'per-order payment/platform/checkout fees',
  },
  costs: {
    schema: 'brain_gold', table: 'gold_measurement_costs', dateColumn: 'occurred_at',
    jobVersionColumn: null, producerVersion: 'gold_measurement_costs.py',
    role: 'shipping forward + reverse-logistics (RTO) + packaging + COGS',
  },
  spend: {
    schema: 'brain_silver', table: 'silver_marketing_spend', dateColumn: 'stat_date',
    jobVersionColumn: null, producerVersion: 'silver_marketing_spend.py',
    role: 'day×channel×campaign ad spend (gold_measurement_spend alias, AMD-16)',
    // GAP-C: the spend fact carries the SAME money at 'campaign', 'adset' AND 'ad' levels
    // (children roll up to their campaign). Every spend-consuming metric pins the canonical
    // top-of-hierarchy 'campaign' level (mirrors gold_cac.py), so the audited row_count must too.
    predicate: `level = 'campaign'`,
  },
  product_costs: {
    schema: 'brain_gold', table: 'gold_product_costs', dateColumn: 'valid_from',
    jobVersionColumn: null, producerVersion: 'gold_product_costs.py',
    role: 'per-SKU COGS dimension (brand cost sheet + rate config)',
  },
} as const satisfies Record<string, FactDescriptor>;

type FactKey = keyof typeof FACTS;

// ── Metric → measurement facts map (executive/measurement metrics) ───────────────────────────────────

/**
 * MEASUREMENT_LINEAGE — the executive/measurement metrics whose provenance is auditable, each mapped to
 * the ordered measurement facts it derives from. Every entry is non-empty → every listed metric
 * provably traces to Measurement facts (§C.5.1). Keys are the canonical metric ids for the lineage
 * endpoint (a superset of the compute-registry ids to cover the new C.3 economics metrics).
 */
export const MEASUREMENT_LINEAGE = {
  realized_revenue: { description: 'Realized GMV — finalized recognition rows.', facts: ['revenue_ledger'] },
  provisional_revenue: { description: 'Provisional GMV — booked, pre-finalization.', facts: ['revenue_ledger'] },
  ad_spend: { description: 'Ad spend (day×channel×campaign).', facts: ['spend'] },
  blended_roas: { description: 'Blended ROAS = realized revenue ÷ ad spend.', facts: ['revenue_ledger', 'spend'] },
  cac: { description: 'CAC = acquisition spend ÷ new customers.', facts: ['spend', 'order_economics'] },
  refund_amount: { description: 'Refund/return/RTO value reversed to customers.', facts: ['refunds'] },
  rto_rate: { description: 'RTO rate — reversed vs recognized orders.', facts: ['refunds', 'revenue_ledger'] },
  cm1: { description: 'CM1 = net revenue − COGS.', facts: ['order_economics', 'revenue_ledger', 'product_costs', 'costs'] },
  cm2: { description: 'CM2 = CM1 − shipping − packaging − fees.', facts: ['order_economics', 'revenue_ledger', 'product_costs', 'costs', 'fees'] },
  cm3: { description: 'CM3 = CM2 − allocated marketing spend.', facts: ['order_economics', 'revenue_ledger', 'product_costs', 'costs', 'fees', 'spend'] },
  order_economics: { description: 'Per-order contribution-margin waterfall.', facts: ['order_economics', 'revenue_ledger', 'product_costs', 'costs', 'fees', 'spend'] },
  product_economics: { description: 'Daily per-product economics rollup.', facts: ['product_economics', 'order_economics'] },
  settlement_summary: { description: 'Settlement gross/fees/net reconciled to the ledger.', facts: ['settlements', 'revenue_ledger'] },
} as const satisfies Record<string, { description: string; facts: readonly FactKey[] }>;

export type LineageMetricId = keyof typeof MEASUREMENT_LINEAGE;

/** True iff `metric` is a lineage-supported metric id. */
export function isLineageMetric(metric: string): metric is LineageMetricId {
  return Object.prototype.hasOwnProperty.call(MEASUREMENT_LINEAGE, metric);
}

/** The sorted list of every lineage-supported metric id (catalog surface). */
export function listLineageMetrics(): LineageMetricId[] {
  return (Object.keys(MEASUREMENT_LINEAGE) as LineageMetricId[]).sort();
}

// ── Output shape (machine-readable audit) ────────────────────────────────────────────────────────────

export interface FactLineage {
  readonly catalog: 'iceberg';
  readonly schema: FactSchema;
  readonly table: string;
  /** Fully-qualified `iceberg.<schema>.<table>`. */
  readonly fqtn: string;
  readonly role: string;
  /** The as-of date column applied (or null when the fact is not date-scoped). */
  readonly date_column: string | null;
  /** Live row count for this brand, filtered `<= date` when a date is given. */
  readonly row_count: number;
  /** Distinct producing job version(s). */
  readonly job_versions: string[];
  /** 'column' = read from a per-row job_version column; 'producer' = the documented job constant. */
  readonly job_version_source: 'column' | 'producer';
}

export interface MetricLineage {
  readonly metric: LineageMetricId;
  readonly description: string;
  /** The as-of date (YYYY-MM-DD) the counts are computed at, or null for all-time. */
  readonly date: string | null;
  readonly facts: FactLineage[];
  /** Always true here — every supported metric maps to ≥1 measurement fact (§C.5.1). */
  readonly traces_to_measurement: boolean;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function numFrom(rows: Array<Record<string, unknown>>, col: string): number {
  const v = rows.length > 0 ? rows[0]?.[col] : 0;
  return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}

/**
 * computeMetricLineage — the C.5.1 provenance read.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param metric  - A lineage-supported metric id (validate with isLineageMetric first).
 * @param date    - Optional as-of date (YYYY-MM-DD, regex-validated). Absent → all-time counts.
 * @param deps    - { srPool } — the Trino serving pool (withSilverBrand seam).
 */
export async function computeMetricLineage(
  brandId: string,
  metric: LineageMetricId,
  date: string | null,
  deps: { srPool: SilverPool },
): Promise<MetricLineage> {
  if (date !== null && !ISO_DATE_RE.test(date)) {
    throw new Error(`invalid as-of date "${date}" (expected YYYY-MM-DD)`);
  }
  const spec = MEASUREMENT_LINEAGE[metric];

  const facts = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const out: FactLineage[] = [];
    for (const key of spec.facts) {
      const f = FACTS[key];
      const fqtn = `iceberg.${f.schema}.${f.table}`;
      const dateFilter =
        date !== null && f.dateColumn !== null
          ? ` AND CAST(${f.dateColumn} AS date) <= DATE '${date}'`
          : '';
      // Slice predicate (GAP-C level pin on the spend fact) — count only the rows the metric consumes.
      const slice = 'predicate' in f && f.predicate ? ` AND ${f.predicate}` : '';

      // Row count — brand-scoped; honest-empty (missing table) degrades to [] → 0.
      const countRows = await scope.runScoped<Record<string, unknown>>(
        `SELECT count(*) AS c FROM ${fqtn} WHERE ${BRAND_PREDICATE}${dateFilter}${slice}`,
      );
      const rowCount = numFrom(countRows, 'c');

      // Job version(s): real per-row column when present, else the documented producer constant.
      let jobVersions: string[];
      let source: 'column' | 'producer';
      if (f.jobVersionColumn !== null) {
        const vs = await scope.runScoped<Record<string, unknown>>(
          `SELECT DISTINCT ${f.jobVersionColumn} AS v FROM ${fqtn} WHERE ${BRAND_PREDICATE}`,
        );
        const parsed = vs.map((r) => String(r.v)).filter((v) => v && v !== 'null');
        // A row-count>0 table always yields ≥1 version; an empty/absent table falls back to the constant.
        jobVersions = parsed.length > 0 ? parsed.sort() : [f.producerVersion];
        source = parsed.length > 0 ? 'column' : 'producer';
      } else {
        jobVersions = [f.producerVersion];
        source = 'producer';
      }

      out.push({
        catalog: 'iceberg',
        schema: f.schema,
        table: f.table,
        fqtn,
        role: f.role,
        date_column: f.dateColumn,
        row_count: rowCount,
        job_versions: jobVersions,
        job_version_source: source,
      });
    }
    return out;
  });

  return {
    metric,
    description: spec.description,
    date,
    facts,
    traces_to_measurement: facts.length > 0,
  };
}
