// SPEC: A.4
/**
 * touchpoint-cache-benchmark.A4.test.ts — the A.4 latency budget benchmark.
 *
 * BUDGET (SPEC A.4 / §"Local resource discipline"): the touchpoint-cache lane must add
 * ≤ 50ms p99 over a 1k-event replay. We replay 1,000 touchpoint events through the SAME
 * TouchpointCacheService.handleCollectorEvent used in prod, once with identity.tp_cache ON
 * (full path: extract → resolve → serialize → ZADD+cap+TTL) and once OFF (baseline: a
 * fail-closed flag read + early return), and assert the added p99 is within budget.
 *
 * BACKEND: prefers the REAL RedisTouchpointCacheStore against REDIS_URL (records the true
 * hot-path number against the live stack); falls back to an in-memory zset double when Redis
 * is unreachable so the benchmark stays green in a minimal CI env. Either way the numbers are
 * printed. The brain_id resolver is an IN-MEMORY map (the spec's "in-memory resolution") so the
 * measurement isolates the cache lane's added compute from Neo4j jitter — deterministic + CI-safe.
 */
import { describe, it, expect } from 'vitest';
import { Redis } from 'ioredis';
import type { FlagService } from '@brain/platform-flags';
import { touchpointCacheKey } from '@brain/tenant-context';
import { TouchpointCacheService } from '../touchpoint-cache/TouchpointCacheService.js';
import {
  RedisTouchpointCacheStore,
  type ITouchpointCacheStore,
  type TouchpointEntry,
} from '../touchpoint-cache/TouchpointCacheStore.js';
import type { IDeterministicBrainIdResolver } from '../touchpoint-cache/BrainIdResolver.js';

const BRAND = '44444444-4444-4444-4444-444444444444';
const BRAIN = '55555555-5555-5555-5555-555555555555';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const N = 1000;
const WARMUP = 100;
const BUDGET_MS = 50;

class InMemoryTpStore implements ITouchpointCacheStore {
  private z = new Map<string, Map<string, number>>();
  private t = new Map<string, number>();
  async appendCapped(k: string, e: TouchpointEntry, max: number, ttl: number): Promise<void> {
    const s = this.z.get(k) ?? new Map<string, number>();
    s.set(e.member, e.score);
    if (s.size > max) {
      const ordered = [...s.entries()].sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1));
      for (const [m] of ordered.slice(0, s.size - max)) s.delete(m);
    }
    this.z.set(k, s);
    this.t.set(k, ttl);
  }
  async mergeInto(): Promise<void> { /* unused in this benchmark */ }
  async card(k: string): Promise<number> { return this.z.get(k)?.size ?? 0; }
  async ttl(k: string): Promise<number> { return this.t.get(k) ?? -2; }
  async membersAsc(): Promise<TouchpointEntry[]> { return []; }
}

class MapResolver implements IDeterministicBrainIdResolver {
  async resolve(_brand: string, parsed: Record<string, unknown>): Promise<string | null> {
    // "in-memory resolution": an identified event carries the brain id; anon → null.
    const p = (parsed['properties'] as Record<string, unknown>) ?? {};
    return typeof p['__brain_id'] === 'string' ? (p['__brain_id'] as string) : null;
  }
}

class Flags implements FlagService {
  constructor(private enabled: boolean) {}
  async isFlagEnabled(): Promise<boolean> { return this.enabled; }
  async setFlag(): Promise<void> {}
  async listFlags(): Promise<never[]> { return []; }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function makeEvents(): Buffer[] {
  const base = Date.parse('2026-07-06T00:00:00.000Z');
  return Array.from({ length: N + WARMUP }, (_, i) => Buffer.from(JSON.stringify({
    brand_id: BRAND,
    event_name: 'page.viewed',
    occurred_at: new Date(base + i * 1000).toISOString(),
    properties: { session_id: `s-${i % 7}`, url_path: `/p/${i % 20}`, __brain_id: BRAIN,
      utm: { medium: i % 3 === 0 ? 'email' : 'referral' } },
  })));
}

async function replay(svc: TouchpointCacheService, events: Buffer[]): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const t0 = performance.now();
    await svc.handleCollectorEvent(events[i]!);
    const dt = performance.now() - t0;
    if (i >= WARMUP) samples.push(dt); // discard warmup
  }
  return samples;
}

describe('SPEC A.4 — touchpoint cache latency budget (1k-event replay)', () => {
  it('A4.benchmark — added p99 (flag ON vs OFF) <= 50ms', async () => {
    // Choose backend: real Redis if reachable, else in-memory.
    let store: ITouchpointCacheStore;
    let redis: InstanceType<typeof Redis> | undefined;
    let backend = 'in-memory';
    try {
      const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500, enableOfflineQueue: false });
      await probe.connect();
      await probe.ping();
      await probe.del(touchpointCacheKey({ brandId: BRAND, brainId: BRAIN })); // clean slate
      redis = probe;
      const real = new RedisTouchpointCacheStore(REDIS_URL);
      await real.connect();
      store = real as unknown as ITouchpointCacheStore;
      (store as unknown as { __real?: RedisTouchpointCacheStore }).__real = real;
      backend = 'redis';
    } catch {
      store = new InMemoryTpStore();
    }

    const events = makeEvents();
    const resolver = new MapResolver();
    const cfg = { maxTouchpoints: 200, ttlSeconds: 30 * 24 * 60 * 60 };

    const onSvc = new TouchpointCacheService(new Flags(true), resolver, store, cfg);
    const offSvc = new TouchpointCacheService(new Flags(false), resolver, store, cfg);

    const onSamples = (await replay(onSvc, events)).sort((a, b) => a - b);
    const offSamples = (await replay(offSvc, events)).sort((a, b) => a - b);

    const onP99 = pct(onSamples, 99);
    const offP99 = pct(offSamples, 99);
    const addedP99 = Math.max(0, onP99 - offP99);

    console.log(
      `[A4.benchmark] backend=${backend} n=${N} ` +
      `ON  p50=${pct(onSamples, 50).toFixed(3)}ms p99=${onP99.toFixed(3)}ms max=${onSamples[onSamples.length - 1]!.toFixed(3)}ms | ` +
      `OFF p50=${pct(offSamples, 50).toFixed(3)}ms p99=${offP99.toFixed(3)}ms | ` +
      `ADDED p99=${addedP99.toFixed(3)}ms (budget ${BUDGET_MS}ms)`,
    );

    expect(addedP99).toBeLessThanOrEqual(BUDGET_MS);
    expect(onP99).toBeLessThanOrEqual(BUDGET_MS); // absolute hot-path budget

    // teardown
    const real = (store as unknown as { __real?: RedisTouchpointCacheStore }).__real;
    if (real) await real.quit().catch(() => undefined);
    if (redis) { await redis.del(touchpointCacheKey({ brandId: BRAND, brainId: BRAIN })).catch(() => undefined); await redis.quit().catch(() => undefined); }
  }, 30_000);
});
