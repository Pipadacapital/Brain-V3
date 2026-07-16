/**
 * @brain/metric-engine — serving query PORT + withServingBrand helper.
 *
 * (Renamed from trino-deps.ts — engine-neutral rename, ADR-0014 Trino removal.)
 *
 * This is the engine-facing sibling of silver-deps.ts. It exposes the SOLE seam through
 * which the engine may issue queries against the serving tier — in Brain V4 the
 * stateless duckdb-serving service (DuckDB attached read-only to the Iceberg REST
 * catalog, local brain_serving views over the Gold/Silver marts). Known registered
 * metrics MUST go to brain_serving.mv_* via this seam. See query-route.ts.
 *
 * ── PER-BRAND ISOLATION ──────────────────────────────────────────────────────────
 * withServingBrand mirrors withSilverBrand EXACTLY:
 *   1. The caller's SQL MUST include the BRAND_PREDICATE sentinel (imported from
 *      silver-deps.ts — the one shared sentinel for all tiers).
 *   2. runScoped replaces the sentinel with `brand_id = ?` (parameterized), appending
 *      brandId to the param list. If the sentinel is absent, runScoped THROWS (fail-
 *      closed) — a query without the sentinel would run cross-brand.
 *   3. The __unsafeDisableBrandPredicate test flag strips the predicate to `1 = 1`
 *      for the isolation-fuzz mutation proof. Never set in application code.
 *
 * duckdb-serving's HTTP API (like Trino's REST API before it) does not support
 * session-variable row policies. The SQL predicate injection IS the load-bearing
 * isolation for the serving tier. The concrete adapter (duckdb-serving-adapter.ts)
 * substitutes params client-side before the single POST — the seam's predicate
 * injection is what the isolation-fuzz test proves.
 *
 * ServingPool is typed structurally (no hard import of an HTTP client into this type)
 * so the composition root can inject any conforming adapter.
 *
 * @see packages/metric-engine/src/silver-deps.ts            — the Silver/Gold sibling (same pattern)
 * @see packages/metric-engine/src/duckdb-serving-adapter.ts — the concrete HTTP adapter
 * @see packages/metric-engine/src/query-route.ts            — routing rules (known metrics → serving views)
 */

/**
 * The ONE shared sentinel the seam substitutes with the brand predicate.
 *
 * Brain V4 serving runs over duckdb-serving (Iceberg), so this sentinel LIVES here —
 * the serving seam is the canonical owner. silver-deps.ts re-exports it so the ~41
 * caller files that `import { BRAND_PREDICATE } from './silver-deps.js'` are
 * unchanged. Both seams (withSilverBrand, withServingBrand) substitute it identically.
 */
export const BRAND_PREDICATE = '${BRAND_PREDICATE}';

// ── Structural interfaces (driver-agnostic PORT) ──────────────────────────────

/**
 * Minimal structural interface for a serving query executor.
 * Do NOT import an HTTP client here — the concrete adapter lives in
 * duckdb-serving-adapter.ts and is injected by the composition root. Any object that
 * satisfies this shape (e.g. a mock in tests, the HTTP adapter in prod) can be used.
 */
export interface ServingPool {
  /**
   * Execute SQL against the serving tier, returning the row array.
   * The adapter is responsible for the serving wire protocol (POST /v1/query),
   * safe parameter substitution, and column-name→object mapping.
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Named port alias. Consumers program to ServingQueryPort; the composition root
 * injects a concrete ServingPool (createDuckDbServingPool from duckdb-serving-adapter.ts).
 */
export type ServingQueryPort = ServingPool;

/**
 * A brand-scoped serving reader handed to the withServingBrand callback.
 * This is the ONLY way to query the serving tier within the metric-engine.
 */
export interface ServingScope {
  /**
   * Run a SELECT via the serving tier with the brand predicate injected.
   *
   * The caller's WHERE clause MUST end with ${BRAND_PREDICATE}; the seam
   * replaces it with `brand_id = ?` (parameterized, brandId appended to params).
   * Throws if the sentinel is absent — never runs an un-scoped (cross-brand) query.
   */
  runScoped<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface WithServingBrandOptions {
  /**
   * TEST-ONLY: when true, the seam does NOT inject `brand_id = ?` and does NOT
   * validate the sentinel. Used SOLELY by the isolation-fuzz mutation test to prove
   * the predicate is doing the isolation work (disabling it MUST leak brand-B rows).
   * Setting this in application code is a security violation.
   */
  readonly __unsafeDisableBrandPredicate?: boolean;
}

// ── withServingBrand ───────────────────────────────────────────────────────────

/**
 * withServingBrand — runs `fn` with a brand-scoped serving reader.
 *
 * Mirrors withSilverBrand exactly (same sentinel, same fail-closed throw, same
 * __unsafeDisableBrandPredicate test seam). The serving-specific detail is that
 * the brand isolation is SOLELY via the SQL predicate — there is no session-var
 * equivalent to SET @brain_current_brand_id here; the predicate injection is the
 * load-bearing mechanism.
 *
 * @param servingPool - Any adapter implementing ServingPool (ServingQueryPort).
 * @param brandId     - The brand UUID (from session — D-1; NEVER from request body).
 * @param fn          - Async fn receiving the brand-scoped reader (ServingScope).
 * @param opts        - Test-only options (predicate-disable for the mutation proof).
 */
export async function withServingBrand<T>(
  servingPool: ServingPool,
  brandId: string,
  fn: (scope: ServingScope) => Promise<T>,
  opts: WithServingBrandOptions = {},
): Promise<T> {
  const disable = opts.__unsafeDisableBrandPredicate === true;

  const scope: ServingScope = {
    async runScoped<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
      // Fail-CLOSED (mirrors silver-deps.ts): if the sentinel is absent the caller
      // forgot the brand predicate — the query would run cross-brand. Throw, never silently
      // proceed. Disabled ONLY under the explicit test seam.
      if (!disable && !sql.includes(BRAND_PREDICATE)) {
        throw new Error(
          'serving runScoped: query is missing the ${BRAND_PREDICATE} sentinel — refusing to run ' +
            'un-scoped (would be cross-brand). Add `WHERE ... ${BRAND_PREDICATE}` to the query.',
        );
      }

      let finalSql: string;
      let finalParams: unknown[];

      if (disable) {
        // Mutation/negative-control path: replace sentinel with 1 = 1 → cross-brand leak.
        finalSql = sql.replace(BRAND_PREDICATE, '1 = 1');
        finalParams = params;
      } else {
        // Seam injects the parameterized brand predicate.
        finalSql = sql.replace(BRAND_PREDICATE, 'brand_id = ?');
        finalParams = [...params, brandId];
      }

      return servingPool.query<R>(finalSql, finalParams);
    },
  };

  return fn(scope);
}
