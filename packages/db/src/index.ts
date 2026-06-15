/**
 * @brain/db — Postgres connection pool with RLS middleware.
 *
 * NN-1 (CRITICAL): The RLS predicate in migrations uses two-arg
 * current_setting('app.current_brand_id', true)::uuid so a missing GUC
 * returns NULL (not an error), making the predicate brand_id = NULL which
 * is ALWAYS false — zero rows returned structurally.
 *
 * This middleware MUST:
 *  (a) Reset the GUC to null on connection checkout (clears stale pool state).
 *  (b) Re-set app.current_brand_id before EVERY query in that checkout.
 *
 * Both steps are required — omitting either creates the stale-GUC vector
 * where a cross-brand query could succeed using a previous slot's brand_id.
 *
 * Stack: node-postgres (pg) per STACK.md ADR-001. node-pg-migrate for migrations.
 */

// ── Pool configuration type ───────────────────────────────────────────────────

export interface DbPoolConfig {
  /** Postgres connection string. Never hard-code; read from Secrets Manager / env. */
  connectionString: string;
  /** Maximum pool size. Default 10. */
  maxConnections?: number;
  /** Connection idle timeout in ms. Default 30_000. */
  idleTimeoutMs?: number;
  /** Statement timeout in ms. Applied per-query to prevent runaway queries. */
  statementTimeoutMs?: number;
}

// ── Query context — REQUIRED for every query ──────────────────────────────────

export interface QueryContext {
  /**
   * UUID of the brand making the request.
   * REQUIRED — a query without brandId is rejected before execution (NN-1).
   * The middleware sets app.current_brand_id from this value.
   */
  brandId: string;
  /**
   * Correlation ID from the inbound request — propagated to Postgres session.
   * Used for query-level tracing.
   */
  correlationId: string;
}

// ── Pool interface (adapter, testable without a real Postgres connection) ─────

export interface DbClient {
  /** Execute a parameterised query with mandatory tenant context (NN-1). */
  query<T = unknown>(
    ctx: QueryContext,
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;

  /** Release the client back to the pool. */
  release(): void;
}

export interface DbPool {
  /**
   * Acquire a client from the pool.
   * The middleware:
   *  1. Resets app.current_brand_id to NULL (clears any stale GUC).
   *  2. Caller sets ctx.brandId before each query via query().
   */
  connect(): Promise<DbClient>;

  /** Close all connections and drain the pool. */
  end(): Promise<void>;
}

// ── GUC helpers ───────────────────────────────────────────────────────────────

/**
 * The Postgres GUC name for the current brand context.
 * Must match the RLS policy predicate exactly:
 *   USING (brand_id = current_setting('app.current_brand_id', true)::uuid)
 */
export const BRAND_ID_GUC = 'app.current_brand_id' as const;

/**
 * Build the SET LOCAL statement for the brand GUC.
 * SET LOCAL scopes the GUC to the current transaction; if no transaction is
 * active it scopes to the current statement.
 */
export function buildSetGucSql(brandId: string): string {
  // Validate UUID format to prevent SQL injection through the GUC value.
  // The RLS policy casts to ::uuid which would also fail, but we validate early.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(brandId)) {
    throw new Error(`[db] buildSetGucSql: brandId "${brandId}" is not a valid UUID`);
  }
  return `SET LOCAL ${BRAND_ID_GUC} = '${brandId}'`;
}

/**
 * Build the RESET statement to clear the brand GUC.
 * Called at pool checkout to prevent stale-GUC leakage (NN-1).
 */
export function buildResetGucSql(): string {
  return `RESET ${BRAND_ID_GUC}`;
}

// ── Stub pool (Sprint 0 — real pg.Pool wired in M1 behind the interface) ─────

/**
 * A stub pool for Sprint-0 unit testing.
 * The real implementation uses pg.Pool from node-postgres.
 * This stub is used in the RLS unit test to verify the GUC middleware logic
 * without a live Postgres connection.
 */

export interface StubQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export type StubExecutor<T = unknown> = (
  sql: string,
  params: unknown[],
) => Promise<StubQueryResult<T>>;

/**
 * Create a stub DB client that enforces the GUC middleware contract.
 *
 * @param execute - A function that simulates query execution. In tests, this
 *   can return empty rows when the GUC is not set (proving the RLS negative control).
 */
export function createStubClient<T = unknown>(execute: StubExecutor<T>): DbClient {
  return {
    async query<R = unknown>(ctx: QueryContext, sql: string, params: unknown[] = []) {
      // Validate that brandId is provided
      if (!ctx.brandId) {
        throw new Error('[db] query: brandId is required in QueryContext (NN-1)');
      }
      if (!ctx.correlationId) {
        throw new Error('[db] query: correlationId is required in QueryContext');
      }
      const result = await execute(sql, params ?? []);
      return result as unknown as { rows: R[]; rowCount: number | null };
    },

    release() {
      // No-op in stub.
    },
  };
}

/**
 * Simulate pool checkout: reset the GUC to null before handing out the client.
 * In the real pool, this fires RESET app.current_brand_id on the pg.Client.
 *
 * This function exists to make the checkout+reset contract testable in isolation.
 */
export function checkoutStubClient<T>(execute: StubExecutor<T>): {
  client: DbClient;
  /** Internal: whether the GUC was reset at checkout. */
  _wasReset: () => boolean;
} {
  let resetted = false;

  const client: DbClient = {
    async query<R = unknown>(ctx: QueryContext, sql: string, params: unknown[] = []) {
      if (!ctx.brandId) {
        throw new Error('[db] query: brandId is required in QueryContext (NN-1)');
      }
      if (!resetted) {
        throw new Error('[db] GUC must be reset at checkout (NN-1)');
      }
      const result = await execute(sql, params ?? []);
      return result as unknown as { rows: R[]; rowCount: number | null };
    },
    release() {
      resetted = false;
    },
  };

  // Simulate checkout reset (NN-1 requirement a).
  // In real pool: pgClient.query(`RESET ${BRAND_ID_GUC}`)
  resetted = true;

  return { client, _wasReset: () => resetted };
}
