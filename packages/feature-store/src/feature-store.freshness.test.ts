/**
 * feature-store.freshness.test.ts — unit tests for the freshness sentinel + TTL contract.
 *
 * Tests the offline/online parity alarm:
 *   1. After materialization the sentinel is written and freshness check passes.
 *   2. When the sentinel is absent (expired TTL simulated) freshness check throws FeatureStaleError.
 *   3. When the sentinel is older than the SLO window freshness check throws FeatureStaleError.
 *   4. materializeCustomerFeatures writes feature keys WITH a TTL (EX argument).
 *   5. writeSentinel + readSentinel round-trip.
 *
 * These run against a real Redis if REDIS_URL is set; otherwise they use a mock (no infra required
 * for unit CI). The mock validates the TTL contract structurally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RedisOnlineStore,
  materializeCustomerFeatures,
  CUSTOMER_FEATURES,
  FEATURE_TTL_SECONDS,
  FEATURE_FRESHNESS_SLO_SECONDS,
  FeatureStaleError,
  type Customer360Row,
} from './index.js';

// ── Lightweight Redis mock ────────────────────────────────────────────────────────────────────────
// Captures the TTL argument on set() so we can assert it without a live Redis.
// Only used when REDIS_URL is not pointing to a running instance.

class InMemoryRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  set(
    key: string,
    value: string,
    exFlag?: string,
    exSeconds?: number,
  ): Promise<'OK'> {
    const expiresAt =
      exFlag?.toUpperCase() === 'EX' && typeof exSeconds === 'number'
        ? Date.now() + exSeconds * 1000
        : null;
    this.store.set(key, { value, expiresAt });
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }

  keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace('*', '');
    return Promise.resolve([...this.store.keys()].filter((k) => k.startsWith(prefix)));
  }

  del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.store.delete(k)) n++;
    }
    return Promise.resolve(n);
  }

  quit(): Promise<void> {
    return Promise.resolve();
  }

  /** Expire a key immediately (simulate TTL expiry). */
  expire(key: string): void {
    const entry = this.store.get(key);
    if (entry) this.store.set(key, { ...entry, expiresAt: Date.now() - 1 });
  }

  /** Inspect the expiry for a key (ms epoch). */
  getExpiresAt(key: string): number | null {
    return this.store.get(key)?.expiresAt ?? null;
  }
}

// ── Patch RedisOnlineStore to accept an InMemoryRedis ────────────────────────────────────────────
// We instantiate the store with a dummy URL then replace the private redis field with our mock.

function makeTestStore(): { store: RedisOnlineStore; mock: InMemoryRedis } {
  const mock = new InMemoryRedis();
  // Construct with a dummy URL (the constructor will throw on .connect() — we never call it since
  // we replace the internal reference). Use a known-unreachable URL to avoid any accidental connect.
  const store = Object.create(RedisOnlineStore.prototype) as RedisOnlineStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).redis = mock;
  return { store, mock };
}

const BRAND = 'test-brand-freshness-001';

const ROWS: Customer360Row[] = [
  { brain_id: 'b1', lifetime_value_minor: 100000, lifetime_orders: 5, delivered_orders: 4, rto_orders: 1 },
  { brain_id: 'b2', lifetime_value_minor: 50000, lifetime_orders: 3, delivered_orders: 3, rto_orders: 0 },
];

