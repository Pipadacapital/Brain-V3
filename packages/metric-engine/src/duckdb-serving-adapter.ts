/**
 * @brain/metric-engine — duckdb-serving HTTP adapter (concrete ServingPool implementation).
 *
 * This is the ONLY file that makes HTTP calls to the duckdb-serving tier. The PORT
 * (serving-deps.ts) is driver-agnostic; this adapter is injected by the composition root.
 * It replaces the Trino adapter 1:1 (same port, same param-substitution seam) — the
 * serving engine is now the stateless duckdb-serving service (DuckDB attached read-only
 * to the Iceberg REST catalog, local brain_serving views over the Gold/Silver marts).
 *
 * duckdb-serving API (no polling — one request per query):
 *   POST /v1/query { sql, timeout_ms } → { columns: [{name,type}], data: [[...]] }
 * Data is returned as Array<Array<unknown>>; columns gives column names.
 * Rows are converted to Record<string, unknown> using column metadata.
 *
 * ERROR TAXONOMY (HTTP status → failure class, per the serving contract):
 *   400 → parse/binder error (bad SQL / unknown relation) — NOT retriable
 *   429 → admission rejected (replica at DUCKDB_SERVING_MAX_CONCURRENT) — caller backs off
 *   504 → statement timeout (server watchdog interrupted the query) — NOT retriable
 *   503 → replica not ready (epoch rotation / views not applied) — retried ONCE here
 *   500 → internal serving error — NOT retriable
 * The server's error message is preserved verbatim in the thrown Error so the
 * isServingTierUnavailable() classifier ("does not exist" / "not found") keeps working.
 *
 * PARAMETER SUBSTITUTION: the serving API takes a single SQL string — no `?` placeholder
 * protocol. Parameters are substituted client-side before the SQL is sent (ported VERBATIM
 * from the Trino adapter, incl. the AUD-ARCH-013 both-direction count guard):
 *   - UUID / string → single-quoted with apostrophes doubled (SQL-safe)
 *   - number / bigint → bare numeric (verified finite)
 *   - boolean → TRUE / FALSE literal
 *   - null / undefined → NULL literal
 * INVARIANT: only seam-controlled values (brand_id UUIDs, numeric window args) should
 * be passed as params. Arbitrary user input MUST NOT flow through this substitution.
 *
 * Requires Node.js >= 18 (global fetch). Fails loud at pool-creation time if absent.
 */

import type { ServingPool } from './serving-deps.js';

// ── Config ─────────────────────────────────────────────────────────────────────

