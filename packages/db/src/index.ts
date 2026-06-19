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
 * NN-1b (CRITICAL — audit R-01/R-02): the GUC set and the business query MUST run
 * inside the SAME transaction. `SET LOCAL` is transaction-scoped, so when it was issued
 * as a separate autocommit statement it was discarded before the business query ran and
 * the RLS predicate saw NULL. AND each transaction MUST `SET LOCAL ROLE <appRole>` first:
 * a superuser or table-owner connection (e.g. the dev `brain` role) BYPASSES row-level
 * security entirely, so dropping to the NOBYPASSRLS app role is what makes ENABLE/FORCE
 * ROW LEVEL SECURITY actually apply. Both are handled by executeInRlsTxn below, which
 * mirrors metric-engine's withBrandTxn.
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
  /**
   * NOBYPASSRLS Postgres role that RLS policies are written `TO`. Every query runs
   * `SET LOCAL ROLE <appRole>` inside its transaction so row-level security applies
   * even when the pool itself connects as a superuser/owner (audit R-01). Default
   * 'brain_app' — matches the role created in migration 0001_init.
   */
  appRole?: string;
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
 * The all-zero UUID — the fail-closed sentinel for a GUC the current query does not provide.
 * It is a VALID uuid that no real row matches, so an RLS policy that casts a GUC this query
 * didn't set does a valid `'<nil>'::uuid` cast (→ 0 rows) instead of erroring.
 */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000' as const;

/**
 * Build the SET LOCAL statements for a QueryContext.
 *
 * ALWAYS sets all three GUCs — any not provided in `ctx` default to NIL_UUID. This is required
 * because RESET on a custom (placeholder) GUC leaves it as the empty string `''`, not NULL, so a
 * policy casting an unset GUC (`current_setting('app.current_x', true)::uuid`) would hit
 * `''::uuid` and raise `invalid input syntax for type uuid`. This bites any table whose RLS
 * references a GUC the query doesn't set — e.g. resolving a user's membership (the user GUC is
 * set, but the table's workspace-isolation policy still casts the workspace GUC). Defaulting to
 * NIL_UUID keeps every cast valid AND fail-closed (no real row equals the nil uuid). (NN-1.)
 */
export function buildContextGucSql(ctx: QueryContext): string {
  return [
    `SET LOCAL ${BRAND_ID_GUC} = '${gucValue('brandId', ctx.brandId)}'`,
    `SET LOCAL ${WORKSPACE_ID_GUC} = '${gucValue('workspaceId', ctx.workspaceId)}'`,
    `SET LOCAL ${USER_ID_GUC} = '${gucValue('userId', ctx.userId)}'`,
  ].join('; ');
}

/**
 * Resolve one GUC value: a missing OR empty-string id → NIL_UUID (fail-closed). A non-empty value
 * must be a valid UUID (injection guard). Empty string is treated as unset — `'' ?? x` would keep
 * `''` and reintroduce the `''::uuid` cast error, so callers passing `brandId: ''` are handled.
 */
function gucValue(name: string, value: string | undefined): string {
  if (value === undefined || value === '') return NIL_UUID;
  assertUuid(name, value);
  return value;
}

// ── Role-switch + RLS transaction (audit R-01/R-02) ───────────────────────────

/**
 * Default NOBYPASSRLS application role that the RLS policies are written `TO`
 * (created in migration 0001_init). The pool may connect as a superuser/owner; every
 * query drops to this role inside its transaction so RLS is actually enforced.
 */
export const DEFAULT_APP_ROLE = 'brain_app' as const;

/** Bare SQL identifier — role names are interpolated, so they must match this. */
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

/**
 * Build a `SET LOCAL ROLE` statement.
 *
 * SECURITY: superusers and table owners BYPASS row-level security, so a connection as
 * such a role must drop to a NOBYPASSRLS role for FORCE ROW LEVEL SECURITY to apply
 * (audit R-01/R-14). The role name comes from config (never user input) and is validated
 * as a bare identifier before interpolation — `SET LOCAL ROLE` cannot be parameterised.
 */
export function buildSetRoleSql(role: string): string {
  if (!IDENT_RE.test(role)) {
    throw new Error(`[db] app role "${role}" is not a valid SQL identifier`);
  }
  return `SET LOCAL ROLE ${role}`;
}

/** Minimal raw-client shape needed to run a query — satisfied by pg.PoolClient. */
export interface RawQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/**
 * Execute a single business query under RLS enforcement, in one transaction:
 *
 *   BEGIN; SET LOCAL ROLE <appRole>; SET LOCAL <gucs>   (one round-trip)
 *   <business query>                                    (carries bind params)
 *   COMMIT                                              (auto-clears role + GUCs)
 *
 * ROLLBACK on any error. This fixes audit R-01/R-02: previously the GUC was issued in a
 * SEPARATE autocommit statement and discarded before the query ran (so the RLS predicate
 * saw NULL), and no role switch was performed (so a superuser/owner connection bypassed
 * RLS). SET LOCAL is transaction-scoped, so here the GUC is still in effect for the
 * business query and resets automatically — it can never leak across pool connections.
 */
export async function executeInRlsTxn<T = unknown>(
  rawClient: RawQueryable,
  appRole: string,
  gucSql: string,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number | null }> {
  // Build (and validate the role) BEFORE opening the transaction so a bad role
  // throws without leaving an open transaction to roll back.
  const setup = ['BEGIN', buildSetRoleSql(appRole)];
  if (gucSql) {
    setup.push(gucSql);
  }
  try {
    await rawClient.query(setup.join('; '));
    const result = await rawClient.query(sql, params);
    await rawClient.query('COMMIT');
    return { rows: result.rows as T[], rowCount: result.rowCount };
  } catch (err) {
    await rawClient.query('ROLLBACK').catch(() => {
      /* preserve the original error */
    });
    throw err;
  }
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

  // RLS-enforcement role. Validate the identifier once, eagerly, so a misconfigured
  // role fails at startup rather than on the first query (audit R-01).
  const appRole = config.appRole ?? DEFAULT_APP_ROLE;
  buildSetRoleSql(appRole);

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
          // Step 2: Set applicable GUCs before every query (NN-1 requirement b),
          // and run the GUC + business query in ONE transaction under the NOBYPASSRLS
          // app role so RLS is actually enforced (NN-1b / audit R-01/R-02).
          const gucSql = buildContextGucSql(ctx);
          return executeInRlsTxn<T>(rawClient as RawQueryable, appRole, gucSql, sql, params);
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
