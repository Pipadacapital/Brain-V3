/**
 * getMedallionJourney — the V4 "medallion journey" pipeline-observability surface (Bronze → Silver →
 * Identity/Neo4j → Gold → Serving), computed from CHEAP METADATA ONLY.
 *
 * WHAT it answers: "what is the state of the WHOLE data pipeline right now?" — for each medallion tier,
 * does it have data (row counts), how fresh is it (max(ts)), and a text health verdict. This is the
 * operator/ops read the data-health surface renders as a single pipeline strip.
 *
 * CHEAP-METADATA DOCTRINE (the serving node 504s on heavy queries under load — NEVER full-scan):
 *   • FRESHNESS + STATE come from the tiny silver_job_watermark side-table (one row per transform JOB,
 *     both silver AND gold jobs write to it) — read ONCE, cheaply, no WHERE. This is metadata-cheap and
 *     never full-scans; `max(<ts>)` used to be the expensive part (a full column scan on 5.2M-row Bronze
 *     / fragmented Silver-Gold marts under compaction) that raced the 4s timeout → null → false 'no_data'.
 *   • row counts are BEST-EFFORT only (`count(*)` — DuckDB answers cheaply from manifest stats) and
 *     NEVER gate a tier's state: a timed-out count degrades to null ("—") while the tier keeps its real
 *     fresh/stale state from the watermark.
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

/** The serving views (over Silver Iceberg marts) that carry the per-tier signals we read. */
const SILVER_KEYSTONE_VIEW = 'mv_silver_collector_event';
const SILVER_ORDER_STATE_VIEW = 'mv_silver_order_state';
const SILVER_MARKETING_SPEND_VIEW = 'mv_silver_marketing_spend';
/**
 * The tiny watermark side-table (iceberg.brain_silver.silver_job_watermark) carries one row per
 * transform JOB — both silver AND gold jobs write to it via write_watermark. FRESHNESS + STATE for
 * every tier are derived from these rows (metadata-cheap), NOT from a max(<ts>) full-column scan.
 * The job_name strings below are the exact `run_job("<job>", …)` names from the transform tree
 * (grepped from db/iceberg/duckdb/{silver,gold}/*.py).
 */
/** Keystone job (silver_collector_event.py). Its watermark tracks the Bronze arrival clock
 * (kafka_timestamp on collector_events_connect) — so it is ALSO the Bronze tier's freshness source. */
const SILVER_WATERMARK_JOB = 'silver-collector-event';
/** silver_order_state.py — the Silver order-state tier's freshness. */
const SILVER_ORDER_STATE_JOB = 'silver-order-state';
/** silver_marketing_spend.py — the Silver ad-spend tier's freshness. */
const SILVER_MARKETING_SPEND_JOB = 'silver-marketing-spend';
/** gold_customer_360.py — the Gold customer_360 tier's freshness. */
const GOLD_CUSTOMER_360_JOB = 'gold-customer-360';
/** Prefix common to every gold-* job row; Gold/Serving freshness = max last_ingested_at across them
 * (represents "gold is producing"). */
const GOLD_JOB_PREFIX = 'gold-';
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
 * Derive a tier's text verdict from its WATERMARK freshness (the metadata-cheap source; row count is
 * best-effort and does NOT gate state): no watermark row for the job → the job genuinely never ran →
 * 'no_data'; freshness within the SLA → 'fresh'; else 'stale'.
 */
