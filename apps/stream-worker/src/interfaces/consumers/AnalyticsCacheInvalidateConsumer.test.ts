/**
 * AnalyticsCacheInvalidateConsumer — unit tests.
 *
 * Exercises processMessage() with a fake Redis client (no real Kafka, no real Redis).
 * Verifies:
 *   1. scope.all=true  → all brand_id-leading keys are evicted.
 *   2. scope.keys      → exact matching keys deleted; wrong-brand keys untouched.
 *   3. scope.key_prefixes → prefix-matched keys are deleted.
 *   4. Missing brand_id → invalid outcome, zero Redis calls.
 *   5. Brand isolation: eviction for brand_A never touches brand_B keys.
 *   6. Cross-brand exact key rejected: a scope.key whose prefix doesn't match brand_id is skipped.
 *   7. Empty scope (all=false, no keys, no prefixes) → skipped outcome.
 *   8. Null message → invalid outcome.
 *   9. Non-JSON message → invalid outcome.
 *  10. Schema validation failure → invalid outcome.
 *  11. Redis eviction error → evicted outcome (fail-safe: error is absorbed, not thrown).
 *
 * TENANT ISOLATION PROOF:
 *   Tests 2, 5, and 6 are the load-bearing isolation assertions: wrong-brand keys
 *   are NEVER deleted regardless of what arrives in the event payload.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Kafka } from 'kafkajs';
import {
  AnalyticsCacheInvalidateConsumer,
  type ICacheEvictionClient,
  type CacheInvalidateProcessResult,
} from './AnalyticsCacheInvalidateConsumer.js';

// ── Test constants ─────────────────────────────────────────────────────────────

const BRAND_A = 'aaaa0000-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'bbbb1111-0000-4000-8000-bbbbbbbbbbbb';
const ENV_PREFIX = 'dev';
const OCCURRED_AT = '2026-06-27T10:00:00Z';

// ── Event builder ──────────────────────────────────────────────────────────────

interface ScopeOverride {
  all?: boolean;
  keys?: string[];
  key_prefixes?: string[];
}

function buildCacheInvalidateBuffer(opts: {
  brand_id?: string;
  gold_product?: string;
  scope?: ScopeOverride;
}): Buffer {
  const brandId = opts.brand_id ?? BRAND_A;
  const scope = {
    all: opts.scope?.all ?? false,
    keys: opts.scope?.keys ?? [],
    key_prefixes: opts.scope?.key_prefixes ?? [],
  };
  return Buffer.from(
    JSON.stringify({
      schema_version: '1',
      event_id: randomUUID(),
      brand_id: brandId,
      correlation_id: 'test-corr',
      event_name: 'cache.invalidate',
      occurred_at: OCCURRED_AT,
      payload: {
        gold_product: opts.gold_product ?? 'gold_customer_360',
        scope,
        reason: 'gold_rewritten',
      },
    }),
    'utf8',
  );
}

/** gold.rewritten.v1 sibling builder — scope lives at payload.affected_scope. */
function buildGoldRewrittenBuffer(opts: {
  brand_id?: string;
  gold_product?: string;
  scope?: ScopeOverride;
}): Buffer {
  const brandId = opts.brand_id ?? BRAND_A;
  const scope = {
    all: opts.scope?.all ?? false,
    keys: opts.scope?.keys ?? [],
    key_prefixes: opts.scope?.key_prefixes ?? [],
  };
  return Buffer.from(
    JSON.stringify({
      schema_version: '1',
      event_id: randomUUID(),
      brand_id: brandId,
      correlation_id: 'test-corr',
      event_name: 'gold.rewritten',
      occurred_at: OCCURRED_AT,
      payload: {
        gold_product: opts.gold_product ?? 'gold_bi_batch',
        layer: 'gold',
        snapshot_id: null,
        rows_written: null,
        affected_scope: scope,
      },
    }),
    'utf8',
  );
}

// ── Fake Redis client ──────────────────────────────────────────────────────────

