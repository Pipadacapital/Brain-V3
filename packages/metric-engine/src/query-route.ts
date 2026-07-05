/**
 * @brain/metric-engine — QueryRoute enum + routing helpers.
 *
 * ── ROUTING RULES (INVARIANTS) ────────────────────────────────────────────────
 *
 * 1. Known registered metrics ALWAYS go to brain_serving.mv_* (Trino views over Iceberg).
 *    routeKnownMetric() NEVER returns trino_adhoc. The return type enforces this.
 *
 * 2. On a cache miss, a known metric goes to the Trino SERVING views — NOT to ad-hoc
 *    Trino. Ad-hoc is additive, read-only, operator/explicit exploration only.
 *
 * 3. AI/model-originated SQL → Trino is DISABLED (routeAiAdHocTrino throws
 *    NotImplementedYet). The seam is registered, not silently hidden, so any
 *    future attempt to enable it is an intentional, reviewed change.
 *
 * ── SERVING HIERARCHY ────────────────────────────────────────────────────────
 *
 *   cache_hit           → serve from AnalyticsCachePort (Redis)
 *   trino_serving       → query brain_serving.mv_* (Trino views over Iceberg)
 *   trino_adhoc         → OPERATOR ONLY; never for known metrics; never for AI/model
 *
 * ── COST ROUTING ALIGNMENT ───────────────────────────────────────────────────
 * Tier: Deterministic (Tier 0 — zero model calls, zero tokens).
 * Known metrics are pre-materialized (Iceberg Gold marts behind Trino views) or cached — no model call on
 * any hot path. Trino ad-hoc is a compute-cost path, gated to operator use.
 */

// ── QueryRoute ─────────────────────────────────────────────────────────────────

/**
 * The three possible routes for an analytics query.
 *
 * - cache_hit         Fast path: value already in AnalyticsCachePort.
 * - trino_serving     Cache miss on a KNOWN metric: read the brain_serving.mv_* Trino views.
 *                     (Renamed from `starrocks_serving` — ADR-0007 naming-debt follow-up;
 *                     the value was never persisted, so the rename is clean.)
 * - trino_adhoc       Additive, READ-ONLY, OPERATOR/EXPLICIT ONLY. NEVER returned by
 *                     routeKnownMetric. AI/model queries via this route throw NotImplementedYet.
 */
export enum QueryRoute {
  cache_hit = 'cache_hit',
  trino_serving = 'trino_serving',
  /**
   * Ad-hoc Iceberg exploration via Trino.
   * ADDITIVE and READ-ONLY — registered in the enum so code references are
   * tracked, but NEVER a valid outcome of routeKnownMetric. AI/model code paths
   * that attempt this route hit routeAiAdHocTrino which throws NotImplementedYet.
   */
  trino_adhoc = 'trino_adhoc',
}

/** The ONLY routes a known registered metric may take (excludes trino_adhoc by design). */
export type KnownMetricRoute = QueryRoute.cache_hit | QueryRoute.trino_serving;

// ── Routing helpers ───────────────────────────────────────────────────────────

/**
 * Route a KNOWN registered metric query.
 *
 * INVARIANT: returns ONLY cache_hit or trino_serving — NEVER trino_adhoc.
 * The return type (KnownMetricRoute) enforces this at compile time.
 *
 * Rule: cache hit → cache_hit; cache miss → trino_serving (brain_serving.mv_*).
 * A cache miss on a known metric goes to the SERVING views, NOT to ad-hoc Trino.
 * Ad-hoc is for operator-initiated exploration, not for serving registered metrics.
 *
 * @param cacheHit - True if the AnalyticsCachePort returned a valid cached value.
 */
export function routeKnownMetric(cacheHit: boolean): KnownMetricRoute {
  return cacheHit ? QueryRoute.cache_hit : QueryRoute.trino_serving;
}

// ── AI-ad-hoc-Trino DISABLED seam ────────────────────────────────────────────

/**
 * Error thrown by the AI-ad-hoc-Trino DISABLED seam.
 * Registered as NotImplementedYet (not silently hidden, never faked) so any
 * future decision to enable AI → Trino is a deliberate, code-reviewed change.
 */
export class NotImplementedYet extends Error {
  constructor(
    message = 'AI-ad-hoc-Trino path is DISABLED (registered NotImplementedYet).',
  ) {
    super(message);
    this.name = 'NotImplementedYet';
    // Restore prototype chain for instanceof checks across transpile boundaries.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * AI-ad-hoc-Trino DISABLED seam.
 *
 * Any code path that attempts to route a model/AI-originated query to Trino SQL
 * MUST call this function — which unconditionally throws NotImplementedYet.
 * This is intentional: the AI → Trino SQL path is disabled by policy, not by
 * absence of implementation. Registering it as NotImplementedYet means:
 *   - It shows up in grep / code search (not silently absent).
 *   - Enabling it requires an explicit, reviewable code change.
 *   - Unit tests prove it always throws (see trino-routing.test.ts).
 *
 * PRIME DIRECTIVE: the brain_serving.mv_* Trino views are the SOLE app/BFF/metric-engine
 * serving path. Ad-hoc Trino is additive, read-only, exploration only. A cache
 * miss on a known metric NEVER routes ad-hoc — it goes to the serving views.
 *
 * @param _query - The SQL string (ignored; accepted so call sites are self-documenting).
 * @throws {NotImplementedYet} — always.
 */
export function routeAiAdHocTrino(_query?: string): never {
  throw new NotImplementedYet(
    'AI-ad-hoc-Trino path is DISABLED (registered NotImplementedYet). ' +
      'Known metrics must route through Trino serving (brain_serving.mv_*) ' +
      'via routeKnownMetric → trino_serving. ' +
      'Ad-hoc Trino exploration is operator-only — never model/AI-originated SQL.',
  );
}
