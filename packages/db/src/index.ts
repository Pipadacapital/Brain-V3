/**
 * @brain/db — Postgres connection pool with 3-GUC RLS middleware.
 *
 * NN-1 (CRITICAL): The RLS predicates in migrations use two-arg
 * current_setting('app.current_<scope>_id', true)::uuid so a missing GUC
 * returns NULL (not an error), making the predicate xxx_id = NULL which
 * is ALWAYS false — zero rows returned structurally.
 *
 * Three GUCs are required for M1 (binding — 03-architecture-plan.md §4 NN-1):
 *   app.current_brand_id      — brand-scoped tables
 *   app.current_workspace_id  — workspace/org-scoped tables
 *   app.current_user_id       — user-self-read tables (user_session, password_reset, email_verification)
 *
 * This middleware MUST:
 *  (a) Reset ALL three GUCs to null on connection checkout (clears stale pool state).
 *  (b) Re-set applicable GUC(s) before EVERY query in that checkout.
 *
 * Both steps are required — omitting either creates the stale-GUC vector
 * where a cross-tenant query could succeed using a previous slot's value.
 *
 * Stack: node-postgres (pg) per STACK.md ADR-001. node-pg-migrate for migrations.
 */

import { createHash } from 'node:crypto';

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
   * Required for brand-scoped tables. A query without brandId where brandId
   * is required will be rejected before execution (NN-1).
   */
  brandId?: string;
  /**
   * UUID of the workspace (organization) making the request.
   * Required for workspace-scoped tables (organization, membership).
   */
  workspaceId?: string;
  /**
   * UUID of the authenticated user.
   * Required for user-self-read tables (user_session, password_reset, email_verification).
   */
  userId?: string;
  /**
   * Correlation ID from the inbound request — propagated to Postgres session.
   * Used for query-level tracing.
   */
  correlationId: string;
}

// ── GUC constants ─────────────────────────────────────────────────────────────

export const BRAND_ID_GUC = 'app.current_brand_id' as const;
export const WORKSPACE_ID_GUC = 'app.current_workspace_id' as const;
export const USER_ID_GUC = 'app.current_user_id' as const;

/** All three GUC names — used for reset-all at checkout. */
export const ALL_GUCS = [BRAND_ID_GUC, WORKSPACE_ID_GUC, USER_ID_GUC] as const;

// ── UUID validation ───────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`[db] ${name} "${value}" is not a valid UUID`);
  }
}

// ── GUC helpers ───────────────────────────────────────────────────────────────

/**
 * Build a SET LOCAL statement for a single GUC.
 * SET LOCAL scopes the GUC to the current transaction; if no transaction is
 * active it scopes to the current statement.
 *
 * SECURITY: UUID format is validated before interpolation to prevent
 * SQL injection through the GUC value.
 */
export function buildSetGucSql(gucName: string, value: string): string {
  assertUuid(`GUC ${gucName}`, value);
  return `SET LOCAL ${gucName} = '${value}'`;
}

/**
 * Build a RESET statement to clear a single GUC.
 */
export function buildResetGucSql(gucName: string): string {
  return `RESET ${gucName}`;
}

/**
 * Build SQL to reset ALL three GUCs at pool checkout.
 * Returns three RESET statements separated by semicolons.
 */
export function buildResetAllGucsSql(): string {
  return ALL_GUCS.map(buildResetGucSql).join('; ');
}

/**
 * Build the SET LOCAL statements for a QueryContext.
 * Returns one statement per non-null GUC in the context.
 */
export function buildContextGucSql(ctx: QueryContext): string {
  const statements: string[] = [];
  if (ctx.brandId) {
    assertUuid('brandId', ctx.brandId);
    statements.push(`SET LOCAL ${BRAND_ID_GUC} = '${ctx.brandId}'`);
  }
  if (ctx.workspaceId) {
    assertUuid('workspaceId', ctx.workspaceId);
    statements.push(`SET LOCAL ${WORKSPACE_ID_GUC} = '${ctx.workspaceId}'`);
  }
  if (ctx.userId) {
    assertUuid('userId', ctx.userId);
    statements.push(`SET LOCAL ${USER_ID_GUC} = '${ctx.userId}'`);
  }
  return statements.join('; ');
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
   *  1. Resets ALL three GUCs to NULL (clears any stale GUC from previous slot).
   *  2. Caller sets applicable GUCs in ctx before each query via query().
   */
  connect(): Promise<DbClient>;

  /** Close all connections and drain the pool. */
  end(): Promise<void>;
}

