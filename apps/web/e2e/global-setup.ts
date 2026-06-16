import { Redis } from 'ioredis';

/**
 * Playwright global setup — clear auth rate-limit counters before the suite runs.
 *
 * The suite registers ~a dozen users from a single IP, and the backend rate-limits
 * register (10/hour/IP), login, and forgot-password by IP/email (rl:* Redis keys).
 * Without this, repeated full-suite runs exhaust the register limiter and registration
 * starts returning 429 — surfacing as spurious "stayed on /register" failures.
 * Clearing the rl:* keys makes the suite self-healing.
 *
 * Resilient by design: if Redis is unreachable it warns and continues (tests that
 * don't register are unaffected), rather than aborting the whole run.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: () => null, // fail fast — don't hang the suite on a missing Redis
  });

  try {
    await redis.connect();
    const keys = await redis.keys('rl:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    console.log(`[e2e global-setup] cleared ${keys.length} rate-limit key(s)`);
  } catch (err) {
    console.warn(
      `[e2e global-setup] could not clear rate-limit keys (${(err as Error).message}). ` +
        'Continuing — registration-heavy tests may hit the limiter.',
    );
  } finally {
    redis.disconnect();
  }
}
