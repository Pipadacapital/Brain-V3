/**
 * @brain/metric-engine — Silver/Gold read seam + withSilverBrand helper.
 *
 * ── BRAIN V4: this seam now runs over DUCKDB-SERVING (Iceberg) ─────────────────
 * Brain V4 removed StarRocks, then Trino (ADR-0014), as the serving engine. The
 * medallion (Bronze/Silver/Gold) is Iceberg; serving reads go through the
 * duckdb-serving HTTP service over the SAME Iceberg catalog the transform tier
 * writes. This file is kept as the STABLE seam the ~49 metric-engine
 * callers program against — `withSilverBrand(deps.srPool, brandId, fn)` and the
 * `${BRAND_PREDICATE}` sentinel — so each swap of the underlying engine
 * (StarRocks → Trino → duckdb-serving) is TRANSPARENT to every caller (zero
 * caller-SQL churn).
 *
 * Concretely:
 *   • SilverPool  is now an alias of ServingPool  (the driver-agnostic serving PORT).
 *   • SilverScope is now an alias of ServingScope (runScoped is structurally identical).
 *   • withSilverBrand delegates to withServingBrand (same signature, same brand-
 *     predicate isolation, same __unsafeDisableBrandPredicate mutation seam).
 *   • BRAND_PREDICATE is re-exported from serving-deps (the single shared sentinel).
 *   • The composition root injects a duckdb-serving adapter (createDuckDbServingPool)
 *     as `srPool`.
 *
 * The metric SQL strings are UNCHANGED — they read `FROM brain_serving.mv_*`. In
 * Brain V4 those `mv_*` are thin DuckDB VIEWS over Iceberg Gold/Silver (see
 * db/iceberg/duckdb/views/*.sql), applied into each replica's LOCAL brain_serving
 * schema; the Iceberg REST catalog is attached as `iceberg`, so the views' 3-part
 * `iceberg.brain_gold.*` refs resolve while the 2-part name `brain_serving.mv_x`
 * resolves to the local view.
 *
 * ── PER-BRAND ISOLATION (unchanged contract) ───────────────────────────────────
 *   1. The caller's WHERE clause MUST end with the `${BRAND_PREDICATE}` sentinel.
 *   2. runScoped replaces the sentinel with `brand_id = ?` (parameterized to brandId).
 *   3. A missing sentinel THROWS (fail-closed) — never runs an un-scoped (cross-brand)
 *      query. The `__unsafeDisableBrandPredicate` test flag strips the predicate to
 *      `1 = 1` for the isolation-fuzz mutation proof. Never set in application code.
 *   4. HONEST-EMPTY degradation: a "table/schema does not exist" error (a
 *      fresh/dev env where the Iceberg Gold/Silver marts or the brain_serving views
 *      are not yet provisioned) degrades the read to `[]` with a WARN, so the
 *      dashboard renders its no_data state instead of a 500. Only the
 *      table/schema-not-found class is swallowed; any real query error propagates.
 *
 * Like Trino before it, duckdb-serving has no session-variable row policy over its
 * HTTP API; the SQL predicate injection IS the load-bearing isolation (proven by
 * the isolation-fuzz mutation test).
 *
 * @see packages/metric-engine/src/serving-deps.ts           — the serving seam this delegates to
 * @see packages/metric-engine/src/duckdb-serving-adapter.ts — the concrete HTTP adapter (createDuckDbServingPool)
 * @see packages/metric-engine/src/deps.ts                   — the Postgres sibling (withBrandTxn)
 * @see db/iceberg/duckdb/views/*.sql                        — the brain_serving.mv_* DuckDB views over Iceberg
 */

import {
  BRAND_PREDICATE,
  withServingBrand,
  type ServingPool,
  type ServingScope,
  type WithServingBrandOptions,
} from './serving-deps.js';

// Re-export the ONE shared sentinel so the ~41 caller files that import it from
// './silver-deps.js' stay UNCHANGED (the sentinel is owned by serving-deps now).
export { BRAND_PREDICATE };

/**
 * The Silver/Gold read pool. In Brain V4 this IS the serving query PORT — the
 * composition root injects a duckdb-serving adapter (createDuckDbServingPool).
 * Kept as a named alias so the ~49 callers' `SilverPool` / `SilverDeps.srPool`
 * types are unchanged.
 */