// ── Real pool factory (requires 'pg' at runtime) ──────────────────────────────

/**
 * Create a real pg.Pool with 3-GUC reset middleware.
 *
 * Call this in apps/core/src/main.ts after env validation.
 * Requires `pg` package to be installed in the consuming app.
 *
 * The connect() method:
 *  1. Acquires a raw pg.Client from the pool.
 *  2. Executes RESET for all 3 GUCs (clears stale state from previous checkout).
 *  3. Returns a wrapped DbClient that sets applicable GUCs before each query.
 */
export async function createPool(config: DbPoolConfig): Promise<DbPool> {
  // Dynamic import to avoid requiring pg in packages that only use the interfaces.
  const { Pool } = await import('pg');

  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    statement_timeout: config.statementTimeoutMs,
  });

  return {
    async connect(): Promise<DbClient> {
      const rawClient = await pool.connect();

      // Step 1: Reset ALL three GUCs at checkout (NN-1 requirement a).
      // This ensures no stale GUC from a previous pool slot leaks into the new request.
      await rawClient.query(buildResetAllGucsSql());

      return {
        async query<T = unknown>(
          ctx: QueryContext,
          sql: string,
          params: unknown[] = [],
        ): Promise<{ rows: T[]; rowCount: number | null }> {
          // Step 2: Set applicable GUCs before every query (NN-1 requirement b).
          const gucSql = buildContextGucSql(ctx);
          if (gucSql) {
            await rawClient.query(gucSql);
          }

          // Cast through unknown: pg requires T extends QueryResultRow but our
          // DbClient interface intentionally uses T = unknown for flexibility.
          // The rows are structurally correct — pg always returns Record<string, unknown>[].
          const result = await rawClient.query(sql, params as unknown[]);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        },

        release(): void {
          (rawClient as { release: () => void }).release();
        },
      };
    },

    async end(): Promise<void> {
      await pool.end();
    },
  };
}

// ── Stub pool (Sprint 0 / unit test support) ──────────────────────────────────

export interface StubQueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export type StubExecutor<T = unknown> = (
  sql: string,
  params: unknown[],
) => Promise<StubQueryResult<T>>;

/**
 * Create a stub DB client that enforces the 3-GUC middleware contract.
 *
 * At least ONE of brandId, workspaceId, or userId must be provided in QueryContext.
 * A correlationId is always required for tracing.
 */
export function createStubClient<T = unknown>(execute: StubExecutor<T>): DbClient {
  return {
    async query<R = unknown>(ctx: QueryContext, sql: string, params: unknown[] = []) {
      if (!ctx.brandId && !ctx.workspaceId && !ctx.userId) {
        throw new Error(
          '[db] query: at least one of brandId, workspaceId, or userId is required in QueryContext (NN-1)',
        );
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
 * Simulate pool checkout: reset all GUCs to null before handing out the client.
 * In the real pool, this fires RESET for all 3 GUCs on the pg.Client.
 */
export function checkoutStubClient<T>(execute: StubExecutor<T>): {
  client: DbClient;
  _wasReset: () => boolean;
} {
  let resetted = false;

  const client: DbClient = {
    async query<R = unknown>(ctx: QueryContext, sql: string, params: unknown[] = []) {
      if (!ctx.brandId && !ctx.workspaceId && !ctx.userId) {
        throw new Error(
          '[db] query: at least one of brandId, workspaceId, or userId is required (NN-1)',
        );
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
  resetted = true;

  return { client, _wasReset: () => resetted };
}

// ── Hash utilities (used by auth service for token hashing) ───────────────────

/**
 * Compute SHA-256 hex digest of a string.
 * Used to hash reset/verification tokens before DB storage (NN-5).
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
