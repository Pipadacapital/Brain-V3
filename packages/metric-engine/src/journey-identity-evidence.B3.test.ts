// SPEC: B.3
/**
 * B3 — computeIdentityEvidence: the trace explainability read over the bi-temporal identity map.
 * Proves the brand-scoped seam (brand predicate injected, brainId binds first), the merge-provenance
 * derivation, hash-only PII (identifier_hash never selected), and honest-empty.
 */
import { describe, it, expect } from 'vitest';
import { computeIdentityEvidence } from './journey-identity-evidence.js';
import type { SilverPool } from './silver-deps.js';

const BRAND = '33333333-3333-4333-8333-333333333333';
const BRAIN = '44444444-4444-4444-8444-444444444444';

function fakePool(rows: Array<Record<string, unknown>>): SilverPool & { lastSql: string; lastParams: unknown[] } {
  const pool = {
    lastSql: '',
    lastParams: [] as unknown[],
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      pool.lastSql = sql;
      pool.lastParams = params;
      return rows as T[];
    },
  };
  return pool;
}

describe('B3 computeIdentityEvidence', () => {
  it('maps identifier_type + first_seen + merge-derived source; brand predicate LAST', async () => {
    const pool = fakePool([
      { identifier_type: 'email', first_seen: '2026-06-01 10:00:00 UTC', has_merge: 1 },
      { identifier_type: 'anon', first_seen: '2026-05-01 09:00:00 UTC', has_merge: 0 },
    ]);
    const res = await computeIdentityEvidence(BRAND, { srPool: pool }, BRAIN);
    expect(res.hasData).toBe(true);
    expect(res.evidence).toEqual([
      { identifierType: 'email', firstSeen: '2026-06-01 10:00:00 UTC', source: 'merge' },
      { identifierType: 'anon', firstSeen: '2026-05-01 09:00:00 UTC', source: 'silver_identity_map' },
    ]);
    // Brand-scoped seam: brainId binds first, brandId LAST (positional).
    expect(pool.lastParams).toEqual([BRAIN, BRAND]);
    expect(pool.lastSql).toContain('brand_id = ?');
    // Hash-only PII: the read never selects identifier_hash.
    expect(pool.lastSql).not.toMatch(/identifier_hash/);
  });

  it('honest-empty: no rows → hasData=false', async () => {
    const res = await computeIdentityEvidence(BRAND, { srPool: fakePool([]) }, BRAIN);
    expect(res).toEqual({ hasData: false, evidence: [] });
  });

  it('an empty brainId never queries', async () => {
    const pool = fakePool([{ identifier_type: 'email', first_seen: 'x', has_merge: 0 }]);
    const res = await computeIdentityEvidence(BRAND, { srPool: pool }, '');
    expect(res.hasData).toBe(false);
    expect(pool.lastSql).toBe('');
  });
});
