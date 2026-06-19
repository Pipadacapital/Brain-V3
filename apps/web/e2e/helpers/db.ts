import { Client } from 'pg';
import { Redis } from 'ioredis';

/**
 * Dev e2e helper: mark a registered user's email as verified.
 *
 * In development the app deliberately sends no real email (DevEmailAdapter logs
 * the token and stores only its sha256 hash). This helper simulates the user
 * clicking the verification link, so the smoke can proceed to login.
 */
const DSN = process.env.DATABASE_URL ?? 'postgres://brain:brain@localhost:5432/brain';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Clear the auth rate-limit counters (rl:* Redis keys). register is capped at 10/hour/IP;
 * a comprehensive suite registers far more users than that from one IP, so global-setup's
 * single clear is not enough — every registration helper clears first so the suite self-heals
 * (registration never spuriously "stays on /register"). Resilient: a missing Redis is a no-op.
 */
export async function clearAuthRateLimits(): Promise<void> {
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    const keys = await redis.keys('rl:*');
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Redis unreachable — tests that don't register are unaffected; continue.
  } finally {
    redis.disconnect();
  }
}

export async function markEmailVerified(email: string): Promise<void> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    await client.query(
      'UPDATE app_user SET email_verified_at = now(), updated_at = now() WHERE email = $1',
      [email],
    );
  } finally {
    await client.end();
  }
}

/**
 * Force a user back to UNVERIFIED. In dev the backend auto-verifies email on registration
 * (NODE_ENV != production), which defeats the "unverified" contract registerUnverified needs for
 * soft-gate tests (the verify-email banner + sensitive-action blocks). Nulling email_verified_at
 * restores a genuinely-unverified session.
 */
export async function markEmailUnverified(email: string): Promise<void> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    await client.query(
      'UPDATE app_user SET email_verified_at = NULL, updated_at = now() WHERE email = $1',
      [email],
    );
  } finally {
    await client.end();
  }
}
