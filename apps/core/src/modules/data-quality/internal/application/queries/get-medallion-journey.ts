/**
 * getMedallionJourney — the V4 "medallion journey" pipeline-observability surface (Bronze → Silver →
 * Identity/Neo4j → Gold → Serving), computed from CHEAP METADATA ONLY.
 *
 * WHAT it answers: "what is the state of the WHOLE data pipeline right now?" — for each medallion tier,
 * does it have data (row counts), how fresh is it (max(ts)), and a text health verdict. This is the
 * operator/ops read the data-health surface renders as a single pipeline strip.
 *
 * CHEAP-METADATA DOCTRINE (the serving node 504s on heavy queries under load — NEVER full-scan):
 *   • row counts come from Iceberg metadata (`count(*)` — DuckDB answers from manifest stats, no scan).
 *   • freshness comes from per-file column stats (`max(<ts>)` — no scan).
 *   • the watermark is a tiny side-table read (silver_job_watermark, one row).
 *   • Neo4j counts are `count(n)` / `count(r)` (2-3 cheap graph counts).
 * Every serving query is given a SHORT client timeout so the endpoint stays responsive even when the
 * serving node is loaded; a slow/failed tier degrades to null + an honest state, NEVER a 500.
 *
 * FAIL-SOFT EVERYWHERE: every DuckDB / Neo4j call is individually try/caught. One dead tier yields
 * null counts + an honest state ('no_data' / unreachable) for THAT tier only — it never fails the
 * whole response. There is always a well-formed MedallionJourney.
 *
 * BRAND-AGNOSTIC: pipeline-wide health (like getServingFreshness) — per-tier aggregates across all
 * brands, nothing tenant-bearing. NO money, NO PII — counts + timestamps + table/mart/view names only.
 *
 * REUSE: the Serving + Gold tiers reuse getServingFreshness verbatim (its per-mart count+freshness
 * probe) — this query does NOT duplicate that scan logic; it calls it once and partitions the marts.
 *
 * @see get-serving-freshness.ts — the per-mart freshness+row-count probe reused here.
 */

import type { SilverPool } from '@brain/metric-engine';
import {
  getServingFreshness,
  type ServingFreshnessResult,
  type ServingMartRow,
} from './get-serving-freshness.js';

/** The Iceberg Bronze landing table (Kafka Connect collector sink, ADR-0010). */
const BRONZE_TABLE = 'collector_events_connect';
/** Bronze ingestion-freshness column (the Kafka record timestamp landed on each row). */
const BRONZE_TS_COL = 'kafka_timestamp';

/** The serving views (over Silver Iceberg marts) that carry the per-tier signals we read. */
const SILVER_KEYSTONE_VIEW = 'mv_silver_collector_event';
const SILVER_ORDER_STATE_VIEW = 'mv_silver_order_state';
const SILVER_MARKETING_SPEND_VIEW = 'mv_silver_marketing_spend';
/** The tiny watermark side-table + the keystone job's row in it. */
const SILVER_WATERMARK_JOB = 'silver-collector-event';
/** The Gold 360 mart (partitioned out of the biMarts set below). */
const GOLD_CUSTOMER_360_VIEW = 'mv_gold_customer_360';

/**
 * Staleness SLA (mirrors get-serving-freshness's STALE_AFTER_MINUTES): a tier whose freshness
 * timestamp is older than this reads 'stale'. The v4-refresh-loop re-materializes every ~300s, so a
 * 90m window flags a genuinely-not-converging tier without false-alarming on the refresh cadence.
 */
const STALE_AFTER_MINUTES = 90;

/** Short per-query client timeout (ms) so a loaded serving node can't hang the observability read. */
const SERVING_QUERY_TIMEOUT_MS = 4000;

/** Per-tier text health verdict (text+icon in the UI — never colour-only). */
export interface MedallionStageHealth {
  state: 'fresh' | 'stale' | 'failed' | 'never' | 'no_data';
}

