/**
 * identifier-cache-erasure.unit.test.ts — H2: the identifier cache lives OUTSIDE the brand-wide
 * evictable serving keyspace, and RTBF purges a subject's entries EXPLICITLY.
 *
 * PROVES (per task spec):
 *   1. Keys are prefix-first (`idcache:{brand}:idhash:{type}:{hash}`) — a `${brandId}:*` SCAN
 *      pattern can never match them, so the post-Gold refresh-cycle cache-bust no longer wipes
 *      the ADR-0015 Neo4j-bounding cache.
 *   2. ServingCacheEvictor.evictBrand deletes the brand's serving keys (durable config exempt)
 *      and does NOT touch idcache keys.
 *   3. Erasure (EraseSubjectUseCase STEP 3c) removes EXACTLY the subject's idcache keys — other
 *      subjects and other brands are untouched — keyed by the union of the trigger's subject
 *      hash and the graph's identifier-hash enumeration.
 *   4. TTL-based expiry still bounds staleness: every prime carries the configured EX TTL.
 *   5. The purge is FAIL-CLOSED: a Redis failure during purge rejects the erasure sequence.
 *
 * NO live infrastructure: ioredis is mocked with an in-memory store; every other seam is an
 * in-memory double (same idiom as erasure-orchestrator.unit.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashIdentifier } from '@brain/identity-core';

// ── In-memory Redis fake (shared store across instances, TTL recorded per key) ──

const redisStore = new Map<string, { value: string; ttlSeconds: number | null }>();
/** When set, scan/del throw — proves the purge's fail-closed contract. */
let redisFailing = false;