export type SilverPool = ServingPool;

export interface SilverDeps {
  /** The Silver/Gold serving pool — a duckdb-serving adapter (createDuckDbServingPool) in Brain V4. */
  readonly srPool: SilverPool;
}

/**
 * A scoped reader passed to the seam callback. The ONLY way to read Silver/Gold.
 * Structurally identical to ServingScope (runScoped with the brand predicate injected).
 */
export type SilverScope = ServingScope;

/** Options for withSilverBrand (test-only predicate-disable mutation seam). */
export type WithSilverBrandOptions = WithServingBrandOptions;

function silverErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when an error means the Silver/Gold serving tier is not available — the
 * Iceberg schema or a serving view/table doesn't exist (fresh/dev env not yet
 * provisioned), or a transient outage surfaced as not-found. runScoped only ever
 * issues serving queries, so a "does not exist / not found" here is always the tier.
 *
 * Matches DUCKDB error strings (DuckDB phrases missing relations as
 * "Catalog Error: Table with name mv_x does not exist!" / "... Schema with name
 * brain_serving does not exist"). The Trino phrases ("Table '...' does not exist",
 * "Schema '...' does not exist" — same substrings) and the legacy StarRocks phrases
 * ("unknown table/database") are retained so any mixed-engine transition window
 * still degrades gracefully.
 *
 * EXPORTED so job-level callers (e.g. apps/core jobs/attribution-reconcile) classify
 * per-brand failures with the SAME phrase list this seam degrades on: errors that
 * escape the seam via a DIRECT srPool.query (the @brain/attribution-writer read-backs
 * bypass withSilverBrand) are still "serving tier not provisioned yet" — an honest
 * empty state (exit 0), NOT a real error (exit 1). One definition, two consumers.
 */
export function isServingTierUnavailable(err: unknown): boolean {
  const msg = silverErrMessage(err).toLowerCase();
  return (
    msg.includes('does not exist') || // DuckDB/Trino: table/schema does not exist
    msg.includes('not found') || // Iceberg REST: schema/namespace not found
    msg.includes('unknown table') || // legacy StarRocks
    msg.includes('unknown database') // legacy StarRocks
  );
}

/**
 * withSilverBrand — runs `fn` with a brand-scoped Silver/Gold reader over duckdb-serving.
 *
 * Delegates to withServingBrand (same brand-predicate isolation + fail-closed throw +
 * __unsafeDisableBrandPredicate mutation seam), then wraps the scope's `runScoped`
 * with the HONEST-EMPTY degradation: a "table/schema does not exist" error becomes
 * `[]` (+ WARN) so a fresh/dev env returns no_data instead of a 500.
 *
 * @param srPool  - The serving pool (createDuckDbServingPool), injected at the root.
 * @param brandId - The brand UUID (from session — D-1; NEVER request body).
 * @param fn      - Async fn receiving the brand-scoped reader.
 * @param opts    - Test-only options (predicate-disable for the mutation proof).
 */
export async function withSilverBrand<T>(
  srPool: SilverPool,
  brandId: string,
  fn: (scope: SilverScope) => Promise<T>,
  opts: WithSilverBrandOptions = {},
): Promise<T> {
  return withServingBrand(
    srPool,
    brandId,
    (servingScope) => {
      // Wrap runScoped to add the StarRocks-era honest-empty degradation. The
      // fail-closed sentinel check + brand-predicate injection happen INSIDE
      // servingScope.runScoped (in withServingBrand) — a missing-sentinel throw is NOT
      // a tier-unavailable error, so it still propagates (fail-closed preserved).
      const scope: SilverScope = {
        async runScoped<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
          try {
            return await servingScope.runScoped<R>(sql, params);
          } catch (err) {
            if (isServingTierUnavailable(err)) {
              console.warn(
                `[metric-engine] Silver/Gold read degraded to empty — serving tier unavailable: ${silverErrMessage(err)}`,
              );
              return [] as R[];
            }
            throw err;
          }
        },
      };
      return fn(scope);
    },
    opts,
  );
}
