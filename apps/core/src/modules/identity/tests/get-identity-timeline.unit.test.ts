/**
 * get-identity-timeline.unit.test — the apps/core read-surface for a brain_id's decision history.
 *
 * Pure unit tests with a fake IdentityTimelineReader (no DB):
 *   1. Maps the reader's audit rows → chronological entries with a stable sequence + ISO timestamps.
 *   2. Surfaces merge rows with merge_id + related_brain_id + rule_version (hash-only — types only).
 *   3. Fails closed (state 'invalid') on a malformed brain_id — never queries.
 *   4. Returns an honest empty timeline (found, count 0) when the ledger has no rows.
 */
import { describe, it, expect } from 'vitest';
import { getIdentityTimeline } from '../internal/application/queries/get-identity-timeline.js';
import type {
  IdentityTimelineEventRow,
  IdentityTimelineReader,
} from '../internal/infrastructure/identity-timeline-reader.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const BRAIN = 'aaaaaaaa-0000-0000-0000-000000000001';
const MERGED = 'bbbbbbbb-0000-0000-0000-000000000002';
const MERGE_ID = 'cccccccc-0000-0000-0000-000000000003';

function fakeReader(rows: IdentityTimelineEventRow[]): IdentityTimelineReader {
  return { getIdentityTimeline: async () => rows };
}

describe('getIdentityTimeline', () => {
  it('maps audit rows to sequenced, ISO-stamped entries', async () => {
    const rows: IdentityTimelineEventRow[] = [
      { brain_id: BRAIN, action: 'mint', merge_id: null, related_brain_id: null, rule_version: 'v1-deterministic', identifier_types: ['email'], reason: null, decision_id: 'd1', occurred_at: new Date('2026-01-01T00:00:00.000Z') },
      { brain_id: BRAIN, action: 'merge', merge_id: MERGE_ID, related_brain_id: MERGED, rule_version: 'v1-deterministic', identifier_types: ['email', 'phone'], reason: null, decision_id: 'd2', occurred_at: new Date('2026-02-01T00:00:00.000Z') },
    ];
    const res = await getIdentityTimeline(BRAND, BRAIN, 'corr', { reader: fakeReader(rows) });
    expect(res.state).toBe('found');
    if (res.state !== 'found') return;
    expect(res.count).toBe(2);
    expect(res.entries.map((e) => e.sequence)).toEqual([0, 1]);
    expect(res.entries[0]!.occurred_at).toBe('2026-01-01T00:00:00.000Z');
    expect(res.entries[1]!.action).toBe('merge');
    expect(res.entries[1]!.merge_id).toBe(MERGE_ID);
    expect(res.entries[1]!.related_brain_id).toBe(MERGED);
    expect(res.entries[1]!.identifier_types).toEqual(['email', 'phone']);
  });

  it('fails closed on a malformed brain_id (state invalid)', async () => {
    const res = await getIdentityTimeline(BRAND, 'not-a-uuid', 'corr', { reader: fakeReader([]) });
    expect(res.state).toBe('invalid');
  });

  it('returns an honest empty timeline when the ledger has no rows', async () => {
    const res = await getIdentityTimeline(BRAND, BRAIN, 'corr', { reader: fakeReader([]) });
    expect(res.state).toBe('found');
    if (res.state !== 'found') return;
    expect(res.count).toBe(0);
    expect(res.entries).toEqual([]);
  });
});