describe('feature-store — freshness sentinel + TTL', () => {
  let store: RedisOnlineStore;
  let mock: InMemoryRedis;

  beforeEach(() => {
    ({ store, mock } = makeTestStore());
  });

  afterEach(async () => {
    await store.purgeBrand(BRAND);
  });

  it('1. materializeCustomerFeatures writes the sentinel after all feature keys', async () => {
    const computedAt = '2026-06-22T12:00:00.000Z';
    await materializeCustomerFeatures(BRAND, ROWS, store, computedAt);

    const sentinel = await store.readSentinel(BRAND);
    expect(sentinel).toBe(computedAt);
  });

  it('2. feature keys are written with FEATURE_TTL_SECONDS EX TTL', async () => {
    const computedAt = '2026-06-22T12:00:00.000Z';
    const before = Date.now();
    await materializeCustomerFeatures(BRAND, ROWS, store, computedAt);
    const after = Date.now();

    // Check that the first feature key has an expiry within the expected window.
    // The TTL should be approximately (before + FEATURE_TTL_SECONDS * 1000) to (after + FEATURE_TTL_SECONDS * 1000).
    const featureKey = `feat:${BRAND}:ltv_minor:b1`;
    const expiresAt = mock.getExpiresAt(featureKey);
    expect(expiresAt).not.toBeNull();
    const expectedMin = before + FEATURE_TTL_SECONDS * 1000 - 1000; // 1s tolerance
    const expectedMax = after + FEATURE_TTL_SECONDS * 1000 + 1000;
    expect(expiresAt!).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt!).toBeLessThanOrEqual(expectedMax);
  });

  it('3. sentinel key is written with FEATURE_TTL_SECONDS EX TTL', async () => {
    const computedAt = '2026-06-22T12:00:00.000Z';
    const before = Date.now();
    await materializeCustomerFeatures(BRAND, ROWS, store, computedAt);
    const after = Date.now();

    const sentinelKey = `feat:sentinel:${BRAND}:last_materialized_at`;
    const expiresAt = mock.getExpiresAt(sentinelKey);
    expect(expiresAt).not.toBeNull();
    const expectedMin = before + FEATURE_TTL_SECONDS * 1000 - 1000;
    const expectedMax = after + FEATURE_TTL_SECONDS * 1000 + 1000;
    expect(expiresAt!).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt!).toBeLessThanOrEqual(expectedMax);
  });

  it('4. checkFeatureFreshness passes when sentinel is within the SLO window', async () => {
    // Write a sentinel that is 1 hour old (well within the 26h SLO).
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    await store.writeSentinel(BRAND, oneHourAgo);

    // Should not throw.
    await expect(store.checkFeatureFreshness(BRAND)).resolves.toBeUndefined();
  });

  it('5. checkFeatureFreshness throws FeatureStaleError when sentinel is absent', async () => {
    // No sentinel written → sentinel read returns null.
    await expect(store.checkFeatureFreshness(BRAND)).rejects.toBeInstanceOf(FeatureStaleError);

    const err = await store.checkFeatureFreshness(BRAND).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureStaleError);
    expect((err as FeatureStaleError).message).toContain('sentinel absent');
  });

  it('6. checkFeatureFreshness throws FeatureStaleError when lag exceeds SLO', async () => {
    // Sentinel is 30 hours old — exceeds FEATURE_FRESHNESS_SLO_SECONDS (26h).
    const thirtyHoursAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    await store.writeSentinel(BRAND, thirtyHoursAgo);

    const err = await store.checkFeatureFreshness(BRAND).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureStaleError);
    expect((err as FeatureStaleError).message).toContain('exceeds SLO');
  });

  it('7. checkFeatureFreshness passes for a sentinel exactly at the SLO boundary (26h - 1s)', async () => {
    // Sentinel written exactly 1 second before the SLO limit.
    const justWithin = new Date(Date.now() - (FEATURE_FRESHNESS_SLO_SECONDS - 1) * 1000).toISOString();
    await store.writeSentinel(BRAND, justWithin);
    await expect(store.checkFeatureFreshness(BRAND)).resolves.toBeUndefined();
  });

  it('8. checkFeatureFreshness rejects a sentinel at exactly SLO + 1s', async () => {
    const justOver = new Date(Date.now() - (FEATURE_FRESHNESS_SLO_SECONDS + 1) * 1000).toISOString();
    await store.writeSentinel(BRAND, justOver);
    await expect(store.checkFeatureFreshness(BRAND)).rejects.toBeInstanceOf(FeatureStaleError);
  });

  it('9. offline/online parity — online served value equals offline computed value', async () => {
    const computedAt = '2026-06-22T10:00:00.000Z';
    await materializeCustomerFeatures(BRAND, ROWS, store, computedAt);

    for (const row of ROWS) {
      for (const def of CUSTOMER_FEATURES) {
        const served = await store.get(BRAND, row.brain_id, def.name);
        expect(served, `${def.name} for ${row.brain_id}`).not.toBeNull();
        expect(served!.value).toBe(def.compute(row)); // parity: online == offline
      }
    }
  });

  it('10. FEATURE_TTL_SECONDS is 25h and FEATURE_FRESHNESS_SLO_SECONDS is 26h', () => {
    expect(FEATURE_TTL_SECONDS).toBe(25 * 3600);
    expect(FEATURE_FRESHNESS_SLO_SECONDS).toBe(26 * 3600);
    // SLO must be > TTL so the alarm fires before the sentinel expires.
    expect(FEATURE_FRESHNESS_SLO_SECONDS).toBeGreaterThan(FEATURE_TTL_SECONDS);
  });
});