/** Fake ICacheEvictionClient that tracks calls and can simulate errors. */
function makeFakeRedis(initialKeys: string[] = [], failOnDel = false): {
  client: ICacheEvictionClient;
  deletedKeys: () => string[];
  remainingKeys: () => string[];
} {
  const keys = new Set(initialKeys);
  const deleted: string[] = [];

  const client: ICacheEvictionClient = {
    async del(key: string): Promise<number> {
      if (failOnDel) throw new Error('Redis connection refused');
      if (keys.has(key)) {
        keys.delete(key);
        deleted.push(key);
        return 1;
      }
      return 0;
    },
    async scan(cursor: string, _matchArg: string, pattern: string, _countArg: string, _batchSize: number): Promise<[string, string[]]> {
      // Single-cursor scan: return all matching keys on first call, then '0' to end.
      if (cursor !== '0') return ['0', []];
      // Convert Redis glob pattern to a simple prefix match for testing.
      const prefix = pattern.replace(/\*$/, '');
      const matches = [...keys].filter((k) => k.startsWith(prefix));
      return ['0', matches];
    },
  };

  return {
    client,
    deletedKeys: () => deleted,
    remainingKeys: () => [...keys],
  };
}

/** Minimal fake Kafka (consumer lifecycle not exercised in unit tests). */
const fakeKafka = {
  consumer: () => ({
    connect: vi.fn(),
    subscribe: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    commitOffsets: vi.fn(),
  }),
} as unknown as Kafka;

function buildConsumer(client: ICacheEvictionClient): AnalyticsCacheInvalidateConsumer {
  return new AnalyticsCacheInvalidateConsumer(fakeKafka, client, ENV_PREFIX, 'analytics-cache-invalidate');
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('AnalyticsCacheInvalidateConsumer.processMessage — scope.all=true', () => {
  it('evicts ALL brand_id-leading keys when scope.all=true', async () => {
    const { client, deletedKeys } = makeFakeRedis([
      `${BRAND_A}:realized_revenue:abc:v1`,
      `${BRAND_A}:blended_roas:def:v1`,
      `${BRAND_B}:realized_revenue:abc:v1`,  // must NOT be deleted
    ]);
    const result = await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({ scope: { all: true } }),
    );
    expect(result.outcome).toBe('evicted');
    // Brand A keys deleted
    expect(deletedKeys()).toContain(`${BRAND_A}:realized_revenue:abc:v1`);
    expect(deletedKeys()).toContain(`${BRAND_A}:blended_roas:def:v1`);
    // Brand B key NOT deleted (isolation invariant)
    expect(deletedKeys()).not.toContain(`${BRAND_B}:realized_revenue:abc:v1`);
  });

  it('returns evicted with keysDeleted=2 when two keys match', async () => {
    const { client } = makeFakeRedis([
      `${BRAND_A}:metric_a:p1:v1`,
      `${BRAND_A}:metric_b:p2:v1`,
    ]);
    const result = (await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({ scope: { all: true } }),
    )) as Extract<CacheInvalidateProcessResult, { outcome: 'evicted' }>;
    expect(result.outcome).toBe('evicted');
    expect(result.keysDeleted).toBe(2);
  });

  it('returns evicted with keysDeleted=0 when no keys exist for the brand', async () => {
    const { client } = makeFakeRedis([]);
    const result = (await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({ scope: { all: true } }),
    )) as Extract<CacheInvalidateProcessResult, { outcome: 'evicted' }>;
    expect(result.outcome).toBe('evicted');
    expect(result.keysDeleted).toBe(0);
  });
});

