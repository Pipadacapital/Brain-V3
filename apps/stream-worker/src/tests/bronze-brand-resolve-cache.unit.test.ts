/**
 * bronze-brand-resolve-cache.unit.test.ts — AUD-PERF-010.
 *
 * resolveBrandByInstallToken previously issued one uncached PG round trip per pixel event.
 * These tests prove the TTL-bounded in-process cache: positive hits are served from memory
 * for 60s, negative (unresolved) hits for only 5s, and expiry falls back to the query.
 * The pg Pool is stubbed — the SECURITY DEFINER fn remains the sole derivation source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BronzeRepository } from '../infrastructure/pg/BronzeRepository.js';

const TOKEN_A = '11111111-2222-3333-4444-555555555555';
const TOKEN_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function stubPool(repo: BronzeRepository, rowsByToken: Map<string, string | null>) {
  const query = vi.fn(async (_sql: string, params: unknown[]) => {
    const brand = rowsByToken.get(params[0] as string) ?? null;
    return { rows: brand !== null ? [{ brand_id: brand }] : [] };
  });
  const client = { query, release: vi.fn() };
  // Replace the private pool with a stub — the unit under test is the cache, not pg.
  (repo as unknown as { pool: { connect: () => Promise<unknown> } }).pool = {
    connect: async () => client,
  };
  return query;
}

describe('BronzeRepository.resolveBrandByInstallToken cache (AUD-PERF-010)', () => {
  let repo: BronzeRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    repo = new BronzeRepository('postgres://unused:unused@localhost:1/void');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a positive hit from cache within 60s (one PG round trip for N events)', async () => {
    const query = stubPool(repo, new Map([[TOKEN_A, 'brand-1']]));
    expect(await repo.resolveBrandByInstallToken(TOKEN_A)).toBe('brand-1');
    expect(await repo.resolveBrandByInstallToken(TOKEN_A)).toBe('brand-1');
    expect(await repo.resolveBrandByInstallToken(TOKEN_A)).toBe('brand-1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('re-queries a positive hit after the 60s TTL', async () => {
    const query = stubPool(repo, new Map([[TOKEN_A, 'brand-1']]));
    await repo.resolveBrandByInstallToken(TOKEN_A);
    vi.advanceTimersByTime(60_001);
    await repo.resolveBrandByInstallToken(TOKEN_A);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('caches a negative (unresolved) result for only 5s — a fresh install is not quarantined for a minute', async () => {
    const rows = new Map<string, string | null>([[TOKEN_B, null]]);
    const query = stubPool(repo, rows);
    expect(await repo.resolveBrandByInstallToken(TOKEN_B)).toBeNull();
    expect(await repo.resolveBrandByInstallToken(TOKEN_B)).toBeNull(); // cached negative
    expect(query).toHaveBeenCalledTimes(1);

    rows.set(TOKEN_B, 'brand-2'); // pixel install lands
    vi.advanceTimersByTime(5_001);
    expect(await repo.resolveBrandByInstallToken(TOKEN_B)).toBe('brand-2');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps tokens isolated (no cross-token cache bleed)', async () => {
    const query = stubPool(
      repo,
      new Map([
        [TOKEN_A, 'brand-1'],
        [TOKEN_B, 'brand-2'],
      ]),
    );
    expect(await repo.resolveBrandByInstallToken(TOKEN_A)).toBe('brand-1');
    expect(await repo.resolveBrandByInstallToken(TOKEN_B)).toBe('brand-2');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('malformed tokens never hit the cache or the pool', async () => {
    const query = stubPool(repo, new Map());
    expect(await repo.resolveBrandByInstallToken('not-a-uuid')).toBeNull();
    expect(await repo.resolveBrandByInstallToken(42)).toBeNull();
    expect(await repo.resolveBrandByInstallToken('')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
