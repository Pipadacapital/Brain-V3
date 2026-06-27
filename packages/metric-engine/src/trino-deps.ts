/**
 * @brain/metric-engine — Trino query PORT + withTrinoBrand helper.
 *
 * This is the Trino analogue of silver-deps.ts. It exposes the SOLE seam through
 * which the engine may issue ad-hoc Iceberg queries over Trino. Trino is ADDITIVE
 * and READ-ONLY for ad-hoc / federated exploration. Known registered metrics MUST
 * go to brain_serving.mv_* (StarRocks) — never to Trino. See query-route.ts.
 *
 * ── PER-BRAND ISOLATION ──────────────────────────────────────────────────────────
 * withTrinoBrand mirrors withSilverBrand EXACTLY:
 *   1. The caller's SQL MUST include the BRAND_PREDICATE sentinel (imported from
 *      silver-deps.ts — the one shared sentinel for all tiers).
 *   2. runScoped replaces the sentinel with `brand_id = ?` (parameterized), appending
 *      brandId to the param list. If the sentinel is absent, runScoped THROWS (fail-
 *      closed) — a query without the sentinel would run cross-brand.
 *   3. The __unsafeDisableBrandPredicate test flag strips the predicate to `1 = 1`
 *      for the isolation-fuzz mutation proof. Never set in application code.
 *
 * Unlike StarRocks (mysql2 wire), Trino's REST API does not support session-variable
 * row policies. The SQL predicate injection IS the load-bearing isolation for Trino.
 * The concrete adapter (trino-adapter.ts) may additionally set X-Trino-Session
 * headers for cluster-level audit, but those are defense-in-depth — the seam's
 * predicate injection is what the isolation-fuzz test proves.
 *
 * TrinoPool is typed structurally (no hard import of a Trino driver into this type)
 * so the composition root can inject any conforming adapter.
 *
 * @see packages/metric-engine/src/silver-deps.ts — the StarRocks sibling (same pattern)
 * @see packages/metric-engine/src/trino-adapter.ts — the concrete HTTP adapter
 * @see packages/metric-engine/src/query-route.ts — routing rules (known metrics → StarRocks)
 */

/**
 * The ONE shared sentinel the seam substitutes with the brand predicate.
 *
 * Brain V4 serving runs over TRINO (Iceberg), so this sentinel now LIVES here —
 * the Trino seam is the canonical owner. silver-deps.ts re-exports it so the ~41
 * caller files that `import { BRAND_PREDICATE } from './silver-deps.js'` are
 * unchanged. Both seams (withSilverBrand, withTrinoBrand) substitute it identically.
 */
export const BRAND_PREDICATE = '${BRAND_PREDICATE}';

// ── Structural interfaces (driver-agnostic PORT) ──────────────────────────────

/**
 * Minimal structural interface for a Trino query executor.
 * Do NOT import a Trino driver here — the concrete adapter lives in trino-adapter.ts
 * and is injected by the composition root. Any object that satisfies this shape
 * (e.g. a mock in tests, the HTTP adapter in prod) can be used.
 */
export interface TrinoPool {
  /**
   * Execute SQL against Trino, returning the row array.
   * The adapter is responsible for Trino wire protocol (HTTP /v1/statement polling),
   * safe parameter substitution, and column-name→object mapping.
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Named port alias. Consumers program to TrinoQueryPort; the composition root
 * injects a concrete TrinoPool (createTrinoPool from trino-adapter.ts).
 */
export type TrinoQueryPort = TrinoPool;

/**
 * A brand-scoped Trino reader handed to the withTrinoBrand callback.
 * This is the ONLY way to query Trino within the metric-engine.
 */
export interface TrinoScope {
  /**
   * Run a SELECT via Trino with the brand predicate injected.
   *
   * The caller's WHERE clause MUST end with ${BRAND_PREDICATE}; the seam
   * replaces it with `brand_id = ?` (parameterized, brandId appended to params).
   * Throws if the sentinel is absent — never runs an un-scoped (cross-brand) query.
   */
  runScoped<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface WithTrinoBrandOptions {
  /**
   * TEST-ONLY: when true, the seam does NOT inject `brand_id = ?` and does NOT
   * validate the sentinel. Used SOLELY by the isolation-fuzz mutation test to prove
   * the predicate is doing the isolation work (disabling it MUST leak brand-B rows).
   * Setting this in application code is a security violation.
   */
  readonly __unsafeDisableBrandPredicate?: boolean;
}

// ── withTrinoBrand ─────────────────────────────────────────────────────────────

/**
 * withTrinoBrand — runs `fn` with a brand-scoped Trino reader.
 *
 * Mirrors withSilverBrand exactly (same sentinel, same fail-closed throw, same
 * __unsafeDisableBrandPredicate test seam). The Trino-specific detail is that
 * the brand isolation is SOLELY via the SQL predicate — there is no session-var
 * equivalent to SET @brain_current_brand_id here; the predicate injection is the
 * load-bearing mechanism.
 *
 * @param trinoPool - Any adapter implementing TrinoPool (TrinoQueryPort).
 * @param brandId   - The brand UUID (from session — D-1; NEVER from request body).
 * @param fn        - Async fn receiving the brand-scoped reader (TrinoScope).
 * @param opts      - Test-only options (predicate-disable for the mutation proof).
 */
export async function withTrinoBrand<T>(
  trinoPool: TrinoPool,
  brandId: string,
  fn: (scope: TrinoScope) => Promise<T>,
  opts: WithTrinoBrandOptions = {},
): Promise<T> {
  const disable = opts.__unsafeDisableBrandPredicate === true;

  const scope: TrinoScope = {
    async runScoped<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
      // Fail-CLOSED (mirrors silver-deps.ts): if the sentinel is absent the caller
      // forgot the brand predicate — the query would run cross-brand. Throw, never silently
      // proceed. Disabled ONLY under the explicit test seam.
      if (!disable && !sql.includes(BRAND_PREDICATE)) {
        throw new Error(
          'trino runScoped: query is missing the ${BRAND_PREDICATE} sentinel — refusing to run ' +
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

      return trinoPool.query<R>(finalSql, finalParams);
    },
  };

  return fn(scope);
}