describe('AnalyticsCacheInvalidateConsumer.processMessage — scope.keys (exact)', () => {
  it('deletes exact matching keys that start with brand_id', async () => {
    const targetKey = `${BRAND_A}:realized_revenue:abc123:v1`;
    const { client, deletedKeys } = makeFakeRedis([targetKey]);
    const result = await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({ scope: { keys: [targetKey] } }),
    );
    expect(result.outcome).toBe('evicted');
    expect(deletedKeys()).toContain(targetKey);
  });

  it('[ISOLATION] skips exact keys that do NOT start with brand_id (cross-brand guard)', async () => {
    const crossBrandKey = `${BRAND_B}:realized_revenue:abc123:v1`;
    const { client, deletedKeys, remainingKeys } = makeFakeRedis([crossBrandKey]);
    // Event is for BRAND_A but contains a BRAND_B key in scope.keys
    const result = await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({
        brand_id: BRAND_A,
        scope: { keys: [crossBrandKey] },
      }),
    );
    // Eviction returns evicted or skipped — the cross-brand key is never deleted
    expect(deletedKeys()).not.toContain(crossBrandKey);
    expect(remainingKeys()).toContain(crossBrandKey);
    // Note: if only cross-brand keys were in scope.keys, no brand_A keys were deleted.
    // The outcome may be 'evicted' with keysDeleted=0 (the cross-brand key was skipped).
    expect(['evicted', 'skipped']).toContain(result.outcome);
  });

  it('deletes only the brand_A key when scope.keys mixes brands', async () => {
    const validKey = `${BRAND_A}:metric_x:h1:v1`;
    const crossKey = `${BRAND_B}:metric_x:h1:v1`;
    const { client, deletedKeys } = makeFakeRedis([validKey, crossKey]);
    await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({
        brand_id: BRAND_A,
        scope: { keys: [validKey, crossKey] },
      }),
    );
    expect(deletedKeys()).toContain(validKey);
    expect(deletedKeys()).not.toContain(crossKey);
  });
});

describe('AnalyticsCacheInvalidateConsumer.processMessage — scope.key_prefixes', () => {
  it('evicts keys matching the brand_id:prefix* pattern', async () => {
    const { client, deletedKeys } = makeFakeRedis([
      `${BRAND_A}:revenue:h1:v1`,
      `${BRAND_A}:revenue:h2:v1`,
      `${BRAND_A}:roas:h1:v1`,       // different prefix — must NOT be deleted
      `${BRAND_B}:revenue:h1:v1`,    // different brand — must NOT be deleted
    ]);
    const result = await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({ scope: { key_prefixes: ['revenue'] } }),
    );
    expect(result.outcome).toBe('evicted');
    expect(deletedKeys()).toContain(`${BRAND_A}:revenue:h1:v1`);
    expect(deletedKeys()).toContain(`${BRAND_A}:revenue:h2:v1`);
    expect(deletedKeys()).not.toContain(`${BRAND_A}:roas:h1:v1`);
    expect(deletedKeys()).not.toContain(`${BRAND_B}:revenue:h1:v1`);
  });
});

describe('AnalyticsCacheInvalidateConsumer.processMessage — brand isolation (load-bearing)', () => {
  it('[ISOLATION] brand_A eviction NEVER touches brand_B keys regardless of scope', async () => {
    const brandAKey = `${BRAND_A}:some_metric:h:v1`;
    const brandBKey = `${BRAND_B}:some_metric:h:v1`;
    const { client, remainingKeys } = makeFakeRedis([brandAKey, brandBKey]);

    // scope.all=true for brand_A
    await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({ brand_id: BRAND_A, scope: { all: true } }),
    );

    // Brand B key is untouched (the scan pattern was `${BRAND_A}:*`)
    expect(remainingKeys()).toContain(brandBKey);
    expect(remainingKeys()).not.toContain(brandAKey);
  });
});

describe('AnalyticsCacheInvalidateConsumer.processMessage — empty scope', () => {
  it('returns skipped when scope.all=false and no keys/prefixes', async () => {
    const { client } = makeFakeRedis([`${BRAND_A}:some_key:h:v1`]);
    const result = await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({ scope: { all: false, keys: [], key_prefixes: [] } }),
    );
    expect(result.outcome).toBe('skipped');
  });
});

describe('AnalyticsCacheInvalidateConsumer.processMessage — invalid inputs', () => {
  it('null message → invalid outcome, zero Redis calls', async () => {
    const { client, deletedKeys } = makeFakeRedis([`${BRAND_A}:key:h:v1`]);
    const result = await buildConsumer(client).processMessage(null);
    expect(result.outcome).toBe('invalid');
    expect(deletedKeys()).toHaveLength(0);
  });

  it('non-JSON Buffer → invalid outcome', async () => {
    const { client, deletedKeys } = makeFakeRedis();
    const result = await buildConsumer(client).processMessage(Buffer.from('not json', 'utf8'));
    expect(result.outcome).toBe('invalid');
    expect(deletedKeys()).toHaveLength(0);
  });

  it('JSON missing required fields → invalid outcome (schema validation)', async () => {
    const { client, deletedKeys } = makeFakeRedis();
    const result = await buildConsumer(client).processMessage(
      Buffer.from(JSON.stringify({ event_name: 'cache.invalidate', brand_id: BRAND_A }), 'utf8'),
    );
    expect(result.outcome).toBe('invalid');
    expect(deletedKeys()).toHaveLength(0);
  });
});

