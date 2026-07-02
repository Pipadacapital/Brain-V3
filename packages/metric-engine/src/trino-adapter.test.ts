/**
 * trino-adapter.test.ts — Trino HTTP adapter fail-safe behavior (AUD-PERF-008 / AUD-ARCH-013).
 *
 * The adapter must NEVER return a truncated result set as if it were complete:
 *   - poll-budget exhaustion (nextUri still set after maxPolls) → THROW, and cancel the
 *     server-side query via DELETE nextUri (release the coordinator slot);
 *   - a failed poll → THROW + DELETE nextUri;
 *   - Trino error payload → THROW (existing behavior, kept).
 * Every HTTP request carries an AbortSignal timeout so a hung coordinator cannot pin the caller.
 *
 * fetch is stubbed via vi.stubGlobal BEFORE createTrinoPool (the adapter captures fetch at
 * pool-creation time).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTrinoPool } from './trino-adapter.js';

interface RecordedCall {
  url: string;
  method: string;
  signal: unknown;
}

/** Build a fetch stub that replays the given JSON bodies in order (all HTTP 200). */
function fetchStub(bodies: unknown[]): { fetch: (url: string, init?: { method?: string; signal?: unknown }) => Promise<unknown>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetch = async (url: string, init?: { method?: string; signal?: unknown }) => {
    calls.push({ url, method: init?.method ?? 'GET', signal: init?.signal });
    if (init?.method === 'DELETE') {
      return { ok: true, status: 204, statusText: 'No Content', json: async () => ({}) };
    }
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  };
  return { fetch, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTrinoPool — truncation fails loud (AUD-PERF-008)', () => {
  it('throws when maxPolls is exhausted with nextUri still set, and DELETEs the query', async () => {
    // Every response keeps nextUri set → the poll budget can never drain the query.
    const page = {
      id: 'q1',
      nextUri: 'http://trino:8080/v1/statement/executing/q1/x/1',
      columns: [{ name: 'c', type: 'bigint' }],
      data: [[1]],
    };
    const { fetch, calls } = fetchStub([page]);
    vi.stubGlobal('fetch', fetch);

    const pool = createTrinoPool({ baseUrl: 'http://trino:8080', user: 't', maxPolls: 3, pollIntervalMs: 1 });
    await expect(pool.query('SELECT 1')).rejects.toThrow(/poll budget exhausted/);

    // The abandoned query must be cancelled server-side (DELETE nextUri), never left running.
    const del = calls.filter((c) => c.method === 'DELETE');
    expect(del.length).toBe(1);
    expect(del[0]!.url).toBe(page.nextUri);
  });

  it('never resolves with partial rows on truncation (the caller cannot cache them)', async () => {
    const page = { id: 'q2', nextUri: 'http://t/next', columns: [{ name: 'c', type: 'bigint' }], data: [[1], [2]] };
    const { fetch } = fetchStub([page]);
    vi.stubGlobal('fetch', fetch);
    const pool = createTrinoPool({ baseUrl: 'http://t', user: 't', maxPolls: 1, pollIntervalMs: 1 });
    let resolved: unknown = 'not-resolved';
    await pool.query('SELECT 1').then(
      (rows) => { resolved = rows; },
      () => { /* expected rejection */ },
    );
    expect(resolved).toBe('not-resolved');
  });

  it('cancels the in-flight query when a poll fails', async () => {
    const calls: RecordedCall[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; signal?: unknown }) => {
      calls.push({ url, method: init?.method ?? 'GET', signal: init?.signal });
      if (init?.method === 'DELETE') return { ok: true, status: 204, statusText: '', json: async () => ({}) };
      n++;
      if (n === 1) return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'q3', nextUri: 'http://t/poll-1' }) };
      return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) };
    });
    const pool = createTrinoPool({ baseUrl: 'http://t', user: 't', maxPolls: 5, pollIntervalMs: 1 });
    await expect(pool.query('SELECT 1')).rejects.toThrow(/Trino poll failed/);
    expect(calls.some((c) => c.method === 'DELETE' && c.url === 'http://t/poll-1')).toBe(true);
  });

  it('returns complete results untouched when the query drains within budget', async () => {
    const { fetch } = fetchStub([
      { id: 'q4', nextUri: 'http://t/1' },
      { id: 'q4', nextUri: 'http://t/2', columns: [{ name: 'a', type: 'bigint' }], data: [[1]] },
      { id: 'q4', columns: [{ name: 'a', type: 'bigint' }], data: [[2]] },
    ]);
    // Replay pages strictly in order (fetchStub repeats the last page — give each its own body).
    vi.stubGlobal('fetch', fetch);
    const pool = createTrinoPool({ baseUrl: 'http://t', user: 't', maxPolls: 10, pollIntervalMs: 1 });
    const rows = await pool.query<{ a: number }>('SELECT 1');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('surfaces a Trino error payload as a throw (existing contract)', async () => {
    const { fetch } = fetchStub([
      { id: 'q5', nextUri: 'http://t/1' },
      { id: 'q5', error: { message: 'line 1: mismatched input', errorCode: 1, errorType: 'USER_ERROR' } },
    ]);
    vi.stubGlobal('fetch', fetch);
    const pool = createTrinoPool({ baseUrl: 'http://t', user: 't', maxPolls: 10, pollIntervalMs: 1 });
    await expect(pool.query('SELEC 1')).rejects.toThrow(/mismatched input/);
  });

  it('attaches an abort-timeout signal to every request (POST + polls)', async () => {
    const { fetch, calls } = fetchStub([
      { id: 'q6', nextUri: 'http://t/1' },
      { id: 'q6', columns: [{ name: 'a', type: 'bigint' }], data: [[1]] },
    ]);
    vi.stubGlobal('fetch', fetch);
    const pool = createTrinoPool({ baseUrl: 'http://t', user: 't', maxPolls: 10, pollIntervalMs: 1, fetchTimeoutMs: 5000 });
    await pool.query('SELECT 1');
    // Node >= 18 has AbortSignal.timeout — every non-DELETE request must carry a signal.
    for (const c of calls.filter((c) => c.method !== 'DELETE')) {
      expect(c.signal, `request ${c.url} missing timeout signal`).toBeDefined();
    }
  });
});
