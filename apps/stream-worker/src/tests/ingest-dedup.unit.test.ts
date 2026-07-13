/**
 * ingest-dedup.unit.test.ts — Unit tests for the ADR-0012 durable dedup gate
 * (data_plane.ingest_dedup / IngestDedupRepository).
 *
 * Asserts, against a mocked pg.PoolClient (no live DB):
 *   1. filterUnseenEventIds returns ONLY the ids not already in the dedup index (the new ones),
 *      and issues the ANY($2::uuid[]) SELECT scoped by brand_id.
 *   2. markEventIdsSeen issues the INSERT … ON CONFLICT DO NOTHING for the produced ids.
 *   3. Empty arrays are no-ops on BOTH helpers (no query at all).
 *
 * The caller sets the brand GUC before invoking these (ingest_dedup has FORCE RLS); these helpers
 * take a client that already carries it — so the tests exercise the SQL, not the GUC discipline.
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
 * Mock PoolClient whose SELECT returns the given "already-seen" rows; records every query call.
 */
function buildMockClient(seenRows: string[]): { client: PoolClient; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql: typeof sql === 'string' ? sql : String(sql), params: params ?? [] });
      if (typeof sql === 'string' && sql.trimStart().toUpperCase().startsWith('SELECT')) {
        return {
          rowCount: seenRows.length,
          rows: seenRows.map((event_id) => ({ event_id })),
          command: 'SELECT', oid: 0, fields: [],
        } as QueryResult;
      }
      return { rowCount: 0, rows: [], command: 'INSERT', oid: 0, fields: [] } as QueryResult;
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { client, calls };
}

// ── filterUnseenEventIds ─────────────────────────────────────────────────────

describe('filterUnseenEventIds', () => {
  it('returns only the ids NOT already ingested (the new ones)', async () => {
    // ids 1 & 2 already seen → only 3 is new.
    const { client, calls } = buildMockClient([EV(1), EV(2)]);
    const unseen = await filterUnseenEventIds(client, BRAND, [EV(1), EV(2), EV(3)]);

    expect([...unseen]).toEqual([EV(3)]);

    // One SELECT, scoped by brand_id + ANY(uuid[]).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('data_plane.ingest_dedup');
    expect(calls[0]?.sql).toContain('event_id = ANY($2::uuid[])');
    expect(calls[0]?.params[0]).toBe(BRAND);
    expect(calls[0]?.params[1]).toEqual([EV(1), EV(2), EV(3)]);
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
});

// ── markEventIdsSeen ─────────────────────────────────────────────────────────

describe('markEventIdsSeen', () => {
  it('issues an INSERT … ON CONFLICT DO NOTHING for the produced ids', async () => {
    const { client, calls } = buildMockClient([]);
    await markEventIdsSeen(client, BRAND, [EV(1), EV(2)]);

    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql.toUpperCase() ?? '';
    expect(sql).toContain('INSERT INTO DATA_PLANE.INGEST_DEDUP');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('UNNEST($2::UUID[])');
    expect(calls[0]?.params[0]).toBe(BRAND);
    expect(calls[0]?.params[1]).toEqual([EV(1), EV(2)]);
  });

  it('is a no-op (no query) for an empty input array', async () => {
    const { client, calls } = buildMockClient([]);
    await markEventIdsSeen(client, BRAND, []);
    expect(calls).toHaveLength(0);
  });
});
