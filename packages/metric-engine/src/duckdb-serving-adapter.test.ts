/**
 * duckdb-serving-adapter.test.ts — serving HTTP adapter error taxonomy + param guard
 * (AUD-ARCH-013, ported from trino-adapter.test.ts).
 *
 * The adapter is a SINGLE POST (no polling — the Trino truncation class does not exist
 * here). What must hold instead:
 *   - HTTP status → failure class: 400 parse/binder, 429 admission, 504 statement
 *     timeout, 500 internal — all THROW with the server's message preserved (the
 *     isServingTierUnavailable classifier keys on "does not exist" / "not found");
 *   - 503 not_ready is retried exactly ONCE (epoch rotation / startup), then thrown;
 *   - every request carries an AbortSignal timeout so a hung replica cannot pin the caller;
 *   - substituteParams keeps the both-direction placeholder/param count guard, and the
 *     timestamp rule emits a TIMESTAMPTZ literal (UTC serving session — spike gate e).
 *
 * fetch is stubbed via vi.stubGlobal BEFORE createDuckDbServingPool (the adapter captures
 * fetch at pool-creation time).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createDuckDbServingPool, substituteParams } from './duckdb-serving-adapter.js';

interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
  signal: unknown;
}

interface StubResponse {
  status: number;
  body: unknown;
}

/** Build a fetch stub that replays the given responses in order (last one repeats). */
function fetchStub(responses: StubResponse[]): {
  fetch: (url: string, init?: { method?: string; body?: string; signal?: unknown }) => Promise<unknown>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetch = async (url: string, init?: { method?: string; body?: string; signal?: unknown }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body, signal: init?.signal });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: `status-${r.status}`,
      json: async () => r.body,
    };
  };
  return { fetch, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDuckDbServingPool — single-POST query + result mapping', () => {
  it('POSTs {sql, timeout_ms} to /v1/query and maps columns+data to row objects', async () => {
    const { fetch, calls } = fetchStub([
      { status: 200, body: { columns: [{ name: 'a', type: 'BIGINT' }, { name: 'b', type: 'VARCHAR' }], data: [[1, 'x'], [2, 'y']] } },
    ]);
    vi.stubGlobal('fetch', fetch);

    const pool = createDuckDbServingPool({ baseUrl: 'http://serving:8091', queryTimeoutMs: 25_000 });
    const rows = await pool.query<{ a: number; b: string }>('SELECT 1');

    expect(rows).toEqual([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('http://serving:8091/v1/query');
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ sql: 'SELECT 1', timeout_ms: 25_000 });
  });

  it('returns [] on an empty result (columns present, no data)', async () => {
    const { fetch } = fetchStub([{ status: 200, body: { columns: [{ name: 'a', type: 'BIGINT' }], data: [] } }]);
    vi.stubGlobal('fetch', fetch);
    const pool = createDuckDbServingPool({ baseUrl: 'http://s' });
    expect(await pool.query('SELECT 1 WHERE FALSE')).toEqual([]);
  });

  it('attaches an abort-timeout signal to every request', async () => {
    const { fetch, calls } = fetchStub([{ status: 200, body: { columns: [{ name: 'a', type: 'BIGINT' }], data: [[1]] } }]);
    vi.stubGlobal('fetch', fetch);
    const pool = createDuckDbServingPool({ baseUrl: 'http://s', fetchTimeoutMs: 5000 });
    await pool.query('SELECT 1');
    // Node >= 18 has AbortSignal.timeout — every request must carry a signal.
    for (const c of calls) {
      expect(c.signal, `request ${c.url} missing timeout signal`).toBeDefined();
    }
  });
});

