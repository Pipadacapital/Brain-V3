/**
 * @brain/metric-engine — Silver read seam (StarRocks) + withSilverBrand helper.
 *
 * This is the StarRocks analogue of deps.ts/withBrandTxn. It is the ONE place
 * the engine issues SQL against the Silver tier (silver.order_state in StarRocks
 * brain_silver), reached over the MySQL wire protocol (mysql2) as the SELECT-only
 * `brain_analytics` user. Per ADR-002 / I-ST01 the metric-engine is the SOLE
 * Silver reader — the UI never queries StarRocks; it reaches Silver only through
 * the BFF → analytics use-case → this seam.
 *
 * ── PER-BRAND ISOLATION (the honest M1 mechanism) ──────────────────────────────
 * StarRocks `CREATE ROW POLICY` is an enterprise/managed-only feature; the dev
 * `starrocks/allin1-ubuntu:3.3.2` image does NOT support it (verified in
 * db/starrocks/bootstrap.sql + tools/isolation-fuzz/src/starrocks.test.ts). So in
 * M1 the brand predicate is injected HERE — at the single seam — never per-call:
 *
 *   1. `SET @brain_current_brand_id = '<brandId>'` (session var, matching the
 *      row_policy_template convention so the prod row-policy is a drop-in swap), and
 *   2. the seam runs `runScoped(sql, params)` which ALWAYS appends
 *      `AND brand_id = ?` (parameterized to brandId) to the caller's WHERE.
 *
 * Because every Silver read goes through `runScoped`, a caller cannot forget the
 * predicate. The non-inert proof lives in tools/isolation-fuzz/src/silver-order-state.test.ts:
 * disabling the seam's predicate injection (the `__unsafeDisableBrandPredicate` test flag)
 * MUST leak brand-B rows — if it doesn't, the guard was inert and the test fails loud.
 *
 * PROD GRADUATION: on a managed/enterprise StarRocks cluster, apply
 * db/starrocks/row_policy_template.sql; the engine then enforces the same
 * @brain_current_brand_id predicate at the engine layer and this seam's app-level
 * predicate becomes defense-in-depth.
 *
 * @see packages/metric-engine/src/deps.ts — the Postgres sibling (withBrandTxn)
 * @see 05-architecture.md §4 (isolation) + §5 (Silver seam)
 */

/**
 * Minimal structural type for a mysql2/promise pool. We type it structurally
 * (rather than importing mysql2 types into the engine's public surface) so the
 * engine depends only on the shape it uses — the concrete pool is injected by
 * the composition root (apps/core/src/main.ts).
 */
export interface SilverPool {
  /** mysql2/promise pool.query — returns [rows, fields]. */
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  /** Acquire a dedicated connection so the session var + read share one session. */
  getConnection(): Promise<SilverConnection>;
}

export interface SilverConnection {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  release(): void;
}

export interface SilverDeps {
  /** The StarRocks pool (mysql2) as brain_analytics (SELECT-only). */
  readonly srPool: SilverPool;
}

/** A scoped reader passed to the seam callback. The ONLY way to read Silver. */
export interface SilverScope {
  /**
   * Run a SELECT against Silver with the brand predicate injected.
   *
   * The caller supplies a query whose WHERE clause ends with a placeholder
   * sentinel `${BRAND_PREDICATE}` — the seam replaces it with `brand_id = ?`
   * (parameterized) so the predicate is added by the SEAM, not the caller.
   * Returns the row array.
   */
  runScoped<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** The sentinel the seam substitutes with the brand predicate. */
export const BRAND_PREDICATE = '${BRAND_PREDICATE}';

function silverErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when an error means the Silver tier itself is not available — the brain_silver schema or a
 * silver table doesn't exist (fresh/dev env not yet provisioned), or the database is unknown.
 * runScoped only ever issues Silver queries, so an "unknown table/database" here is always Silver.
 */
function isSilverUnavailable(err: unknown): boolean {
  const msg = silverErrMessage(err).toLowerCase();
  return msg.includes('unknown table') || msg.includes('unknown database');
}

export interface WithSilverBrandOptions {
  /**
   * TEST-ONLY: when true, the seam does NOT inject `brand_id = ?` and does NOT
   * set the session var. Used SOLELY by the isolation-fuzz mutation test to prove
   * the predicate is doing the work (disabling it MUST leak brand-B rows). Never
   * set in application code.
   */
  readonly __unsafeDisableBrandPredicate?: boolean;
}

/**
 * withSilverBrand — runs `fn` with a brand-scoped Silver reader on a dedicated
 * StarRocks connection. Sets the @brain_current_brand_id session var, then hands
 * `fn` a SilverScope whose `runScoped` injects `brand_id = ?` at the seam.
 *
 * @param srPool  - The StarRocks mysql2 pool (brain_analytics).
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
  const disable = opts.__unsafeDisableBrandPredicate === true;
  const conn = await srPool.getConnection();
  try {
    if (!disable) {
      // Session var — matches the prod row_policy_template convention so the
      // engine row-policy (managed StarRocks) is a drop-in swap. mysql2 escapes
      // via the param; StarRocks SET does not take placeholders for the value, so
      // we escape the UUID ourselves (it is a session-provided UUID, validated
      // upstream; defensively we strip anything but UUID chars).
      const safeBrand = brandId.replace(/[^0-9a-fA-F-]/g, '');
      await conn.query(`SET @brain_current_brand_id = '${safeBrand}'`);
    }

    const scope: SilverScope = {
      async runScoped<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
        let finalSql: string;
        let finalParams: unknown[];
        // DB-AUDIT M1 — fail CLOSED: String.replace silently no-ops if the sentinel is absent, which
        // would run a query cross-brand with no error (a latent P0 tenant leak). Require the sentinel
        // unless explicitly disabled (the mutation/negative-control proof). One forgotten ${BRAND_
        // PREDICATE} now throws at the seam instead of leaking.
        if (!disable && !sql.includes(BRAND_PREDICATE)) {
          throw new Error(
            'silver runScoped: query is missing the ${BRAND_PREDICATE} sentinel — refusing to run ' +
              'un-scoped (would be cross-brand). Add `WHERE ... ${BRAND_PREDICATE}` to the query.',
          );
        }
        if (disable) {
          // Mutation/negative-control path: strip the predicate entirely → cross-brand.
          finalSql = sql.replace(BRAND_PREDICATE, '1 = 1');
          finalParams = params;
        } else {
          // The seam injects the parameterized brand predicate.
          finalSql = sql.replace(BRAND_PREDICATE, 'brand_id = ?');
          finalParams = [...params, brandId];
        }
        try {
          const [rows] = await conn.query(finalSql, finalParams);
          return (rows as R[]) ?? [];
        } catch (err) {
          // Silver tier unavailable (brain_silver schema/tables not provisioned in a fresh/dev
          // env, or a transient StarRocks outage) → degrade to an honest empty result so the read
          // returns its no_data state instead of crashing the dashboard with a 500. ONLY the
          // "unknown table/database" class is swallowed; real query errors still propagate. A WARN
          // is emitted so the missing tier is observable/alertable — never silently hidden.
          if (isSilverUnavailable(err)) {
            console.warn(
              `[metric-engine] Silver read degraded to empty — silver tier unavailable: ${silverErrMessage(err)}`,
            );
            return [] as R[];
          }
          throw err;
        }
      },
    };

    return await fn(scope);
  } finally {
    conn.release();
  }
}
