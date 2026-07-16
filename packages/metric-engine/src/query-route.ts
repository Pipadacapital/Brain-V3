/**
 * @brain/metric-engine — QueryRoute enum + routing helpers.
 *
 * ── ROUTING RULES (INVARIANTS) ────────────────────────────────────────────────
 *
 * 1. Known registered metrics ALWAYS go to brain_serving.mv_* (duckdb-serving views over Iceberg).
 *    routeKnownMetric() NEVER returns duckdb_adhoc. The return type enforces this.
 *
 * 2. On a cache miss, a known metric goes to the duckdb-serving SERVING views — NOT to
 *    ad-hoc serving SQL. Ad-hoc is additive, read-only, operator/explicit exploration only.
 *
 * 3. AI/model-originated SQL → serving engine is DISABLED (routeAiAdHocServing throws
 *    NotImplementedYet). The seam is registered, not silently hidden, so any
 *    future attempt to enable it is an intentional, reviewed change.
 *
 * ── SERVING HIERARCHY ────────────────────────────────────────────────────────
 *
 *   cache_hit           → serve from AnalyticsCachePort (Redis)
 *   duckdb_serving      → query brain_serving.mv_* (duckdb-serving views over Iceberg)
 *   duckdb_adhoc        → OPERATOR ONLY; never for known metrics; never for AI/model
 *
 * ── COST ROUTING ALIGNMENT ───────────────────────────────────────────────────
 * Tier: Deterministic (Tier 0 — zero model calls, zero tokens).
 * Known metrics are pre-materialized (Iceberg Gold marts behind duckdb-serving views) or cached — no model call on
 * any hot path. Ad-hoc serving SQL is a compute-cost path, gated to operator use.
 */

// ── QueryRoute ─────────────────────────────────────────────────────────────────

/**
 * The three possible routes for an analytics query.
 *
 * - cache_hit         Fast path: value already in AnalyticsCachePort.
 * - duckdb_serving    Cache miss on a KNOWN metric: read the brain_serving.mv_* duckdb-serving views.
 *                     (Renamed from `trino_serving` — engine-neutral rename, ADR-0014 Trino
 *                     removal; the value was never persisted, so the rename is clean.)
 * - duckdb_adhoc      Additive, READ-ONLY, OPERATOR/EXPLICIT ONLY. NEVER returned by
 *                     routeKnownMetric. AI/model queries via this route throw NotImplementedYet.
 */
export enum QueryRoute {
  cache_hit = 'cache_hit',
  duckdb_serving = 'duckdb_serving',
  /**
   * Ad-hoc Iceberg exploration via duckdb-serving.
   * ADDITIVE and READ-ONLY — registered in the enum so code references are
   * tracked, but NEVER a valid outcome of routeKnownMetric. AI/model code paths
   * that attempt this route hit routeAiAdHocServing which throws NotImplementedYet.
   */
  duckdb_adhoc = 'duckdb_adhoc',
}

/** The ONLY routes a known registered metric may take (excludes duckdb_adhoc by design). */
export type KnownMetricRoute = QueryRoute.cache_hit | QueryRoute.duckdb_serving;

// ── Routing helpers ───────────────────────────────────────────────────────────

/**
 * Route a KNOWN registered metric query.
 *
 * INVARIANT: returns ONLY cache_hit or duckdb_serving — NEVER duckdb_adhoc.
 * The return type (KnownMetricRoute) enforces this at compile time.
 *
 * Rule: cache hit → cache_hit; cache miss → duckdb_serving (brain_serving.mv_*).
 * A cache miss on a known metric goes to the SERVING views, NOT to ad-hoc SQL.
 * Ad-hoc is for operator-initiated exploration, not for serving registered metrics.
 *
 * @param cacheHit - True if the AnalyticsCachePort returned a valid cached value.
 */
export function routeKnownMetric(cacheHit: boolean): KnownMetricRoute {
  return cacheHit ? QueryRoute.cache_hit : QueryRoute.duckdb_serving;
}

// ── AI-ad-hoc-serving DISABLED seam ──────────────────────────────────────────

/**
 * Error thrown by the AI-ad-hoc-serving DISABLED seam.
 * Registered as NotImplementedYet (not silently hidden, never faked) so any
 * future decision to enable AI → serving SQL is a deliberate, code-reviewed change.
 */
export class NotImplementedYet extends Error {
  constructor(
    message = 'AI-ad-hoc-serving path is DISABLED (registered NotImplementedYet).',
  ) {
    super(message);
    this.name = 'NotImplementedYet';
    // Restore prototype chain for instanceof checks across transpile boundaries.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * AI-ad-hoc-serving DISABLED seam.
 *
 * Any code path that attempts to route a model/AI-originated query to serving SQL
 * MUST call this function — which unconditionally throws NotImplementedYet.
 * This is intentional: the AI → serving SQL path is disabled by policy, not by
 * absence of implementation. Registering it as NotImplementedYet means:
 *   - It shows up in grep / code search (not silently absent).
 *   - Enabling it requires an explicit, reviewable code change.
 *   - Unit tests prove it always throws (see serving-routing.test.ts).
 *
 * PRIME DIRECTIVE: the brain_serving.mv_* duckdb-serving views are the SOLE
 * app/BFF/metric-engine serving path. Ad-hoc serving SQL is additive, read-only,
 * exploration only. A cache miss on a known metric NEVER routes ad-hoc — it goes
 * to the serving views.
 *
 * @param _query - The SQL string (ignored; accepted so call sites are self-documenting).
 * @throws {NotImplementedYet} — always.
 */
export function routeAiAdHocServing(_query?: string): never {
  throw new NotImplementedYet(
    'AI-ad-hoc-serving path is DISABLED (registered NotImplementedYet). ' +
      'Known metrics must route through duckdb-serving (brain_serving.mv_*) ' +
      'via routeKnownMetric → duckdb_serving. ' +
      'Ad-hoc serving exploration is operator-only — never model/AI-originated SQL.',
  );
}
