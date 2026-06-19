/**
 * sentry.test.ts — gated error tracking: no-op without a DSN, captures with PII redaction when on,
 * and the logger.error path forwards the real Error to Sentry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { initSentry, captureError, __setSentryForTest } from './sentry.js';
import { createLogger } from './logger.js';

function fakeSentry() {
  const calls: Array<{ err: unknown; extra?: Record<string, unknown> }> = [];
  return {
    calls,
    init() {},
    captureException(err: unknown, hint?: { extra?: Record<string, unknown> }) {
      calls.push({ err, extra: hint?.extra });
    },
    async close() {
      return true;
    },
  };
}

afterEach(() => __setSentryForTest(null));

describe('sentry error tracking', () => {
  it('initSentry is a no-op without a DSN', async () => {
    const close = await initSentry({ serviceName: 'core', dsn: undefined });
    await expect(close()).resolves.toBeUndefined();
  });

  it('captureError is a no-op when Sentry is not initialized (never throws)', () => {
    expect(() => captureError(new Error('boom'), { foo: 1 })).not.toThrow();
  });

  it('captures the exception and REDACTS PII in extra', () => {
    const fake = fakeSentry();
    __setSentryForTest(fake);
    captureError(new Error('boom'), { email: 'pii@example.com', brand_id: 'b-1' });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect((call.err as Error).message).toBe('boom');
    expect(call.extra?.email).toBe('[REDACTED]');
    expect(call.extra?.brand_id).toBe('b-1');
  });

  it('logger.error forwards the real Error to Sentry (with stack) + scrubbed extra', () => {
    const fake = fakeSentry();
    __setSentryForTest(fake);
    const log = createLogger({ serviceName: 'core', level: 'error', destination: { write() {} } });
    const err = new Error('db down');
    log.error('startup failed', { err, email: 'leak@x.com', brand_id: 'b-2' });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect((call.err as Error).message).toBe('db down');
    expect((call.err as Error).stack).toBeTruthy(); // Sentry DOES get the stack
    expect(call.extra?.email).toBe('[REDACTED]');
    expect(call.extra?.brand_id).toBe('b-2');
    expect(call.extra?.['err']).toBeUndefined(); // err pulled out, not duplicated in extra
  });
});