describe('AnalyticsCacheInvalidateConsumer.processMessage — gold.rewritten.v1', () => {
  it('evicts ALL brand keys on gold.rewritten with affected_scope.all=true', async () => {
    const { client, deletedKeys, remainingKeys } = makeFakeRedis([
      `${BRAND_A}:realized_revenue:abc:v1`,
      `${BRAND_A}:cohort_retention:def:v1`,
      `${BRAND_B}:realized_revenue:abc:v1`, // must NOT be deleted
    ]);
    const result = (await buildConsumer(client).processMessage(
      buildGoldRewrittenBuffer({ scope: { all: true } }),
    )) as Extract<CacheInvalidateProcessResult, { outcome: 'evicted' }>;
    expect(result.outcome).toBe('evicted');
    expect(result.goldProduct).toBe('gold_bi_batch');
    expect(result.keysDeleted).toBe(2);
    expect(deletedKeys()).toContain(`${BRAND_A}:realized_revenue:abc:v1`);
    expect(remainingKeys()).toContain(`${BRAND_B}:realized_revenue:abc:v1`);
  });

  it('honors affected_scope.key_prefixes on gold.rewritten (brand-scoped SCAN)', async () => {
    const { client, deletedKeys } = makeFakeRedis([
      `${BRAND_A}:ltv:h1:v1`,
      `${BRAND_A}:aov:h1:v1`,
      `${BRAND_B}:ltv:h1:v1`,
    ]);
    const result = await buildConsumer(client).processMessage(
      buildGoldRewrittenBuffer({ scope: { key_prefixes: ['ltv'] } }),
    );
    expect(result.outcome).toBe('evicted');
    expect(deletedKeys()).toEqual([`${BRAND_A}:ltv:h1:v1`]);
  });

  it('empty affected_scope on gold.rewritten → skipped', async () => {
    const { client } = makeFakeRedis([`${BRAND_A}:key:h:v1`]);
    const result = await buildConsumer(client).processMessage(
      buildGoldRewrittenBuffer({ scope: { all: false } }),
    );
    expect(result.outcome).toBe('skipped');
  });

  it('malformed gold.rewritten (missing payload.gold_product) → invalid', async () => {
    const { client, deletedKeys } = makeFakeRedis([`${BRAND_A}:key:h:v1`]);
    const result = await buildConsumer(client).processMessage(
      Buffer.from(
        JSON.stringify({
          schema_version: '1',
          event_id: randomUUID(),
          brand_id: BRAND_A,
          correlation_id: 'test-corr',
          event_name: 'gold.rewritten',
          occurred_at: OCCURRED_AT,
          payload: { layer: 'gold', affected_scope: { all: true, keys: [], key_prefixes: [] } },
        }),
        'utf8',
      ),
    );
    expect(result.outcome).toBe('invalid');
    expect(deletedKeys()).toHaveLength(0);
  });
});

describe('AnalyticsCacheInvalidateConsumer.processMessage — fail-safe (Redis error)', () => {
  it('Redis error during eviction → returns evicted (fail-safe, does NOT throw)', async () => {
    const { client } = makeFakeRedis([`${BRAND_A}:key:h:v1`], /* failOnDel */ true);
    const result = await buildConsumer(client).processMessage(
      buildCacheInvalidateBuffer({ scope: { all: true } }),
    );
    // Fail-safe: the eviction error is absorbed; the offset is committed by the caller.
    // The result is 'evicted' with partial/0 count (not a throw, not 'invalid').
    expect(result.outcome).toBe('evicted');
    // Does NOT propagate the Redis error
  });
});
