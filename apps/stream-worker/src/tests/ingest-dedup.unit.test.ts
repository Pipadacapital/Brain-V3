/**
 * ingest-dedup.unit.test.ts — Unit tests for the ADR-0012 durable dedup gate
 * (data_plane.ingest_dedup / IngestDedupRepository).
 *
 * Asserts, against a mocked pg.PoolClient (no live DB):
 *   1. filterUnseenEventIds returns ONLY the ids not already in the dedup index (the new ones),
 *      and issues the ANY($2::uuid[]) SELECT scoped by brand_id.
 *   2. markEventIdsSeen issues the INSERT … ON CONFLICT DO NOTHING for the produced ids.
 *   3. Empty arrays are no-ops on BOTH helpers (no query at all).
 *   4. GUC DISCIPLINE: each helper wraps its query in BEGIN → set_config(app.current_brand_id,
 *      brand, is_local=true) → query → COMMIT, and ROLLBACKs on error. A transaction-local
 *      set_config OUTSIDE a transaction is a silent no-op, and on a reused pooled connection the
 *      expired GUC reads back as '' (not NULL) — the FORCE-RLS policy's uuid cast then throws
 *      `invalid input syntax for type uuid: ""` on every repull tick (seen live 2026-07-15).
 *      The helpers therefore OWN the transaction; callers must not rely on a pre-set GUC.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PoolClient, QueryResult } from 'pg';
import {
  filterUnseenEventIds,
  markEventIdsSeen,
} from '../infrastructure/pg/IngestDedupRepository.js';

type QueryCall = { sql: string; params: unknown[] };

const BRAND = 'e43be5e6-0000-4000-8000-000000000001';
const EV = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

/**
 * Mock PoolClient whose dedup SELECT returns the given "already-seen" rows; records every query
 * call. BEGIN/COMMIT/ROLLBACK/set_config are answered with empty results (like a real client).
 */
function buildMockClient(
  seenRows: string[],
  opts?: { failDedupQuery?: boolean },
): { client: PoolClient; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = typeof sql === 'string' ? sql : String(sql);
      calls.push({ sql: text, params: params ?? [] });
      if (text.includes('data_plane.ingest_dedup')) {
        if (opts?.failDedupQuery) throw new Error('boom');
        if (text.trimStart().toUpperCase().startsWith('SELECT')) {
          return {
            rowCount: seenRows.length,
            rows: seenRows.map((event_id) => ({ event_id })),
            command: 'SELECT', oid: 0, fields: [],
          } as QueryResult;
        }
        return { rowCount: 0, rows: [], command: 'INSERT', oid: 0, fields: [] } as QueryResult;
      }
      return { rowCount: 0, rows: [], command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { client, calls };
}

/** The dedup-table query (SELECT or INSERT) among the recorded calls. */
function dedupCall(calls: QueryCall[]): QueryCall | undefined {
  return calls.find((c) => c.sql.includes('data_plane.ingest_dedup'));
}

/** Assert the BEGIN → set_config(local, brand) → <dedup query> → COMMIT envelope. */
function expectBrandTxnEnvelope(calls: QueryCall[], brand: string): void {
  const sqls = calls.map((c) => c.sql.trim().toUpperCase());
  const beginIdx = sqls.indexOf('BEGIN');
  const commitIdx = sqls.indexOf('COMMIT');
  const gucIdx = calls.findIndex((c) => c.sql.includes(`set_config('app.current_brand_id'`));
  const queryIdx = calls.findIndex((c) => c.sql.includes('data_plane.ingest_dedup'));

  expect(beginIdx).toBeGreaterThanOrEqual(0);
  expect(gucIdx).toBeGreaterThan(beginIdx);
  expect(queryIdx).toBeGreaterThan(gucIdx);
  expect(commitIdx).toBeGreaterThan(queryIdx);
  // Transaction-local set (is_local=true) with the enumerated brand as the parameter.
  expect(calls[gucIdx]?.sql).toContain('true');
  expect(calls[gucIdx]?.params[0]).toBe(brand);
}

// ── filterUnseenEventIds ─────────────────────────────────────────────────────

describe('filterUnseenEventIds', () => {
  it('returns only the ids NOT already ingested (the new ones)', async () => {
    // ids 1 & 2 already seen → only 3 is new.
    const { client, calls } = buildMockClient([EV(1), EV(2)]);
    const unseen = await filterUnseenEventIds(client, BRAND, [EV(1), EV(2), EV(3)]);

    expect([...unseen]).toEqual([EV(3)]);

    const q = dedupCall(calls);
    expect(q?.sql).toContain('event_id = ANY($2::uuid[])');
    expect(q?.params[0]).toBe(BRAND);
    expect(q?.params[1]).toEqual([EV(1), EV(2), EV(3)]);
  });

  it('returns ALL ids when none are already ingested', async () => {
    const { client } = buildMockClient([]);
    const unseen = await filterUnseenEventIds(client, BRAND, [EV(1), EV(2)]);
    expect([...unseen].sort()).toEqual([EV(1), EV(2)].sort());
  });

  it('is a no-op (empty set, no query) for an empty input array', async () => {
    const { client, calls } = buildMockClient([EV(1)]);
    const unseen = await filterUnseenEventIds(client, BRAND, []);
    expect(unseen.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('sets the brand GUC transaction-locally INSIDE its own BEGIN/COMMIT (RLS discipline)', async () => {
    const { client, calls } = buildMockClient([]);
    await filterUnseenEventIds(client, BRAND, [EV(1)]);
    expectBrandTxnEnvelope(calls, BRAND);
  });

  it('ROLLBACKs (not COMMITs) and rethrows when the query fails', async () => {
    const { client, calls } = buildMockClient([], { failDedupQuery: true });
    await expect(filterUnseenEventIds(client, BRAND, [EV(1)])).rejects.toThrow('boom');
    const sqls = calls.map((c) => c.sql.trim().toUpperCase());
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });
});

// ── markEventIdsSeen ─────────────────────────────────────────────────────────

describe('markEventIdsSeen', () => {
  it('issues an INSERT … ON CONFLICT DO NOTHING for the produced ids', async () => {
    const { client, calls } = buildMockClient([]);
    await markEventIdsSeen(client, BRAND, [EV(1), EV(2)]);

    const q = dedupCall(calls);
    const sql = q?.sql.toUpperCase() ?? '';
    expect(sql).toContain('INSERT INTO DATA_PLANE.INGEST_DEDUP');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('UNNEST($2::UUID[])');
    expect(q?.params[0]).toBe(BRAND);
    expect(q?.params[1]).toEqual([EV(1), EV(2)]);
  });

  it('is a no-op (no query) for an empty input array', async () => {
    const { client, calls } = buildMockClient([]);
    await markEventIdsSeen(client, BRAND, []);
    expect(calls).toHaveLength(0);
  });

  it('sets the brand GUC transaction-locally INSIDE its own BEGIN/COMMIT (RLS discipline)', async () => {
    const { client, calls } = buildMockClient([]);
    await markEventIdsSeen(client, BRAND, [EV(1)]);
    expectBrandTxnEnvelope(calls, BRAND);
  });
});
