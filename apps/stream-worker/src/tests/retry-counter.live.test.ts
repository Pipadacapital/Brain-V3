/**
 * retry-counter.live.test.ts — T2-8 durability proof (live Redis).
 *
 * The whole point of moving the retry counter to Redis: it must SURVIVE a process restart so a
 * poison message reaches the DLQ instead of looping forever. We simulate a restart by counting on
 * one adapter instance, then reading the count from a SECOND adapter instance (fresh process would
 * have lost an in-memory Map). Also proves the {scope} keeps same-(partition,offset) isolated
 * across consumer groups, and that reset() clears the slot.
 *
 * Skips cleanly when Redis is unavailable (mirrors the other *.live.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RetryCounterAdapter } from '../infrastructure/redis/RetryCounterAdapter.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const SCOPE_A = 'group-a:test.topic';
const SCOPE_B = 'group-b:test.topic';

let a1: RetryCounterAdapter;
let a2: RetryCounterAdapter;
let redisAvailable = false;

beforeAll(async () => {
  try {
    a1 = new RetryCounterAdapter(REDIS_URL);
    await a1.connect();
    // clean any prior keys for these scopes/offset
    await a1.reset(SCOPE_A, 0, '99');
    await a1.reset(SCOPE_B, 0, '99');
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  }
});

afterAll(async () => {
  if (redisAvailable) {
    await a1.reset(SCOPE_A, 0, '99').catch(() => {});
    await a1.reset(SCOPE_B, 0, '99').catch(() => {});
    await a1?.quit?.().catch(() => {});
    await a2?.quit?.().catch(() => {});
  }
});

describe('RetryCounterAdapter durability (T2-8, live Redis)', () => {
  it('SKIP_IF_NO_REDIS', () => {
    if (!redisAvailable) console.warn('[retry-counter] Redis unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('a count survives a simulated restart (a SECOND adapter instance sees it)', async () => {
    if (!redisAvailable) return;
    expect(await a1.increment(SCOPE_A, 0, '99')).toBe(1);
    expect(await a1.increment(SCOPE_A, 0, '99')).toBe(2);
    expect(await a1.increment(SCOPE_A, 0, '99')).toBe(3);

    // Simulate a restart: a brand-new adapter (an in-memory Map would have reset to 0 here).
    a2 = new RetryCounterAdapter(REDIS_URL);
    await a2.connect();
    expect(await a2.increment(SCOPE_A, 0, '99')).toBe(4); // continues from 3, NOT 1
  });

  it('different consumer-group scopes do NOT share a counter at the same partition+offset', async () => {
    if (!redisAvailable) return;
    // SCOPE_A is already at 4 from the prior test; SCOPE_B must start fresh.
    expect(await a1.increment(SCOPE_B, 0, '99')).toBe(1);
  });

  it('reset() clears the slot', async () => {
    if (!redisAvailable) return;
    await a1.reset(SCOPE_A, 0, '99');
    expect(await a1.increment(SCOPE_A, 0, '99')).toBe(1); // back to 1 after reset
  });
});