function deriveState(
  freshnessAt: string | null,
  now: number,
): MedallionStageHealth['state'] {
  if (freshnessAt == null) return 'no_data'; // no watermark row → the job never ran
  const t = new Date(freshnessAt).getTime();
  if (Number.isNaN(t)) return 'no_data';
  const ageMs = now - t;
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

/**
 * BEST-EFFORT count-only probe. `count(*)` alone is far cheaper than the old `count(*), max(<ts>)`
 * (the max was a full column scan that raced the 4s timeout on big/fragmented tables). This NEVER
 * gates a tier's state — on timeout/failure it returns a null count and the tier keeps its real
 * watermark-derived freshness/state (rendered as "—" instead of "No data").
 */
async function probeCount(srPool: SilverPool, schemaQualified: string): Promise<number | null> {
  try {
    const rows = await srPool.query<{ row_count: string | number | null }>(
      `SELECT CAST(count(*) AS varchar) AS row_count FROM ${schemaQualified}`,
      [],
    );
    return toNumOrNull(rows?.[0]?.row_count ?? null);
  } catch {
    // Count momentarily unavailable → null count, state unaffected (comes from the watermark).
    return null;
  }
}

/** Race a serving probe against a short timeout so a loaded node can't hang the endpoint. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** A tier's watermark freshness (ISO) mapped by transform job_name. */
interface WatermarkEntry {
  lastIngestedAt: string | null;
  updatedAt: string | null;
}
type WatermarkMap = Map<string, WatermarkEntry>;

/**
 * Read the ENTIRE silver_job_watermark side-table ONCE (no WHERE — it's tiny, one row per transform
 * job) → Map<job_name, {lastIngestedAt, updatedAt}>. This is the metadata-cheap freshness source for
 * every tier. Fail-soft to an empty map on error/timeout (each tier then reads 'no_data' honestly).
 */
async function readWatermarks(srPool: SilverPool): Promise<WatermarkMap> {
  try {
    const rows = await srPool.query<{
      job_name: string | null;
      last_ingested_at: string | null;
      updated_at: string | null;
    }>(
      `SELECT job_name, CAST(last_ingested_at AS varchar) AS last_ingested_at, ` +
        `CAST(updated_at AS varchar) AS updated_at FROM iceberg.brain_silver.silver_job_watermark`,
      [],
    );
    const map: WatermarkMap = new Map();
    for (const r of rows ?? []) {
      if (r?.job_name == null) continue;
      map.set(r.job_name, {
        lastIngestedAt: toIso(r.last_ingested_at ?? null),
        updatedAt: toIso(r.updated_at ?? null),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Freshness (ISO) of one job from the watermark map, or null if the job never ran. */
function wmFreshness(wm: WatermarkMap, jobName: string): string | null {
  return wm.get(jobName)?.lastIngestedAt ?? null;
}

/** Max last_ingested_at across every job_name starting with a prefix (e.g. all gold-* jobs). */
function wmMaxFreshnessByPrefix(wm: WatermarkMap, prefix: string): string | null {
  let best: number | null = null;
  let bestIso: string | null = null;
  for (const [job, entry] of wm) {
    if (!job.startsWith(prefix) || entry.lastIngestedAt == null) continue;
    const t = new Date(entry.lastIngestedAt).getTime();
    if (Number.isNaN(t)) continue;
    if (best == null || t > best) {
      best = t;
      bestIso = entry.lastIngestedAt;
    }
  }
  return bestIso;
}

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

  // ── WATERMARKS: read the tiny silver_job_watermark side-table ONCE (metadata-cheap). Every tier's
  //    freshness + state derive from this map — NOT from a max(<ts>) full-column scan. Fail-soft → {}. ──
  const wmP: Promise<WatermarkMap> = sr
    ? withTimeout(readWatermarks(sr), SERVING_QUERY_TIMEOUT_MS, new Map() as WatermarkMap)
    : Promise.resolve(new Map() as WatermarkMap);

  // ── BRONZE: freshness/state from the KEYSTONE watermark (it tracks the Bronze kafka_timestamp arrival
  //    clock); row count is a best-effort count-only probe that never gates the state. ──
  const bronzeP = (async (): Promise<MedallionJourney['bronze']> => {
    const wm = await wmP;
    const freshnessAt = wmFreshness(wm, SILVER_WATERMARK_JOB);
    const rowCount = sr
      ? await withTimeout(
          probeCount(sr, `iceberg.brain_bronze.${BRONZE_TABLE}`),
          SERVING_QUERY_TIMEOUT_MS,
          null,
        )
      : null;
    return {
      table: BRONZE_TABLE,
      rowCount,
      latestEventAt: freshnessAt,
      state: deriveState(freshnessAt, now),
    };
  })();

  // ── SILVER: freshness/state per mart from the watermark map (keystone/order-state/marketing-spend
  //    jobs); row counts are best-effort count-only probes that never gate state. ──
  const silverP = (async (): Promise<MedallionJourney['silver']> => {
    const wm = await wmP;
    const keystoneFresh = wmFreshness(wm, SILVER_WATERMARK_JOB);
    const orderStateFresh = wmFreshness(wm, SILVER_ORDER_STATE_JOB);
    const marketingSpendFresh = wmFreshness(wm, SILVER_MARKETING_SPEND_JOB);

    const [keystoneCount, orderStateCount, marketingSpendCount] = await Promise.all([
      sr
        ? withTimeout(probeCount(sr, `brain_serving."${SILVER_KEYSTONE_VIEW}"`), SERVING_QUERY_TIMEOUT_MS, null)
        : Promise.resolve<number | null>(null),
      sr
        ? withTimeout(probeCount(sr, `brain_serving."${SILVER_ORDER_STATE_VIEW}"`), SERVING_QUERY_TIMEOUT_MS, null)
        : Promise.resolve<number | null>(null),
      sr
        ? withTimeout(probeCount(sr, `brain_serving."${SILVER_MARKETING_SPEND_VIEW}"`), SERVING_QUERY_TIMEOUT_MS, null)
        : Promise.resolve<number | null>(null),
    ]);

    const keystone = { rowCount: keystoneCount, freshnessAt: keystoneFresh };
    const orderState = { rowCount: orderStateCount, freshnessAt: orderStateFresh };
    const marketingSpend = { rowCount: marketingSpendCount, freshnessAt: marketingSpendFresh };

    // The reported watermark stays the keystone job's (unchanged contract field).
    const wmRow = keystoneFresh;
    const lagSeconds =
      wmRow == null ? null : Math.max(0, Math.round((now - new Date(wmRow).getTime()) / 1000));

    // Tier verdict: worst-of the three Silver marts' watermark-derived verdicts.
    const state = worstOf([
      deriveState(keystone.freshnessAt, now),
      deriveState(orderState.freshnessAt, now),
      deriveState(marketingSpend.freshnessAt, now),
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

  const [bronze, silver, identity, servingFreshness, wm] = await Promise.all([
    bronzeP,
    silverP,
    identityP,
    servingFreshnessP,
    wmP,
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

  // Gold/Serving freshness+state come from the gold-* watermarks (NOT the per-mart max(ts) scan):
  //   • customer_360 → the gold-customer-360 job watermark.
  //   • the Gold tier as a whole ("gold is producing") → max last_ingested_at across all gold-* jobs.
  const gold: MedallionJourney['gold'] = {
    customer360,
    biMarts,
    state: deriveState(wmFreshness(wm, GOLD_CUSTOMER_360_JOB), now),
  };

  // Serving tier: the full per-mart set (all mv_*, verbatim from getServingFreshness) for counts; the
  // tier verdict tracks "gold is producing" via the max gold-* watermark (metadata-cheap, no scan).
  const serving: MedallionJourney['serving'] = {
    marts: allMarts.map((m) => ({
      view: m.mv,
      rowCount: toNumOrNull(m.rows),
      freshnessAt: m.lastRefreshAt,
      state: m.freshness,
    })),
    state: deriveState(wmMaxFreshnessByPrefix(wm, GOLD_JOB_PREFIX), now),
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
