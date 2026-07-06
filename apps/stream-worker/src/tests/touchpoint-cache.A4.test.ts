// SPEC: A.4
/**
 * touchpoint-cache.A4.test.ts — the SPEC:A.4 real-time touchpoint-cache acceptance tests.
 *
 * A4 assertions (spec):
 *   A4.cap-at-200        the zset never exceeds 200 members; the OLDEST are evicted.
 *   A4.ttl-set           every write refreshes the 30d sliding TTL.
 *   A4.merge-union       identity.merged unions absorbed into survivor + deletes absorbed.
 *   A4.flag-off          with identity.tp_cache OFF, NOTHING is written (byte-identical golden).
 *   + deterministic-only (anon / ambiguous skipped) and non-touchpoint skipped.
 *
 * Uses in-memory doubles (no Redis / Neo4j) so the behavior is deterministic and CI-safe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { FlagService } from '@brain/platform-flags';
import { touchpointCacheKey } from '@brain/tenant-context';
import {
  TouchpointCacheService,
  TP_CACHE_FLAG,
} from '../touchpoint-cache/TouchpointCacheService.js';
import type {
  ITouchpointCacheStore,
  TouchpointEntry,
} from '../touchpoint-cache/TouchpointCacheStore.js';
import type { IDeterministicBrainIdResolver } from '../touchpoint-cache/BrainIdResolver.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const BRAIN = '22222222-2222-2222-2222-222222222222';
const MAX = 200;
const TTL = 30 * 24 * 60 * 60; // 2_592_000

// ── In-memory zset store (faithful ZADD / cap / TTL / ZUNIONSTORE-MAX semantics) ──
class InMemoryTpStore implements ITouchpointCacheStore {
  readonly zsets = new Map<string, Map<string, number>>();
  readonly ttls = new Map<string, number>();

  private cap(key: string, maxLen: number): void {
    const z = this.zsets.get(key);
    if (!z || z.size <= maxLen) return;
    // ZREMRANGEBYRANK 0 -(maxLen+1): remove LOWEST-ranked (score asc, then member lex asc).
    const ordered = [...z.entries()].sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1));
    for (const [member] of ordered.slice(0, z.size - maxLen)) z.delete(member);
  }

  async appendCapped(key: string, entry: TouchpointEntry, maxLen: number, ttlSeconds: number): Promise<void> {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    z.set(entry.member, entry.score); // ZADD upsert
    this.zsets.set(key, z);
    this.cap(key, maxLen);
    this.ttls.set(key, ttlSeconds);
  }

  async mergeInto(survivorKey: string, absorbedKey: string, maxLen: number, ttlSeconds: number): Promise<void> {
    const s = this.zsets.get(survivorKey) ?? new Map<string, number>();
    const a = this.zsets.get(absorbedKey);
    if (a) for (const [m, sc] of a) s.set(m, Math.max(s.get(m) ?? -Infinity, sc)); // AGGREGATE MAX
    this.zsets.set(survivorKey, s);
    this.cap(survivorKey, maxLen);
    this.ttls.set(survivorKey, ttlSeconds);
    this.zsets.delete(absorbedKey); // DEL absorbed
    this.ttls.delete(absorbedKey);
  }

  async card(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }
  async ttl(key: string): Promise<number> {
    return this.ttls.has(key) ? this.ttls.get(key)! : -2;
  }
  async membersAsc(key: string): Promise<TouchpointEntry[]> {
    const z = this.zsets.get(key);
    if (!z) return [];
    return [...z.entries()]
      .sort((x, y) => (x[1] - y[1]) || (x[0] < y[0] ? -1 : 1))
      .map(([member, score]) => ({ member, score }));
  }
}

class FakeFlags implements FlagService {
  private on = new Map<string, boolean>();
  set(brandId: string, enabled: boolean): void { this.on.set(brandId, enabled); }
  async isFlagEnabled(brandId: string): Promise<boolean> { return this.on.get(brandId) ?? false; }
  async setFlag(): Promise<void> { /* unused */ }
  async listFlags(): Promise<never[]> { return []; }
}

/** Resolver double: delegates to an injected fn (deterministic per test). */
class FakeResolver implements IDeterministicBrainIdResolver {
  constructor(private readonly fn: (brandId: string, parsed: Record<string, unknown>) => string | null) {}
  async resolve(brandId: string, parsed: Record<string, unknown>): Promise<string | null> {
    return this.fn(brandId, parsed);
  }
}

function evt(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    brand_id: BRAND,
    event_name: 'page.viewed',
    occurred_at: '2026-07-06T10:00:00.000Z',
    properties: { session_id: 'sess-1', url_path: '/home' },
    ...overrides,
  }));
}

