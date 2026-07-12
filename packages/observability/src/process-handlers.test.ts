/**
 * process-handlers tests (AUD-IMPL-003) — the last-resort handlers must route through the
 * structured logger (→ Sentry via log.error) and exit non-zero, without leaving listeners
 * behind after unregister.
 */
import { describe, it, expect, vi } from 'vitest';
import { registerProcessFailureHandlers } from './process-handlers.js';
import type { BrainLogger, LogFields } from './logger.js';

function fakeLogger(): { log: BrainLogger; errors: Array<{ msg: string; fields?: LogFields }> } {
  const errors: Array<{ msg: string; fields?: LogFields }> = [];
  const log: BrainLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg, fields) => {
      errors.push({ msg, fields });
    },
    child: () => log,
  };
  return { log, errors };
}

describe('registerProcessFailureHandlers', () => {
  it('logs an unhandledRejection through the structured logger and exits 1', () => {
    const { log, errors } = fakeLogger();
    const exit = vi.fn();
    const unregister = registerProcessFailureHandlers({ log, serviceName: 'svc-a', exit });
    try {
      const boom = new Error('lost promise');
      process.listeners('unhandledRejection').at(-1)?.call(process, boom, Promise.resolve());
      expect(errors).toHaveLength(1);
      expect(errors[0]?.msg).toContain('[svc-a] FATAL: unhandled promise rejection');
      expect(errors[0]?.fields?.['err']).toBe(boom); // REAL Error → log.error forwards it to Sentry
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      unregister();
    }
  });

  it('wraps non-Error rejection reasons so the logger/Sentry always get an Error', () => {
    const { log, errors } = fakeLogger();
    const exit = vi.fn();
    const unregister = registerProcessFailureHandlers({ log, serviceName: 'svc-b', exit });
    try {
      process.listeners('unhandledRejection').at(-1)?.call(process, 'plain-string', Promise.resolve());
      const err = errors[0]?.fields?.['err'];
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('plain-string');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      unregister();
    }
  });

  it('logs an uncaughtException and exits 1', () => {
    const { log, errors } = fakeLogger();
    const exit = vi.fn();
    const unregister = registerProcessFailureHandlers({ log, serviceName: 'svc-c', exit });
    try {
      const boom = new Error('sync throw');
      process.listeners('uncaughtException').at(-1)?.call(process, boom, 'uncaughtException');
      expect(errors[0]?.msg).toContain('[svc-c] FATAL: uncaught exception');
      expect(errors[0]?.fields?.['err']).toBe(boom);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      unregister();
    }
  });

  it('awaits the telemetry flush before exiting (so the event leaves the process)', async () => {
    const { log } = fakeLogger();
    const exit = vi.fn();
    let flushed = false;
    const flush = vi.fn(async () => {
      flushed = true;
    });
    const unregister = registerProcessFailureHandlers({ log, serviceName: 'svc-d', exit, flush });
    try {
      process.listeners('uncaughtException').at(-1)?.call(process, new Error('x'), 'uncaughtException');
      expect(exit).not.toHaveBeenCalled(); // not before the flush resolves
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(flushed).toBe(true);
    } finally {
      unregister();
    }
  });

  it('unregister removes both listeners (no leak into other tests)', () => {
    const { log } = fakeLogger();
    const before = {
      rej: process.listenerCount('unhandledRejection'),
      exc: process.listenerCount('uncaughtException'),
    };
    const unregister = registerProcessFailureHandlers({ log, serviceName: 'svc-e', exit: vi.fn() });
    expect(process.listenerCount('unhandledRejection')).toBe(before.rej + 1);
    expect(process.listenerCount('uncaughtException')).toBe(before.exc + 1);
    unregister();
    expect(process.listenerCount('unhandledRejection')).toBe(before.rej);
    expect(process.listenerCount('uncaughtException')).toBe(before.exc);
  });
});