export interface MedallionJourney {
  /** ISO timestamp this surface was computed (so the UI can show "as of"). */
  generatedAt: string;
  bronze: {
    /** The Bronze landing table name. */
    table: string;
    /** Iceberg-metadata row count (null if unreadable). */
    rowCount: number | null;
    /** max(kafka_timestamp) ISO — ingestion freshness (null if empty/unreadable). */
    latestEventAt: string | null;
    state: MedallionStageHealth['state'];
  };
  silver: {
    keystone: { rowCount: number | null; freshnessAt: string | null };
    orderState: { rowCount: number | null; freshnessAt: string | null };
    marketingSpend: { rowCount: number | null; freshnessAt: string | null };
    /** From silver_job_watermark for job_name='silver-collector-event' (tiny side-table read). */
    watermark: { lastIngestedAt: string | null; lagSeconds: number | null };
    state: MedallionStageHealth['state'];
  };
  identity: {
    /** Neo4j reachable? false → the tier is unreachable (all counts null). */
    reachable: boolean;
    /** Distinct canonical brain_ids (Customer node count). */
    brainIds: number | null;
    /** Identifier node count. */
    identifiers: number | null;
    /** IDENTIFIES + ALIAS_OF relationship count (total). */
    edges: number | null;
    state: MedallionStageHealth['state'];
  };
  gold: {
    customer360: { table: string; rowCount: number | null; freshnessAt: string | null };
    /** Every mv_gold_* mart EXCEPT customer_360 (revenue_ledger, attribution, funnel, cac, …). */
    biMarts: Array<{ name: string; rowCount: number | null; freshnessAt: string | null }>;
    state: MedallionStageHealth['state'];
  };
  serving: {
    marts: Array<{ view: string; rowCount: number | null; freshnessAt: string | null; state: string }>;
    state: MedallionStageHealth['state'];
  };
}

/**
 * Neo4j pipeline-counts port — the 2-3 CHEAP graph counts the identity tier reports. Brand-agnostic
 * (pipeline-wide totals; no tenant scope). Injected fail-soft: absent OR throwing → reachable:false.
 * The composition root builds this over the shared neo4j-driver (NEO4J_URI/USER/PASSWORD); tests stub it.
 */
export interface Neo4jPipelineCounts {
  /** Read { brainIds (Customer nodes), identifiers (Identifier nodes), edges (IDENTIFIES+ALIAS_OF) }. */
  readCounts(): Promise<{ brainIds: number; identifiers: number; edges: number }>;
}

export interface MedallionJourneyDeps {
  /** Serving pool (read-only, over Iceberg). Absent → Bronze/Silver/Gold/Serving degrade to no_data. */
  readonly srPool?: SilverPool;
  /** Neo4j pipeline-counts port. Absent/throwing → identity tier reachable:false. */
  readonly neo4jCounts?: Neo4jPipelineCounts;
}

function toIso(v: Date | string | number | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toNumOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive a tier's text verdict from its row count + freshness (mirrors get-serving-freshness's
 * deriveFreshness): unreadable → no_data; no rows → never; freshness within the SLA → fresh; else stale.
 */
function deriveState(
  rowCount: number | null,
  freshnessAt: string | null,
  now: number,
): MedallionStageHealth['state'] {
  if (rowCount == null) return 'no_data'; // couldn't read the tier at all
  if (rowCount === 0) return 'never'; // provisioned but empty
  if (freshnessAt == null) return 'never'; // has rows but no freshness signal
  const ageMs = now - new Date(freshnessAt).getTime();
  return ageMs > STALE_AFTER_MINUTES * 60_000 ? 'stale' : 'fresh';
}

/** Worst-of rollup for a tier composed of several freshness signals. */
const WORST_ORDER: Record<MedallionStageHealth['state'], number> = {
  fresh: 0,
  never: 1,
  no_data: 2,
  stale: 3,
  failed: 4,
};
function worstOf(states: MedallionStageHealth['state'][]): MedallionStageHealth['state'] {
  if (states.length === 0) return 'no_data';
  return states.reduce((worst, s) => (WORST_ORDER[s] > WORST_ORDER[worst] ? s : worst), 'fresh');
}