function globToRegExp(pattern: string): RegExp {
  // Only `*` is used by the code under test; escape everything else literally.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

vi.mock('ioredis', () => {
  class FakeRedis {
    constructor(_url?: unknown, _opts?: unknown) {}
    async connect(): Promise<void> {}
    async quit(): Promise<void> {}
    async mget(...keys: string[]): Promise<Array<string | null>> {
      return keys.map((k) => redisStore.get(k)?.value ?? null);
    }
    pipeline(): {
      set: (key: string, value: string, ex: string, ttl: number) => unknown;
      exec: () => Promise<unknown[]>;
    } {
      const cmds: Array<() => void> = [];
      const p = {
        set: (key: string, value: string, _ex: string, ttl: number): unknown => {
          cmds.push(() => redisStore.set(key, { value, ttlSeconds: ttl }));
          return p;
        },
        exec: async (): Promise<unknown[]> => {
          for (const fn of cmds) fn();
          return [];
        },
      };
      return p;
    }
    async del(key: string): Promise<number> {
      if (redisFailing) throw new Error('redis down (injected)');
      return redisStore.delete(key) ? 1 : 0;
    }
    async scan(
      _cursor: string,
      _matchArg: string,
      pattern: string,
      _countArg: string,
      _batch: number,
    ): Promise<[string, string[]]> {
      if (redisFailing) throw new Error('redis down (injected)');
      const re = globToRegExp(pattern);
      return ['0', [...redisStore.keys()].filter((k) => re.test(k))];
    }
  }
  return { Redis: FakeRedis, default: FakeRedis };
});

import {
  IdentifierCacheAdapter,
  identifierCacheKey,
} from '../infrastructure/redis/IdentifierCacheAdapter.js';
import {
  ServingCacheEvictor,
  type ICacheEvictionClient,
} from '../infrastructure/redis/ServingCacheEvictor.js';
import {
  EraseSubjectUseCase,
  type IErasureRepository,
  type IBrainIdLookup,
  type IErasureScopedRecomputeRepository,
  type IErasureIdentityGraph,
} from '../application/EraseSubjectUseCase.js';
import type { RequestCapiDeletionUseCase } from '../application/RequestCapiDeletionUseCase.js';
import type { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BRAND_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRAND_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRAIN_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TTL_SECONDS = 3600;
const SALT_HEX = randomBytes(32).toString('hex');
const EMAIL = 'subject@example.com';
/** The exact hash EraseSubjectUseCase derives for the trigger's raw subject. */
const SUBJECT_HASH = hashIdentifier(EMAIL, 'email', SALT_HEX, 'IN');
/** A second identifier hash known only to the graph (e.g. the subject's anon_id). */
const GRAPH_ONLY_HASH = 'f'.repeat(64);
/** A DIFFERENT subject's hash — must survive the erasure untouched. */
const OTHER_SUBJECT_HASH = '0'.repeat(64);

function makeErasureEvent(): Buffer {
  return Buffer.from(
    JSON.stringify({
      brand_id: BRAND_A,
      event_id: randomUUID(),
      event_name: 'consent.erasure',
      reason: 'erasure',
      region_code: 'IN',
      consent_flags: { analytics: false, marketing: false },
      payload: { properties: { email: EMAIL } },
    }),
    'utf8',
  );
}

function makeEraseUseCase(args: {
  purge?: IdentifierCacheAdapter;
  graphHashes?: string[];
}): EraseSubjectUseCase {
  const saltProvider = {
    saltHexForBrand: async () => SALT_HEX,
  } as unknown as SaltProvider;
  const erasureRepo: IErasureRepository = {
    initErasureLog: async () => undefined,
    shredSubjectKeyring: async () => true,
    recordSurrogate: async () => undefined,
    eraseContactPii: async () => 0,
    completeErasure: async () => undefined,
  };
  const brainIdLookup: IBrainIdLookup = { findBrainId: async () => BRAIN_A };
  const scopedRecomputeRepo: IErasureScopedRecomputeRepository = { upsert: async () => undefined };
  const requestCapiDeletion = {
    execute: async () => ({ outcome: 'deletion_requested' }),
  } as unknown as RequestCapiDeletionUseCase;
  const identityGraph: IErasureIdentityGraph = {
    listIdentifierHashesForErasure: async () => args.graphHashes ?? [],
    eraseSubjectGraph: async () => ({ existed: true, linksTombstoned: 1 }),
  };
  return new EraseSubjectUseCase(
    saltProvider,
    erasureRepo,
    brainIdLookup,
    scopedRecomputeRepo,
    requestCapiDeletion,
    undefined, // invalidateSubjectDek
    undefined, // bronzeRawErasure (unset → disabled seam, caught internally)
    undefined, // cacheInvalidate
    identityGraph,
    args.purge,
  );
}

beforeEach(() => {
  redisStore.clear();
  redisFailing = false;
});

// ── 1+4. Key shape + TTL ─────────────────────────────────────────────────────

describe('identifier cache keyspace (H2)', () => {
  it('keys are prefix-first — a `${brandId}:*` pattern can never match them', () => {
    const key = identifierCacheKey(BRAND_A, 'email', SUBJECT_HASH);
    expect(key).toBe(`idcache:${BRAND_A}:idhash:email:${SUBJECT_HASH}`);
    expect(key.startsWith(`${BRAND_A}:`)).toBe(false);
    expect(globToRegExp(`${BRAND_A}:*`).test(key)).toBe(false);
  });

  it('primeMany stores under idcache keys WITH the configured TTL (staleness stays bounded)', async () => {
    const cache = new IdentifierCacheAdapter('redis://fake', TTL_SECONDS);
    await cache.primeMany(BRAND_A, [
      { type: 'email', hash: SUBJECT_HASH, brainId: BRAIN_A },
      { type: 'anon_id', hash: GRAPH_ONLY_HASH, brainId: BRAIN_A },
    ]);
    const entry = redisStore.get(identifierCacheKey(BRAND_A, 'email', SUBJECT_HASH));
    expect(entry?.value).toBe(BRAIN_A);
    expect(entry?.ttlSeconds).toBe(TTL_SECONDS);
    const got = await cache.getMany(BRAND_A, [{ type: 'email', hash: SUBJECT_HASH }]);
    expect(got).toEqual([BRAIN_A]);
  });
});

// ── 2. Brand-wide serving eviction no longer clears the identifier cache ─────

describe('ServingCacheEvictor vs idcache (H2)', () => {
  it('evictBrand deletes serving keys but NEVER idcache keys', async () => {
    const cache = new IdentifierCacheAdapter('redis://fake', TTL_SECONDS);
    await cache.primeMany(BRAND_A, [{ type: 'email', hash: SUBJECT_HASH, brainId: BRAIN_A }]);
    redisStore.set(`${BRAND_A}:metrics:revenue`, { value: 'x', ttlSeconds: null });
    redisStore.set(`${BRAND_A}:journey:t1`, { value: 'y', ttlSeconds: null });
    redisStore.set(`${BRAND_A}:flag:stitch.v2`, { value: 'on', ttlSeconds: null }); // durable config

    const client: ICacheEvictionClient = {
      del: async (key) => (redisStore.delete(key) ? 1 : 0),
      scan: async (_c, _m, pattern) => {
        const re = globToRegExp(pattern);
        return ['0', [...redisStore.keys()].filter((k) => re.test(k))];
      },
    };
    const deleted = await new ServingCacheEvictor(client).evictBrand(BRAND_A);

    expect(deleted).toBe(2); // the two serving keys only
    expect(redisStore.has(`${BRAND_A}:metrics:revenue`)).toBe(false);
    expect(redisStore.has(`${BRAND_A}:journey:t1`)).toBe(false);
    expect(redisStore.has(`${BRAND_A}:flag:stitch.v2`)).toBe(true); // AMD-23 exemption intact
    // The refresh-cycle brand-wide bust leaves the identifier cache WARM:
    expect(await cache.getMany(BRAND_A, [{ type: 'email', hash: SUBJECT_HASH }])).toEqual([BRAIN_A]);
  });
});

// ── 3+5. RTBF purge: exact, cross-subject/brand-safe, fail-closed ────────────

describe('erasure identifier-cache purge (STEP 3c)', () => {
  it('erasure removes EXACTLY the subject idcache keys (union of subject hash + graph hashes)', async () => {
    const cache = new IdentifierCacheAdapter('redis://fake', TTL_SECONDS);
    // Subject's entries: trigger hash (two types) + a graph-only hash.
    await cache.primeMany(BRAND_A, [
      { type: 'email', hash: SUBJECT_HASH, brainId: BRAIN_A },
      { type: 'phone', hash: SUBJECT_HASH, brainId: BRAIN_A },
      { type: 'anon_id', hash: GRAPH_ONLY_HASH, brainId: BRAIN_A },
    ]);
    // Another subject in the SAME brand and the same hash in a DIFFERENT brand must survive.
    await cache.primeMany(BRAND_A, [{ type: 'email', hash: OTHER_SUBJECT_HASH, brainId: randomUUID() }]);
    await cache.primeMany(BRAND_B, [{ type: 'email', hash: SUBJECT_HASH, brainId: randomUUID() }]);

    const result = await makeEraseUseCase({
      purge: cache,
      graphHashes: [SUBJECT_HASH, GRAPH_ONLY_HASH],
    }).execute(makeErasureEvent(), new Date().toISOString());

    expect(result.outcome).toBe('erased');
    expect(result.idCacheKeysPurged).toBe(3);
    // The shredded subject's hashes no longer resolve — post-erasure events re-mint:
    expect(redisStore.has(identifierCacheKey(BRAND_A, 'email', SUBJECT_HASH))).toBe(false);
    expect(redisStore.has(identifierCacheKey(BRAND_A, 'phone', SUBJECT_HASH))).toBe(false);
    expect(redisStore.has(identifierCacheKey(BRAND_A, 'anon_id', GRAPH_ONLY_HASH))).toBe(false);
    // Other subject + other brand untouched:
    expect(redisStore.has(identifierCacheKey(BRAND_A, 'email', OTHER_SUBJECT_HASH))).toBe(true);
    expect(redisStore.has(identifierCacheKey(BRAND_B, 'email', SUBJECT_HASH))).toBe(true);
  });

  it('purge failure is FAIL-CLOSED — the erasure sequence rejects (row retries)', async () => {
    const cache = new IdentifierCacheAdapter('redis://fake', TTL_SECONDS);
    await cache.primeMany(BRAND_A, [{ type: 'email', hash: SUBJECT_HASH, brainId: BRAIN_A }]);
    redisFailing = true;
    await expect(
      makeEraseUseCase({ purge: cache, graphHashes: [] }).execute(
        makeErasureEvent(),
        new Date().toISOString(),
      ),
    ).rejects.toThrow('redis down');
  });

  it('purgeSubjectHashes refuses an empty brandId (tenant guard) and is idempotent on absent keys', async () => {
    const cache = new IdentifierCacheAdapter('redis://fake', TTL_SECONDS);
    expect(await cache.purgeSubjectHashes('', [SUBJECT_HASH])).toBe(0);
    expect(await cache.purgeSubjectHashes(BRAND_A, [SUBJECT_HASH])).toBe(0); // nothing cached → 0
  });
});
