/**
 * identity-export-dedupe.test.ts — the conflict-key collapse that keeps the batch UPSERT well-formed.
 *
 * Regression lock for "ON CONFLICT DO UPDATE command cannot affect row a second time": a fresh
 * anon→customer merge makes Neo4j's ALIAS_OF resolution emit the SAME (brand_id, type, hash) twice, which
 * PG rejects inside one INSERT ... ON CONFLICT. dedupeByKey must collapse those to one row per key, and
 * betterEdge must keep the ACTIVE edge over a tombstone, then the newest created_at.
 */
import { describe, it, expect } from 'vitest';
import { dedupeByKey, betterEdge } from '../jobs/identity-export/run.js';

const edge = (o: Partial<{ brand_id: string; identifier_type: string; identifier_value: string; brain_id: string; tier: string | null; is_active: boolean; created_at: number | null }>) => ({
  brand_id: 'b1', identifier_type: 'anon_id', identifier_value: 'hashA', brain_id: 'brain1',
  tier: 'medium', is_active: true, created_at: 1, ...o,
});

describe('identity-export dedupeByKey', () => {
  it('collapses duplicate conflict keys to exactly one row (the ON CONFLICT-twice trigger)', () => {
    const rows = [
      edge({ identifier_value: 'hashA', brain_id: 'brainX', created_at: 10 }),
      edge({ identifier_value: 'hashA', brain_id: 'brainX', created_at: 20 }), // same key (post-merge fan-in)
      edge({ identifier_value: 'hashB', brain_id: 'brainY' }),
    ];
    const out = dedupeByKey(rows, (e) => `${e.brand_id} ${e.identifier_type} ${e.identifier_value}`, betterEdge);
    expect(out).toHaveLength(2); // one per (brand, type, value)
    const keys = out.map((e) => e.identifier_value).sort();
    expect(keys).toEqual(['hashA', 'hashB']);
  });

  it('keeps distinct keys and does not merge different identifier types with the same value', () => {
    const rows = [
      edge({ identifier_type: 'anon_id', identifier_value: 'v' }),
      edge({ identifier_type: 'pre_hashed_email', identifier_value: 'v' }),
    ];
    const out = dedupeByKey(rows, (e) => `${e.brand_id} ${e.identifier_type} ${e.identifier_value}`, betterEdge);
    expect(out).toHaveLength(2);
  });
});

describe('identity-export betterEdge', () => {
  it('prefers the ACTIVE edge over a tombstone for the same key', () => {
    const active = edge({ is_active: true, created_at: 1 });
    const tombstone = edge({ is_active: false, created_at: 999 });
    expect(betterEdge(active, tombstone).is_active).toBe(true);
    expect(betterEdge(tombstone, active).is_active).toBe(true); // order-independent
  });

  it('among same-active edges, keeps the newest created_at', () => {
    const older = edge({ is_active: true, created_at: 5 });
    const newer = edge({ is_active: true, created_at: 50 });
    expect(betterEdge(older, newer).created_at).toBe(50);
    expect(betterEdge(newer, older).created_at).toBe(50);
  });
});