export interface DuckDbServingAdapterConfig {
  /** Base URL of the duckdb-serving service, e.g. 'http://localhost:8091'. */
  readonly baseUrl: string;
  /**
   * Server-side statement budget (ms), sent as `timeout_ms` in the request body. The serving
   * replica's interrupt watchdog kills the query at this budget and returns a clean 504 —
   * it MUST stay below fetchTimeoutMs so the server timeout (a classified error) always
   * fires before the client abort (an opaque fetch failure). Default 25_000.
   */
  readonly queryTimeoutMs?: number;
  /**
   * Client-side HTTP abort (ms) via AbortSignal.timeout (default 30_000). A request hanging
   * this long means a hung replica — abort instead of pinning the caller (BFF request)
   * forever. Unlike Trino there is no server-side query to DELETE on abandon: the replica's
   * own watchdog reaps the interrupted cursor.
   */
  readonly fetchTimeoutMs?: number;
  /**
   * Delay (ms) before the single 503 not_ready retry (default 250). 503 means the replica
   * is mid epoch-rotation / still applying views at startup — one short retry rides out the
   * atomic swap; a second 503 is surfaced (the LB/HPA should route elsewhere, not us).
   */
  readonly notReadyRetryDelayMs?: number;
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface ServingColumn {
  name: string;
  type: string;
}

interface ServingResponse {
  columns?: ServingColumn[];
  data?: Array<Array<unknown>>;
  error?: { message?: string; code?: string };
  /** FastAPI default error envelope (HTTPException) — tolerated alongside `error`. */
  detail?: unknown;
}

/**
 * Minimal fetch type for the Node 18+ globalThis.fetch.
 * Avoids requiring "lib": ["DOM"] or @types/node in this package's tsconfig.
 */
type MinimalFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    /** AbortSignal — typed as unknown to avoid the DOM lib in this package's tsconfig. */
    signal?: unknown;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

// ── Safe param substitution ────────────────────────────────────────────────────

/**
 * Substitute `?` placeholders in serving SQL with safely-escaped literal values.
 * Only seam-controlled values (brand_id UUID, numeric args) are expected here.
 *
 * GUARDED BOTH DIRECTIONS (AUD-ARCH-013): the brand-isolation seam appends brandId as the
 * LAST param and relies on the ${BRAND_PREDICATE}-injected `?` being the LAST placeholder.
 * Any placeholder/param count mismatch means the positional mapping shifted — a data value
 * could bind into the brand_id slot. Throw loud, never substitute misaligned.
 *
 * Exported for unit tests only — production callers go through ServingPool.query.
 */
export function substituteParams(sql: string, params: unknown[]): string {
  let i = 0;
  const substituted = sql.replace(/\?/g, () => {
    if (i >= params.length) {
      throw new Error(
        `[duckdb-serving-adapter] not enough params for query placeholders — ` +
          `placeholder ${i + 1} has no matching param (${params.length} provided)`,
      );
    }
    const p = params[i++];
    if (p === null || p === undefined) return 'NULL';
    if (typeof p === 'bigint') return p.toString();
    if (typeof p === 'number') {
      if (!Number.isFinite(p))
        throw new Error(`[duckdb-serving-adapter] non-finite numeric param: ${p}`);
      return String(p);
    }
    if (typeof p === 'boolean') return p ? 'TRUE' : 'FALSE';
    if (typeof p === 'string') {
      // DuckDB, like Trino, is STRICTLY typed against the Iceberg marts: comparing a
      // timestamptz column to a bare varchar mis-types. The metric queries bind date windows
      // as strings (asOf/from/to), so emit a TYPED literal for date- and timestamp-shaped
      // strings — column comparisons then type-check. Anything else (UUIDs, statuses, …)
      // doesn't match these exact patterns → stays a varchar literal.
      if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return `DATE '${p}'`;
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(p)) {
        // TIMESTAMP param → a TIMESTAMPTZ literal. The Iceberg Gold/Silver marts store
        // occurred_at / last_status_at / state_effective_at / economic_effective_at as
        // `timestamp(6) with time zone`; the serving replicas pin SET TimeZone='UTC', so a
        // zoneless TIMESTAMPTZ literal is interpreted as UTC and compares correctly against
        // the timestamptz columns (spike-verified, gate e). Normalize to
        // 'YYYY-MM-DD HH:MM:SS' (drop 'T', any fractional seconds, any trailing Z).
        const norm = p.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/i, '').trim().slice(0, 19);
        return `TIMESTAMPTZ '${norm}'`;
      }
      // Escape single quotes by doubling — standard SQL escaping, safe for UUIDs.
      return `'${p.replace(/'/g, "''")}'`;
    }
    throw new Error(
      `[duckdb-serving-adapter] unsupported param type '${typeof p}' at index ${i - 1}`,
    );
  });
  if (i !== params.length) {
    throw new Error(
      `[duckdb-serving-adapter] placeholder/param count mismatch — SQL has ${i} \`?\` placeholder(s) ` +
        `but ${params.length} params were provided (positional binding would misalign)`,
    );
  }
  return substituted;
}

// ── Error classification ───────────────────────────────────────────────────────

/**
 * Pull the server's error message out of a (possibly non-JSON) error response body.
 * duckdb-serving emits { error: { message, code } }; FastAPI's default HTTPException
 * envelope is { detail }. Either way the DuckDB message text is preserved so
 * isServingTierUnavailable() can classify "does not exist" as honest-empty.
 */
function serverErrMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as ServingResponse;
  if (typeof b.error?.message === 'string') return b.error.message;
  if (typeof b.detail === 'string') return b.detail;
  return undefined;
}