/** One cheap serving probe (count + max(ts)) wrapped fail-soft → { rowCount, freshnessAt } or nulls. */
async function probeView(
  srPool: SilverPool,
  schemaQualified: string,
  tsCol: string,
): Promise<{ rowCount: number | null; freshnessAt: string | null }> {
  try {
    const rows = await srPool.query<{ row_count: string | number | null; freshness_at: string | null }>(
      `SELECT CAST(count(*) AS varchar) AS row_count, CAST(max(${tsCol}) AS varchar) AS freshness_at ` +
        `FROM ${schemaQualified}`,
      [],
    );
    const r = rows?.[0];
    return { rowCount: toNumOrNull(r?.row_count ?? null), freshnessAt: toIso(r?.freshness_at ?? null) };
  } catch {
    // Tier down / view or Iceberg table absent (fresh env) → honest nulls (never a 500).
    return { rowCount: null, freshnessAt: null };
  }
}

/** Race a serving probe against a short timeout so a loaded node can't hang the endpoint. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const NULL_PROBE = { rowCount: null as number | null, freshnessAt: null as string | null };

/**
 * getMedallionJourney — the whole-pipeline observability read (cheap metadata only, fail-soft).
 *
 * Runs each tier's probes concurrently; any tier's failure degrades only that tier. Always returns a
 * well-formed MedallionJourney (never throws, never a 500).
 */
