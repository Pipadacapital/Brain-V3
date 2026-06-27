/**
 * @brain/metric-engine — Trino HTTP adapter (concrete TrinoPool implementation).
 *
 * This is the ONLY file that makes HTTP calls to Trino. The PORT (trino-deps.ts)
 * is driver-agnostic; this adapter is injected by the composition root.
 *
 * Trino REST API flow:
 *   POST /v1/statement  → { id, nextUri?, columns?, data?, error? }
 *   GET  <nextUri>      → repeat until nextUri is absent
 * Data is returned as Array<Array<unknown>>; columns gives column names.
 * Rows are converted to Record<string, unknown> using column metadata.
 *
 * PARAMETER SUBSTITUTION: Trino's REST API does not support `?` placeholders natively.
 * Parameters are substituted client-side before the SQL is sent:
 *   - UUID / string → single-quoted with apostrophes doubled (SQL-safe)
 *   - number / bigint → bare numeric (verified finite)
 *   - boolean → TRUE / FALSE literal
 *   - null / undefined → NULL literal
 * INVARIANT: only seam-controlled values (brand_id UUIDs, numeric window args) should
 * be passed as params. Arbitrary user input MUST NOT flow through this substitution.
 *
 * Requires Node.js >= 18 (global fetch). Fails loud at pool-creation time if absent.
 */

import type { TrinoPool } from './trino-deps.js';

// ── Config ─────────────────────────────────────────────────────────────────────

export interface TrinoAdapterConfig {
  /** Base URL of the Trino coordinator, e.g. 'http://trino:8080'. */
  readonly baseUrl: string;
  /** Trino catalog to set via X-Trino-Catalog header, e.g. 'iceberg'. */
  readonly catalog: string;
  /** Trino schema to set via X-Trino-Schema header, e.g. 'brain_bronze'. */
  readonly schema: string;
  /** Trino user to present via X-Trino-User (not authentication; cluster auth is separate). */
  readonly user: string;
  /** Max poll iterations before aborting a long-running query (default 120). */
  readonly maxPolls?: number;
  /** Milliseconds between polls (default 500). */
  readonly pollIntervalMs?: number;
}

// ── Internal types ─────────────────────────────────────────────────────────────

interface TrinoColumn {
  name: string;
  type: string;
}

interface TrinoResponse {
  id?: string;
  nextUri?: string;
  columns?: TrinoColumn[];
  data?: Array<Array<unknown>>;
  error?: { message: string; errorCode: number; errorType: string };
  stats?: { state: string };
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
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

// ── Safe param substitution ────────────────────────────────────────────────────

/**
 * Substitute `?` placeholders in Trino SQL with safely-escaped literal values.
 * Only seam-controlled values (brand_id UUID, numeric args) are expected here.
 */
function substituteParams(sql: string, params: unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    if (i >= params.length) {
      throw new Error(
        `[trino-adapter] not enough params for query placeholders — ` +
          `placeholder ${i + 1} has no matching param (${params.length} provided)`,
      );
    }
    const p = params[i++];
    if (p === null || p === undefined) return 'NULL';
    if (typeof p === 'bigint') return p.toString();
    if (typeof p === 'number') {
      if (!Number.isFinite(p)) throw new Error(`[trino-adapter] non-finite numeric param: ${p}`);
      return String(p);
    }
    if (typeof p === 'boolean') return p ? 'TRUE' : 'FALSE';
    if (typeof p === 'string') {
      // Escape single quotes by doubling — standard SQL escaping, safe for UUIDs.
      return `'${p.replace(/'/g, "''")}'`;
    }
    throw new Error(`[trino-adapter] unsupported param type '${typeof p}' at index ${i - 1}`);
  });
}

// ── Adapter factory ────────────────────────────────────────────────────────────

/**
 * Create a TrinoPool backed by the Trino HTTP REST API.
 * Inject this at the composition root; pass as the first arg to withTrinoBrand.
 *
 * @throws if global fetch is unavailable (requires Node.js >= 18).
 */
export function createTrinoPool(config: TrinoAdapterConfig): TrinoPool {
  const { baseUrl, catalog, schema, user, maxPolls = 120, pollIntervalMs = 500 } = config;

  // Validate global fetch at pool-creation time (fail loud, not at first query).
  const globalFetch = (globalThis as { fetch?: MinimalFetch }).fetch;
  if (!globalFetch) {
    throw new Error(
      '[trino-adapter] globalThis.fetch is not available — createTrinoPool requires Node.js >= 18',
    );
  }
  const doFetch: MinimalFetch = globalFetch;

  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const finalSql = params.length > 0 ? substituteParams(sql, params) : sql;

      const baseHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Trino-User': user,
        'X-Trino-Catalog': catalog,
        'X-Trino-Schema': schema,
      };

      // POST the SQL to /v1/statement
      const postRes = await doFetch(`${baseUrl}/v1/statement`, {
        method: 'POST',
        headers: baseHeaders,
        body: finalSql,
      });

      if (!postRes.ok) {
        throw new Error(
          `[trino-adapter] POST /v1/statement failed: HTTP ${postRes.status} ${postRes.statusText}`,
        );
      }

      let resp = (await postRes.json()) as TrinoResponse;

      // Accumulate columns + data pages
      let columns: TrinoColumn[] | undefined = resp.columns;
      const allData: Array<Array<unknown>> = resp.data ? [...resp.data] : [];

      // Poll nextUri until exhausted or error
      let polls = 0;
      while (resp.nextUri && polls < maxPolls) {
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
        const pollRes = await doFetch(resp.nextUri);
        if (!pollRes.ok) {
          throw new Error(
            `[trino-adapter] Trino poll failed: HTTP ${pollRes.status} ${pollRes.statusText} — ` +
              `query id ${resp.id ?? 'unknown'}`,
          );
        }
        resp = (await pollRes.json()) as TrinoResponse;
        if (resp.columns && !columns) columns = resp.columns;
        if (resp.data) allData.push(...resp.data);
        polls++;
      }

      if (resp.error) {
        throw new Error(
          `[trino-adapter] Trino query error (code ${resp.error.errorCode}): ${resp.error.message}`,
        );
      }

      if (!columns || allData.length === 0) return [] as T[];

      // Convert array-of-arrays → array-of-objects using column names
      const colNames = columns.map((c) => c.name);
      return allData.map((row) => {
        const obj: Record<string, unknown> = {};
        colNames.forEach((col, idx) => {
          obj[col] = row[idx];
        });
        return obj as T;
      });
    },
  };
}
