/**
 * isolation-fuzz/redis.test.ts — Layer (c): Redis brandKey() (NN-2, NN-7)
 *
 * NEGATIVE-CONTROL DESIGN:
 *   - Verifies that brand-A's cached values are not accessible via brand-B's key
 *   - brandKey() is the ONLY sanctioned key builder (NN-7 lint enforces this)
 *   - A raw key (not using brandKey) for brand-B's data would be isolated by key prefix
 *   - Tests verify: (1) brand-A key prefix is correct, (2) brand-B cannot read brand-A's value
 *
 * Sprint-0 note: Redis live tests require docker-compose --profile core.
 * Pure-structural tests (key format, collision, throw checks) run without Redis.
 *
 * DEPENDENCY: @brain/tenant-context brandKey() (Track E, backend-developer).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Use the canonical brandKey() from tenant-context — NOT a local stub.
// The NN-7 lint rule bans raw key construction; the test uses the sanctioned path.
import { brandKey, rateLimitKey, sessionKey } from '@brain/tenant-context';

const BRAND_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRAND_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const BASE_PARAMS = {
  metricId: 'gmv_total',
  version: 1,
  filtersHash: 'abc12345',
  grain: 'day' as const,
  asOf: '2026-06-15',
};

// ── Redis client (optional; tests skip gracefully if Redis is unavailable) ────

interface RedisClientLike {
  set: (key: string, value: string, options?: { EX: number }) => Promise<'OK' | null>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<number>;
  quit: () => Promise<void>;
}

async function getRedisClient(): Promise<RedisClientLike | null> {
  try {
    const redis = await import('redis') as any;
    const client = redis.createClient({
      socket: {
        host: process.env['REDIS_HOST'] ?? 'localhost',
        port: Number(process.env['REDIS_PORT'] ?? 6379),
        connectTimeout: 5000,
      },
    });
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

let redisClient: RedisClientLike | null = null;
let redisAvailable = false;
const TEST_KEYS: string[] = [];

beforeAll(async () => {
  redisClient = await getRedisClient();
  redisAvailable = redisClient !== null;
  if (!redisAvailable) {
    console.warn(
      '[isolation-fuzz/redis] Redis not available — live tests are PENDING. ' +
        'Start docker compose --profile core and re-run.',
    );
  }
});

afterAll(async () => {
  if (redisClient) {
    for (const key of TEST_KEYS) {
      await redisClient.del(key);
    }
    await redisClient.quit();
  }
});

// ── Pure-structural tests (no Redis required) ─────────────────────────────────

describe('brandKey() — structural isolation (NN-2, NN-7) — no Redis required', () => {
  it('generates a key that contains the brand_id', () => {
    const key = brandKey({ ...BASE_PARAMS, brandId: BRAND_A });
    expect(key).toContain(BRAND_A);
  });

  it('NEGATIVE CONTROL: Brand A and Brand B keys are NEVER equal', () => {
    const keyA = brandKey({ ...BASE_PARAMS, brandId: BRAND_A });
    const keyB = brandKey({ ...BASE_PARAMS, brandId: BRAND_B });
    // This assertion FAILS if brandKey() stops including brand_id in the key.
    expect(keyA).not.toBe(keyB);
  });

  it('throws when brandId is missing — prevents key construction without tenant context', () => {
    expect(() => brandKey({ ...BASE_PARAMS, brandId: '' })).toThrow('brandId is required');
  });

  it('throws when metricId is missing', () => {
    expect(() => brandKey({ ...BASE_PARAMS, brandId: BRAND_A, metricId: '' })).toThrow(
      'metricId is required',
    );
  });

  it('throws when version is invalid', () => {
    expect(() => brandKey({ ...BASE_PARAMS, brandId: BRAND_A, version: 0 })).toThrow(
      'version must be a positive integer',
    );
  });

  it('throws on separator injection in a segment', () => {
    expect(() =>
      brandKey({ ...BASE_PARAMS, brandId: BRAND_A, filtersHash: 'bad:hash' }),
    ).toThrow('must not contain ":"');
  });

  it('key format contains the brain:v1:brand: prefix', () => {
    const key = brandKey({ ...BASE_PARAMS, brandId: BRAND_A });
    expect(key.startsWith('brain:v1:brand:')).toBe(true);
  });

  it('keys are deterministic for the same inputs', () => {
    const k1 = brandKey({ ...BASE_PARAMS, brandId: BRAND_A });
    const k2 = brandKey({ ...BASE_PARAMS, brandId: BRAND_A });
    expect(k1).toBe(k2);
  });

  it('rate-limit keys are brand-scoped', () => {
    const w = 27_768_700;
    const kA = rateLimitKey({ brandId: BRAND_A, resource: 'api:ingest', windowBucket: w });
    const kB = rateLimitKey({ brandId: BRAND_B, resource: 'api:ingest', windowBucket: w });
    expect(kA).not.toBe(kB);
    expect(kA).toContain(BRAND_A);
    expect(kB).toContain(BRAND_B);
  });

  it('session keys are brand-scoped', () => {
    const hash = 'abc123def456';
    const kA = sessionKey({ brandId: BRAND_A, sessionTokenHash: hash });
    const kB = sessionKey({ brandId: BRAND_B, sessionTokenHash: hash });
    expect(kA).not.toBe(kB);
  });
});

// ── Live Redis tests (require docker-compose) ─────────────────────────────────

describe('brandKey() — live Redis isolation (NN-2) — requires docker-compose', () => {
  it('[NEGATIVE-CONTROL] brand-A data is NOT accessible via brand-B key', async () => {
    if (!redisAvailable || !redisClient) {
      console.warn('[skip] Redis unavailable');
      return;
    }

    const keyA = brandKey({ ...BASE_PARAMS, brandId: BRAND_A });
    const keyB = brandKey({ ...BASE_PARAMS, brandId: BRAND_B });

    TEST_KEYS.push(keyA, keyB);

    // Write brand-A's value
    await redisClient.set(keyA, JSON.stringify({ value: 100000, currency: 'INR' }), { EX: 60 });

    // brand-B's key is structurally different — cannot accidentally read brand-A's value
    const brandBValue = await redisClient.get(keyB);

    // NEGATIVE CONTROL: if brand-B could read brand-A's data, this would be non-null.
    // With brandKey() isolation, it is always null.
    expect(brandBValue).toBeNull();
  });

  it('[positive] brand-A can read its own cached value', async () => {
    if (!redisAvailable || !redisClient) {
      console.warn('[skip] Redis unavailable');
      return;
    }

    const key = brandKey({
      brandId: BRAND_A,
      metricId: 'order_count',
      version: 1,
      filtersHash: 'def45678',
      grain: 'day',
      asOf: '2026-06-15',
    });

    TEST_KEYS.push(key);
    const payload = { count: 42, brand_id: BRAND_A };
    await redisClient.set(key, JSON.stringify(payload), { EX: 60 });

    const cached = await redisClient.get(key);
    expect(cached).not.toBeNull();

    const parsed = JSON.parse(cached!);
    expect(parsed.brand_id).toBe(BRAND_A);
    expect(parsed.count).toBe(42);
  });

  it('[NEGATIVE-CONTROL] raw key (not using brandKey) anti-pattern documented (NN-7)', () => {
    // This test documents the banned pattern that NN-7 lint prevents:
    //   await redis.get('metric:gmv_total:day:2026-06-15')   // NO brand_id — BANNED
    //
    // Without brand_id in the key, both brands map to the same key → cross-brand data access.
    // The ESLint rule `no-raw-redis-key` (Track A) statically flags this pattern.
    //
    // The structural tests above prove that brandKey() keys are never equal across brands,
    // which is the runtime guarantee that makes raw keys unsafe.

    const rawKey = 'metric:gmv_total:day:2026-06-15';
    const safeKeyA = brandKey({ ...BASE_PARAMS, brandId: BRAND_A });

    // Raw key lacks brand prefix
    expect(rawKey).not.toContain(BRAND_A);
    expect(rawKey).not.toContain(BRAND_B);

    // Safe key is brand-scoped
    expect(safeKeyA).toContain(BRAND_A);
    expect(safeKeyA).not.toContain(BRAND_B);
  });
});
