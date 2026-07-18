/**
 * ADR-0015 WS3 — PgIdentityUnmergeDirtyRepository unit tests.
 *
 * The admin unmerge's direct PG dirty-queue writer (replaces the retired identity.unmerged.v1
 * Kafka publish). Asserts the EXACT insert shape the retired RestitchDirty/JourneyReversionDirty
 * consumers would have produced for an unmerge event, the publisher-parity guard, the degenerate
 * self-unmerge dedupe, the provenance fallback, and the fail-open contract.
 */
import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { PgIdentityUnmergeDirtyRepository } from './IdentityUnmergeDirtyRepository.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const SURVIVOR = 'aaaaaaaa-0000-0000-0000-000000000001';
const RESTORED = 'bbbbbbbb-0000-0000-0000-000000000002';
const MERGE_ID = 'cccccccc-0000-0000-0000-000000000003';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeFakePool(opts?: { failWith?: Error }) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (text: string, values: unknown[]) => {
      if (opts?.failWith) throw opts.failWith;
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    }),
  };
  return { queries, pool: pool as unknown as pg.Pool };
}

const makeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const baseEvt = {
  brandId: BRAND,
  restoredBrainId: RESTORED,
  survivorBrainId: SURVIVOR,
  mergeEventId: MERGE_ID,
  actor: 'operator-1',
  reason: 'two distinct people',
  correlationId: 'req-1',
};

describe('PgIdentityUnmergeDirtyRepository (ADR-0015 WS3)', () => {
  it('writes {survivor, restored} to BOTH queues with the exact consumer-parity shape', async () => {
    const { queries, pool } = makeFakePool();
    const log = makeLog();
    const repo = new PgIdentityUnmergeDirtyRepository(pool, log);

    await repo.markUnmerged(baseEvt);

    expect(queries).toHaveLength(2);
    const [restitch, reversion] = queries as [typeof queries[0], typeof queries[0]];

    // ops.restitch_pending: brain_id-grain (an unmerge carries no identifier hashes — AMD-09),
    // trigger identity.unmerged, provenance = the reversed merge id. UNNEST + upsert (idempotent).
    expect(restitch.text).toContain('INSERT INTO ops.restitch_pending');
    expect(restitch.text).toContain('ON CONFLICT (brand_id, dirty_kind, dirty_key) DO UPDATE');
    expect(restitch.values).toEqual([
      [BRAND, BRAND],
      ['brain_id', 'brain_id'],
      [SURVIVOR, RESTORED],
      ['identity.unmerged', 'identity.unmerged'],
      [MERGE_ID, MERGE_ID],
    ]);

    // ops.journey_reversion_pending: both brains rebuilt as N+1, cause='unmerge'.
    expect(reversion.text).toContain('INSERT INTO ops.journey_reversion_pending');
    expect(reversion.text).toContain('ON CONFLICT (brand_id, brain_id) DO UPDATE');
    expect(reversion.values).toEqual([
      [BRAND, BRAND],
      [SURVIVOR, RESTORED],
      ['unmerge', 'unmerge'],
      ['identity.unmerged', 'identity.unmerged'],
      [MERGE_ID, MERGE_ID],
    ]);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('collapses a degenerate self-unmerge (survivor === restored) to a single entry per queue', async () => {
    const { queries, pool } = makeFakePool();
    const repo = new PgIdentityUnmergeDirtyRepository(pool, makeLog());

    await repo.markUnmerged({ ...baseEvt, survivorBrainId: RESTORED });

    expect(queries).toHaveLength(2);
    expect(queries[0]!.values).toEqual([
      [BRAND],
      ['brain_id'],
      [RESTORED],
      ['identity.unmerged'],
      [MERGE_ID],
    ]);
    expect(queries[1]!.values).toEqual([[BRAND], [RESTORED], ['unmerge'], ['identity.unmerged'], [MERGE_ID]]);
  });

  it('skips entirely (publisher-parity guard) when the survivor is missing or malformed', async () => {
    const { queries, pool } = makeFakePool();
    const log = makeLog();
    const repo = new PgIdentityUnmergeDirtyRepository(pool, log);

    await repo.markUnmerged({ ...baseEvt, survivorBrainId: undefined });
    await repo.markUnmerged({ ...baseEvt, survivorBrainId: 'not-a-uuid' });

    expect(queries).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('skips entirely when the brand or restored id is malformed (never a tenantless row — I-S01)', async () => {
    const { queries, pool } = makeFakePool();
    const log = makeLog();
    const repo = new PgIdentityUnmergeDirtyRepository(pool, log);

    await repo.markUnmerged({ ...baseEvt, brandId: 'nope' });
    await repo.markUnmerged({ ...baseEvt, restoredBrainId: 'nope' });

    expect(queries).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('falls back to a minted UUID for source_event_id when the merge id is absent', async () => {
    const { queries, pool } = makeFakePool();
    const repo = new PgIdentityUnmergeDirtyRepository(pool, makeLog());

    await repo.markUnmerged({ ...baseEvt, mergeEventId: undefined });

    expect(queries).toHaveLength(2);
    const sourceIds = queries[0]!.values[4] as string[];
    expect(sourceIds).toHaveLength(2);
    expect(sourceIds[0]).toMatch(UUID_RE);
    expect(sourceIds[0]).toBe(sourceIds[1]); // one causation id for the whole mutation
    expect(queries[1]!.values[4]).toEqual(sourceIds); // both queues share the same provenance
  });

  it('is FAIL-OPEN: a PG error is logged and swallowed (the unmerge already committed to the SoR)', async () => {
    const { pool } = makeFakePool({ failWith: new Error('connection refused') });
    const log = makeLog();
    const repo = new PgIdentityUnmergeDirtyRepository(pool, log);

    await expect(repo.markUnmerged(baseEvt)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