/** Human label for the serving error taxonomy (kept in the thrown message for operators). */
function statusLabel(status: number): string {
  switch (status) {
    case 400:
      return 'query rejected (parse/binder error)';
    case 429:
      return 'admission rejected (replica at max concurrency)';
    case 503:
      return 'replica not ready (epoch rotation / startup)';
    case 504:
      return 'statement timeout (server watchdog interrupted the query)';
    default:
      return 'serving error';
  }
}

// ── Adapter factory ────────────────────────────────────────────────────────────

/**
 * Create a ServingPool-conforming serving pool backed by the duckdb-serving HTTP API.
 * Inject this at the composition root; pass as the first arg to withServingBrand /
 * withSilverBrand — the seam and every metric file are unchanged (same port).
 *
 * @throws if global fetch is unavailable (requires Node.js >= 18).
 */
export function createDuckDbServingPool(config: DuckDbServingAdapterConfig): ServingPool {
  const {
    baseUrl,
    queryTimeoutMs = 25_000,
    fetchTimeoutMs = 30_000,
    notReadyRetryDelayMs = 250,
  } = config;

  // Validate global fetch at pool-creation time (fail loud, not at first query).
  const globalFetch = (globalThis as { fetch?: MinimalFetch }).fetch;
  if (!globalFetch) {
    throw new Error(
      '[duckdb-serving-adapter] globalThis.fetch is not available — createDuckDbServingPool requires Node.js >= 18',
    );
  }
  const doFetch: MinimalFetch = globalFetch;

  // AbortSignal.timeout via globalThis (structural — no DOM lib). Node >= 18 always has it;
  // fall back to no timeout rather than failing if a nonstandard runtime lacks it.
  const abortSignalCtor = (globalThis as { AbortSignal?: { timeout(ms: number): unknown } })
    .AbortSignal;
  const timeoutSignal = (): unknown =>
    abortSignalCtor?.timeout ? abortSignalCtor.timeout(fetchTimeoutMs) : undefined;

  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const finalSql = params.length > 0 ? substituteParams(sql, params) : sql;
      const body = JSON.stringify({ sql: finalSql, timeout_ms: queryTimeoutMs });

      // Single POST — duckdb-serving executes synchronously (no nextUri polling, no
      // partial-page accumulation, therefore no truncation class to guard against).
      // 503 (not_ready) is retried ONCE: it is the only PRE-EXECUTION status (the query
      // never started), so a retry cannot double-execute anything.
      let attempt = 0;
      for (;;) {
        const res = await doFetch(`${baseUrl}/v1/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: timeoutSignal(),
        });

        if (res.status === 503 && attempt === 0) {
          attempt++;
          await new Promise<void>((resolve) => setTimeout(resolve, notReadyRetryDelayMs));
          continue;
        }

        // Error body is best-effort JSON — a proxy/LB error page must not mask the status.
        const respBody: unknown = await res.json().catch(() => undefined);

        if (!res.ok) {
          const detail = serverErrMessage(respBody);
          throw new Error(
            `[duckdb-serving-adapter] ${statusLabel(res.status)} — HTTP ${res.status} ` +
              `${res.statusText}${detail ? `: ${detail}` : ''}`,
          );
        }

        const resp = (respBody ?? {}) as ServingResponse;
        // Defense-in-depth: a 200 carrying an error envelope is a contract violation — fail
        // loud rather than render an empty (plausible-but-wrong) result.
        if (resp.error) {
          throw new Error(
            `[duckdb-serving-adapter] serving error in 200 response: ${resp.error.message ?? 'unknown'}`,
          );
        }

        const columns = resp.columns;
        const data = resp.data ?? [];
        if (!columns || data.length === 0) return [] as T[];

        // Convert array-of-arrays → array-of-objects using column names
        const colNames = columns.map((c) => c.name);
        return data.map((row) => {
          const obj: Record<string, unknown> = {};
          colNames.forEach((col, idx) => {
            obj[col] = row[idx];
          });
          return obj as T;
        });
      }
    },
  };
}