describe('createDuckDbServingPool — error taxonomy (status → failure class)', () => {
  it('400 → parse/binder throw with the server message preserved (classifier depends on it)', async () => {
    const { fetch, calls } = fetchStub([
      { status: 400, body: { error: { message: "Table with name mv_missing does not exist", code: 'binder' } } },
    ]);
    vi.stubGlobal('fetch', fetch);
    const pool = createDuckDbServingPool({ baseUrl: 'http://s' });
    await expect(pool.query('SELECT * FROM brain_serving.mv_missing')).rejects.toThrow(
      /parse\/binder.*does not exist/s,
    );
    expect(calls.length).toBe(1); // NOT retried
  });

  it('429 → admission-rejected throw (caller backs off; never retried here)', async () => {
    const { fetch, calls } = fetchStub([{ status: 429, body: { error: { message: 'admission queue full' } } }]);
    vi.stubGlobal('fetch', fetch);
    const pool = createDuckDbServingPool({ baseUrl: 'http://s' });
    await expect(pool.query('SELECT 1')).rejects.toThrow(/admission rejected/);
    expect(calls.length).toBe(1);
  });

  it('504 → statement-timeout throw (server watchdog fired; never retried)', async () => {
    const { fetch, calls } = fetchStub([{ status: 504, body: { error: { message: 'statement timeout after 25000ms' } } }]);
    vi.stubGlobal('fetch', fetch);
    const pool = createDuckDbServingPool({ baseUrl: 'http://s' });
    await expect(pool.query('SELECT 1')).rejects.toThrow(/statement timeout/);
    expect(calls.length).toBe(1);
  });

  it('503 → retried exactly ONCE, succeeding when the replica becomes ready', async () => {
    const { fetch, calls } = fetchStub([
      { status: 503, body: { error: { message: 'not_ready: applying views' } } },
      { status: 200, body: { columns: [{ name: 'a', type: 'BIGINT' }], data: [[7]] } },
    ]);
    vi.stubGlobal('fetch', fetch);
    const pool = createDuckDbServingPool({ baseUrl: 'http://s', notReadyRetryDelayMs: 1 });
    expect(await pool.query('SELECT 1')).toEqual([{ a: 7 }]);
    expect(calls.length).toBe(2);
  });

  it('503 twice → throws not-ready (one retry only — the LB should route elsewhere)', async () => {
    const { fetch, calls } = fetchStub([{ status: 503, body: { error: { message: 'not_ready' } } }]);
    vi.stubGlobal('fetch', fetch);
    const pool = createDuckDbServingPool({ baseUrl: 'http://s', notReadyRetryDelayMs: 1 });
    await expect(pool.query('SELECT 1')).rejects.toThrow(/replica not ready/);
    expect(calls.length).toBe(2);
  });

  it('500 → internal-error throw; tolerates the FastAPI {detail} error envelope', async () => {
    const { fetch } = fetchStub([{ status: 500, body: { detail: 'unexpected serving failure' } }]);
    vi.stubGlobal('fetch', fetch);
    const pool = createDuckDbServingPool({ baseUrl: 'http://s' });
    await expect(pool.query('SELECT 1')).rejects.toThrow(/HTTP 500.*unexpected serving failure/s);
  });

  it('a 200 carrying an error envelope is a contract violation → throws (never renders empty)', async () => {
    const { fetch } = fetchStub([{ status: 200, body: { error: { message: 'half-failed' } } }]);
    vi.stubGlobal('fetch', fetch);
    const pool = createDuckDbServingPool({ baseUrl: 'http://s' });
    await expect(pool.query('SELECT 1')).rejects.toThrow(/half-failed/);
  });
});

describe('substituteParams — placeholder/param count guarded BOTH directions (AUD-ARCH-013)', () => {
  it('substitutes matched placeholders positionally', () => {
    expect(substituteParams('SELECT * FROM t WHERE a = ? AND brand_id = ?', [7, 'b-1'])).toBe(
      "SELECT * FROM t WHERE a = 7 AND brand_id = 'b-1'",
    );
  });

  it('throws when the SQL has MORE placeholders than params (underflow)', () => {
    expect(() => substituteParams('SELECT ? , ?', ['only-one'])).toThrow(/not enough params/);
  });

  it('throws when MORE params than placeholders are provided (overflow — misaligned binding)', () => {
    // The seam appends brandId LAST — if a placeholder is missing, brandId silently never binds.
    expect(() => substituteParams('SELECT * FROM t WHERE a = ?', [7, 'brand-uuid'])).toThrow(
      /placeholder\/param count mismatch/,
    );
  });

  it('throws on zero placeholders with params present (the dropped-predicate shape)', () => {
    expect(() => substituteParams('SELECT * FROM t', ['brand-uuid'])).toThrow(
      /placeholder\/param count mismatch/,
    );
  });

  it('emits a DATE literal for date-shaped strings', () => {
    expect(substituteParams('WHERE d >= ?', ['2026-07-01'])).toBe("WHERE d >= DATE '2026-07-01'");
  });

  it('emits a TIMESTAMPTZ literal for timestamp-shaped strings (T / fractional / Z normalized)', () => {
    // DuckDB serving sessions pin TimeZone='UTC' — a zoneless TIMESTAMPTZ literal is UTC.
    expect(substituteParams('WHERE ts >= ?', ['2026-07-16T09:00:00.123Z'])).toBe(
      "WHERE ts >= TIMESTAMPTZ '2026-07-16 09:00:00'",
    );
    expect(substituteParams('WHERE ts >= ?', ['2026-07-16 09:00:00'])).toBe(
      "WHERE ts >= TIMESTAMPTZ '2026-07-16 09:00:00'",
    );
  });

  it('escapes single quotes in plain string params (SQL-safe)', () => {
    expect(substituteParams('WHERE s = ?', ["o'brien"])).toBe("WHERE s = 'o''brien'");
  });

  it('renders bigint / boolean / null literals', () => {
    expect(substituteParams('VALUES (?, ?, ?)', [9007199254740993n, true, null])).toBe(
      'VALUES (9007199254740993, TRUE, NULL)',
    );
  });

  it('rejects non-finite numbers', () => {
    expect(() => substituteParams('WHERE n = ?', [Number.NaN])).toThrow(/non-finite/);
  });
});