export async function getMedallionJourney(
  deps: MedallionJourneyDeps,
): Promise<MedallionJourney> {
  const now = Date.now();
  const sr = deps.srPool;

  // ── BRONZE: Iceberg-metadata count + max(kafka_timestamp) on the collector landing table. ──
  const bronzeP = (async (): Promise<MedallionJourney['bronze']> => {
    const probe = sr
      ? await withTimeout(
          probeView(sr, `iceberg.brain_bronze.${BRONZE_TABLE}`, BRONZE_TS_COL),
          SERVING_QUERY_TIMEOUT_MS,
          NULL_PROBE,
        )
      : NULL_PROBE;
    return {
      table: BRONZE_TABLE,
      rowCount: probe.rowCount,
      latestEventAt: probe.freshnessAt,
      state: deriveState(probe.rowCount, probe.freshnessAt, now),
    };
  })();

  // ── SILVER: keystone/order_state/marketing_spend (cheap view probes) + the watermark side-table. ──
  const silverP = (async (): Promise<MedallionJourney['silver']> => {
    const [keystone, orderState, marketingSpend, wmRow] = await Promise.all([
      sr
        ? withTimeout(probeView(sr, `brain_serving."${SILVER_KEYSTONE_VIEW}"`, 'updated_at'), SERVING_QUERY_TIMEOUT_MS, NULL_PROBE)
        : Promise.resolve(NULL_PROBE),
      sr
        ? withTimeout(probeView(sr, `brain_serving."${SILVER_ORDER_STATE_VIEW}"`, 'updated_at'), SERVING_QUERY_TIMEOUT_MS, NULL_PROBE)
        : Promise.resolve(NULL_PROBE),
      sr
        ? withTimeout(probeView(sr, `brain_serving."${SILVER_MARKETING_SPEND_VIEW}"`, 'updated_at'), SERVING_QUERY_TIMEOUT_MS, NULL_PROBE)
        : Promise.resolve(NULL_PROBE),
      // Watermark: tiny side-table, one row. Fail-soft to null.
      (async (): Promise<string | null> => {
        if (!sr) return null;
        try {
          const rows = await withTimeout(
            sr.query<{ last_ingested_at: string | null }>(
              `SELECT CAST(last_ingested_at AS varchar) AS last_ingested_at ` +
                `FROM iceberg.brain_silver.silver_job_watermark WHERE job_name = ?`,
              [SILVER_WATERMARK_JOB],
            ),
            SERVING_QUERY_TIMEOUT_MS,
            [] as Array<{ last_ingested_at: string | null }>,
          );
          return toIso(rows?.[0]?.last_ingested_at ?? null);
        } catch {
          return null;
        }
      })(),
    ]);

    const lagSeconds =
      wmRow == null ? null : Math.max(0, Math.round((now - new Date(wmRow).getTime()) / 1000));

    // Tier verdict: worst-of the three Silver marts' freshness verdicts.
    const state = worstOf([
      deriveState(keystone.rowCount, keystone.freshnessAt, now),
      deriveState(orderState.rowCount, orderState.freshnessAt, now),
      deriveState(marketingSpend.rowCount, marketingSpend.freshnessAt, now),
    ]);

    return {
      keystone,
      orderState,
      marketingSpend,
      watermark: { lastIngestedAt: wmRow, lagSeconds },
      state,
    };
  })();

  // ── IDENTITY: 2-3 cheap Neo4j counts. Absent/throwing driver → reachable:false. ──
  const identityP = (async (): Promise<MedallionJourney['identity']> => {
    if (!deps.neo4jCounts) {
      return { reachable: false, brainIds: null, identifiers: null, edges: null, state: 'no_data' };
    }
    try {
      const c = await deps.neo4jCounts.readCounts();
      const brainIds = toNumOrNull(c.brainIds);
      const state = brainIds == null ? 'no_data' : brainIds === 0 ? 'never' : 'fresh';
      return {
        reachable: true,
        brainIds,
        identifiers: toNumOrNull(c.identifiers),
        edges: toNumOrNull(c.edges),
        state,
      };
    } catch {
      // Neo4j unreachable → honest unreachable tier (never a 500).
      return { reachable: false, brainIds: null, identifiers: null, edges: null, state: 'no_data' };
    }
  })();

  // ── SERVING + GOLD: reuse getServingFreshness's per-mart probe ONCE, then partition. ──
  const servingFreshnessP: Promise<ServingFreshnessResult> = sr
    ? withTimeout(getServingFreshness({ srPool: sr }), SERVING_QUERY_TIMEOUT_MS, { state: 'no_data' })
    : Promise.resolve<ServingFreshnessResult>({ state: 'no_data' });

  const [bronze, silver, identity, servingFreshness] = await Promise.all([
    bronzeP,
    silverP,
    identityP,
    servingFreshnessP,
  ]);

  // Partition getServingFreshness's marts: customer_360 → the Gold 360 mart; other mv_gold_* → biMarts.
  const allMarts: ServingMartRow[] =
    servingFreshness.state === 'has_data' ? servingFreshness.marts : [];

  const c360Row = allMarts.find((m) => m.mv === GOLD_CUSTOMER_360_VIEW);
  const biMarts = allMarts
    .filter((m) => m.mv.startsWith('mv_gold_') && m.mv !== GOLD_CUSTOMER_360_VIEW)
    .map((m) => ({
      name: m.mv,
      rowCount: toNumOrNull(m.rows),
      freshnessAt: m.lastRefreshAt,
    }));

  const customer360 = {
    table: GOLD_CUSTOMER_360_VIEW,
    rowCount: c360Row ? toNumOrNull(c360Row.rows) : null,
    freshnessAt: c360Row?.lastRefreshAt ?? null,
  };

  const gold: MedallionJourney['gold'] = {
    customer360,
    biMarts,
    state: worstOf([
      deriveState(customer360.rowCount, customer360.freshnessAt, now),
      ...biMarts.map((m) => deriveState(m.rowCount, m.freshnessAt, now)),
    ]),
  };

  // Serving tier: the full per-mart set (all mv_*, verbatim from getServingFreshness) + its rollup.
  const serving: MedallionJourney['serving'] = {
    marts: allMarts.map((m) => ({
      view: m.mv,
      rowCount: toNumOrNull(m.rows),
      freshnessAt: m.lastRefreshAt,
      state: m.freshness,
    })),
    state:
      servingFreshness.state === 'has_data' ? servingFreshness.status : ('no_data' as const),
  };

  return {
    generatedAt: new Date(now).toISOString(),
    bronze,
    silver,
    identity,
    gold,
    serving,
  };
}
