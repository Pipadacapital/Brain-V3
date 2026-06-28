/**
 * @brain/metric-engine — Silver/Gold read seam + withSilverBrand helper.
 *
 * ── BRAIN V4: this seam now runs over TRINO (Iceberg), not StarRocks ───────────
 * Brain V4 removes StarRocks as the serving engine. The medallion (Bronze/Silver/
 * Gold) is Iceberg; serving reads go through TRINO over the SAME Iceberg catalog
 * that Spark writes. This file is kept as the STABLE seam the ~49 metric-engine
 * callers program against — `withSilverBrand(deps.srPool, brandId, fn)` and the
 * `${BRAND_PREDICATE}` sentinel — so the swap of the underlying engine from
 * StarRocks to Trino is TRANSPARENT to every caller (zero caller-SQL churn).
 *
 * Concretely:
 *   • SilverPool  is now an alias of TrinoPool  (the driver-agnostic Trino PORT).
 *   • SilverScope is now an alias of TrinoScope (runScoped is structurally identical).
 *   • withSilverBrand delegates to withTrinoBrand (same signature, same brand-
 *     predicate isolation, same __unsafeDisableBrandPredicate mutation seam).
 *   • BRAND_PREDICATE is re-exported from trino-deps (the single shared sentinel).
 *   • The composition root injects a Trino adapter (createTrinoPool) as `srPool`.
 *
 * The metric SQL strings are UNCHANGED — they read `FROM brain_serving.mv_*`. In
 * Brain V4 those `mv_*` are thin Trino VIEWS over Iceberg Gold/Silver (see
 * db/trino/views/*.sql); the Trino default catalog is `iceberg`, so the 2-part
 * name `brain_serving.mv_x` resolves to `iceberg.brain_serving.mv_x`.
 *
 * ── PER-BRAND ISOLATION (unchanged contract) ───────────────────────────────────
 *   1. The caller's WHERE clause MUST end with the `${BRAND_PREDICATE}` sentinel.
 *   2. runScoped replaces the sentinel with `brand_id = ?` (parameterized to brandId).
 *   3. A missing sentinel THROWS (fail-closed) — never runs an un-scoped (cross-brand)
 *      query. The `__unsafeDisableBrandPredicate` test flag strips the predicate to
 *      `1 = 1` for the isolation-fuzz mutation proof. Never set in application code.
 *   4. HONEST-EMPTY degradation: a Trino "table/schema does not exist" error (a
 *      fresh/dev env where the Iceberg Gold/Silver marts or the brain_serving views
 *      are not yet provisioned) degrades the read to `[]` with a WARN, so the
 *      dashboard renders its no_data state instead of a 500. Only the
 *      table/schema-not-found class is swallowed; any real query error propagates.
 *
 * Unlike StarRocks there is no session-variable row policy over Trino's REST API;
 * the SQL predicate injection IS the load-bearing isolation (proven by the
 * isolation-fuzz mutation test).
 *
 * @see packages/metric-engine/src/trino-deps.ts    — the Trino seam this delegates to
 * @see packages/metric-engine/src/trino-adapter.ts — the concrete HTTP adapter (createTrinoPool)
 * @see packages/metric-engine/src/deps.ts          — the Postgres sibling (withBrandTxn)
 * @see db/trino/views/*.sql                         — the brain_serving.mv_* Trino views over Iceberg
 */

import {
  BRAND_PREDICATE,
  withTrinoBrand,
  type TrinoPool,
  type TrinoScope,
  type WithTrinoBrandOptions,
} from './trino-deps.js';

// Re-export the ONE shared sentinel so the ~41 caller files that import it from
// './silver-deps.js' stay UNCHANGED (the sentinel is owned by trino-deps now).
export { BRAND_PREDICATE };

/**
 * The Silver/Gold read pool. In Brain V4 this IS the Trino query PORT — the
 * composition root injects a Trino adapter (createTrinoPool). Kept as a named
 * alias so the ~49 callers' `SilverPool` / `SilverDeps.srPool` types are unchanged.
 */
export type SilverPool = TrinoPool;

export interface SilverDeps {
  /** The Silver/Gold serving pool — a Trino adapter (createTrinoPool) in Brain V4. */
  readonly srPool: SilverPool;
}

/**
 * A scoped reader passed to the seam callback. The ONLY way to read Silver/Gold.
 * Structurally identical to TrinoScope (runScoped with the brand predicate injected).
 */
export type SilverScope = TrinoScope;

/** Options for withSilverBrand (test-only predicate-disable mutation seam). */
export type WithSilverBrandOptions = WithTrinoBrandOptions;

function silverErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when an error means the Silver/Gold serving tier is not available — the
 * Iceberg schema or a serving view/table doesn't exist (fresh/dev env not yet
 * provisioned), or a transient outage surfaced as not-found. runScoped only ever
 * issues serving queries, so a "does not exist / not found" here is always the tier.
 *
 * Ported to TRINO error strings (Trino phrases missing relations as
 * "Table 'iceberg.brain_serving.mv_x' does not exist" / "Schema 'brain_serving'
 * does not exist"). The legacy StarRocks phrases ("unknown table/database") are
 * retained so any mixed-engine transition window still degrades gracefully.
 */
function isSilverUnavailable(err: unknown): boolean {
  const msg = silverErrMessage(err).toLowerCase();
  return (
    msg.includes('does not exist') || // Trino: table/schema does not exist
    msg.includes('not found') || // Trino/Iceberg: schema/namespace not found
    msg.includes('unknown table') || // legacy StarRocks
    msg.includes('unknown database') // legacy StarRocks
  );
}

/**
 * withSilverBrand — runs `fn` with a brand-scoped Silver/Gold reader over TRINO.
 *
 * Delegates to withTrinoBrand (same brand-predicate isolation + fail-closed throw +
 * __unsafeDisableBrandPredicate mutation seam), then wraps the scope's `runScoped`
 * with the HONEST-EMPTY degradation: a "table/schema does not exist" error becomes
 * `[]` (+ WARN) so a fresh/dev env returns no_data instead of a 500.
 *
 * @param srPool  - The Trino serving pool (createTrinoPool), injected at the root.
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
  return withTrinoBrand(
    srPool,
    brandId,
    (trinoScope) => {
      // Wrap runScoped to add the StarRocks-era honest-empty degradation. The
      // fail-closed sentinel check + brand-predicate injection happen INSIDE
      // trinoScope.runScoped (in withTrinoBrand) — a missing-sentinel throw is NOT
      // a tier-unavailable error, so it still propagates (fail-closed preserved).
      const scope: SilverScope = {
        async runScoped<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
          try {
            return await trinoScope.runScoped<R>(sql, params);
          } catch (err) {
            if (isSilverUnavailable(err)) {
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