describe('SPEC A.4 — touchpoint cache', () => {
  let store: InMemoryTpStore;
  let flags: FakeFlags;
  const KEY = touchpointCacheKey({ brandId: BRAND, brainId: BRAIN });

  const build = (resolveFn: (b: string, p: Record<string, unknown>) => string | null) =>
    new TouchpointCacheService(flags, new FakeResolver(resolveFn), store, {
      maxTouchpoints: MAX,
      ttlSeconds: TTL,
    });

  beforeEach(() => {
    store = new InMemoryTpStore();
    flags = new FakeFlags();
    flags.set(BRAND, true);
  });

  it('A4.cap-at-200 — retains only the newest 200 touchpoints, evicting the oldest', async () => {
    const svc = build(() => BRAIN);
    const base = Date.parse('2026-07-06T00:00:00.000Z');
    for (let i = 0; i < 250; i++) {
      const r = await svc.handleCollectorEvent(
        evt({ occurred_at: new Date(base + i * 1000).toISOString() }),
      );
      expect(r.outcome).toBe('appended');
    }
    expect(await store.card(KEY)).toBe(200);
    const members = await store.membersAsc(KEY);
    // Oldest kept is event #50 (0..49 evicted); newest is #249.
    expect(members[0]!.score).toBe(base + 50 * 1000);
    expect(members[members.length - 1]!.score).toBe(base + 249 * 1000);
  });

  it('A4.ttl-set — every write refreshes the 30d sliding TTL', async () => {
    const svc = build(() => BRAIN);
    expect(await store.ttl(KEY)).toBe(-2); // absent
    await svc.handleCollectorEvent(evt());
    expect(await store.ttl(KEY)).toBe(TTL);
  });

  it('A4.member — compact JSON is {type, channel, url_path, ts, session_id} in fixed order', async () => {
    const svc = build(() => BRAIN);
    await svc.handleCollectorEvent(evt({
      occurred_at: '2026-07-06T10:00:00.000Z',
      properties: { session_id: 'sess-9', url_path: '/p/1', utm: { medium: 'email' } },
    }));
    const [m] = await store.membersAsc(KEY);
    expect(m!.member).toBe(JSON.stringify({
      type: 'page.viewed',
      channel: 'email',
      url_path: '/p/1',
      ts: Date.parse('2026-07-06T10:00:00.000Z'),
      session_id: 'sess-9',
    }));
  });

  it('A4.merge-union — merge unions absorbed into survivor (MAX score) and deletes absorbed', async () => {
    const survivor = BRAIN;
    const absorbed = '33333333-3333-3333-3333-333333333333';
    const survivorKey = touchpointCacheKey({ brandId: BRAND, brainId: survivor });
    const absorbedKey = touchpointCacheKey({ brandId: BRAND, brainId: absorbed });

    // Seed survivor with 2 distinct touchpoints, absorbed with 3 (one duplicate member).
    await store.appendCapped(survivorKey, { score: 100, member: 'A' }, MAX, TTL);
    await store.appendCapped(survivorKey, { score: 200, member: 'B' }, MAX, TTL);
    await store.appendCapped(absorbedKey, { score: 150, member: 'B' }, MAX, TTL); // dup, lower score
    await store.appendCapped(absorbedKey, { score: 300, member: 'C' }, MAX, TTL);
    await store.appendCapped(absorbedKey, { score: 400, member: 'D' }, MAX, TTL);

    const svc = build(() => survivor);
    const r = await svc.handleIdentityMerged(Buffer.from(JSON.stringify({
      brand_id: BRAND,
      event_name: 'identity.merged',
      payload: { canonical_brain_id: survivor, merged_brain_id: absorbed, merge_id: 'm1' },
    })));
    expect(r.outcome).toBe('merged');

    // Union = {A,B,C,D}; B keeps MAX(200,150)=200. Absorbed key deleted.
    const members = await store.membersAsc(survivorKey);
    expect(members.map((m) => m.member).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(members.find((m) => m.member === 'B')!.score).toBe(200);
    expect(await store.card(absorbedKey)).toBe(0);
    expect(await store.ttl(survivorKey)).toBe(TTL);
  });

  it('A4.flag-off — with identity.tp_cache OFF, NOTHING is written (append or merge)', async () => {
    flags.set(BRAND, false);
    const svc = build(() => BRAIN);

    const a = await svc.handleCollectorEvent(evt());
    expect(a).toEqual({ outcome: 'skipped', reason: 'flag_off' });
    expect(await store.card(KEY)).toBe(0);

    const m = await svc.handleIdentityMerged(Buffer.from(JSON.stringify({
      brand_id: BRAND,
      payload: { canonical_brain_id: BRAIN, merged_brain_id: '33333333-3333-3333-3333-333333333333' },
    })));
    expect(m).toEqual({ outcome: 'skipped', reason: 'flag_off' });
    expect(store.zsets.size).toBe(0);
  });

  it('A4.deterministic-only — anon/unresolvable events are skipped (no write)', async () => {
    const svc = build(() => null); // resolver returns null = anon-only / ambiguous
    const r = await svc.handleCollectorEvent(evt());
    expect(r).toEqual({ outcome: 'skipped', reason: 'no_deterministic_brain_id' });
    expect(store.zsets.size).toBe(0);
  });

  it('A4.non-touchpoint — non-touchpoint event types are skipped before any resolve', async () => {
    let resolverCalled = false;
    const svc = build(() => { resolverCalled = true; return BRAIN; });
    const r = await svc.handleCollectorEvent(evt({ event_name: 'order.backfill.v1' }));
    expect(r).toEqual({ outcome: 'skipped', reason: 'not_touchpoint_event' });
    expect(resolverCalled).toBe(false);
  });

  it('flag gate is checked with the A.4 registry flag name', () => {
    expect(TP_CACHE_FLAG).toBe('identity.tp_cache');
  });
});
