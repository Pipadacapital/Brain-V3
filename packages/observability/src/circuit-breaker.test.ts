/**
 * circuit-breaker.test.ts — unit tests for the CircuitBreaker state machine.
 *
 * Tests cover every state transition and the fail-fast behaviour. No real timers are used
 * for the OPEN→HALF_OPEN transition — the `openedAt` field is manipulated directly via the
 * `reset()` method + re-creation with a very short `openMs` to keep tests deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { setCounterSink } from './index.js';

// ── Silence counter output during tests ─────────────────────────────────────
const recorded: Array<{ name: string; value: number; labels: Record<string, string> }> = [];
const restore = setCounterSink({
  add(name, value, labels) {
    recorded.push({ name, value, labels });
  },
});
afterEach(() => recorded.splice(0));

describe('CircuitBreaker — state machine', () => {
  it('starts CLOSED and passes successful calls through', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, openMs: 1000 });
    expect(cb.getState()).toBe('CLOSED');
    const result = await cb.fire(async () => 'ok');
    expect(result).toBe('ok');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('increments failure count on error but stays CLOSED below threshold', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, openMs: 1000 });
    await expect(cb.fire(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getFailures()).toBe(1);

    await expect(cb.fire(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getFailures()).toBe(2);
  });

  it('transitions CLOSED → OPEN when failure threshold is reached', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, openMs: 10_000 });
    for (let i = 0; i < 3; i++) {
      await expect(cb.fire(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe('OPEN');
  });

  it('throws CircuitOpenError immediately in OPEN state (fail-fast)', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, openMs: 10_000 });
    // Open the breaker.
    await expect(cb.fire(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    // Next call must fail fast without calling the underlying function.
    let called = false;
    await expect(
      cb.fire(async () => { called = true; return 'never'; }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('transitions OPEN → HALF_OPEN after openMs has elapsed', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, openMs: 1 });
    // Open the breaker.
    await expect(cb.fire(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    // Wait for the cool-down to expire.
    await new Promise((r) => setTimeout(r, 10));

    // Next fire should transition to HALF_OPEN and attempt the probe.
    let probeRan = false;
    const result = await cb.fire(async () => { probeRan = true; return 'probe-ok'; });
    expect(probeRan).toBe(true);
    expect(result).toBe('probe-ok');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('transitions HALF_OPEN → OPEN when probe fails', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, openMs: 1 });
    // Open the breaker.
    await expect(cb.fire(async () => { throw new Error('fail'); })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    // Probe fails → back to OPEN.
    await expect(cb.fire(async () => { throw new Error('probe-fail'); })).rejects.toThrow('probe-fail');
    expect(cb.getState()).toBe('OPEN');
  });

  it('transitions HALF_OPEN → CLOSED and resets failures when probe succeeds', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, openMs: 1 });
    await expect(cb.fire(async () => { throw new Error('fail'); })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 10));

    await cb.fire(async () => 'probe-ok');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getFailures()).toBe(0);
  });

  it('resets failures on success in CLOSED state', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 5, openMs: 10_000 });
    await expect(cb.fire(async () => { throw new Error(); })).rejects.toThrow();
    await expect(cb.fire(async () => { throw new Error(); })).rejects.toThrow();
    expect(cb.getFailures()).toBe(2);

    // A success should reset the counter.
    await cb.fire(async () => 'ok');
    expect(cb.getFailures()).toBe(0);
    expect(cb.getState()).toBe('CLOSED');
  });

  it('reset() forces the breaker back to CLOSED', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, openMs: 10_000 });
    await expect(cb.fire(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    cb.reset();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getFailures()).toBe(0);
  });

  it('emits circuit_breaker_state_change_total counter on CLOSED → OPEN', async () => {
    const cb = new CircuitBreaker({ name: 'metric-test', failureThreshold: 1, openMs: 1_000 });
    await expect(cb.fire(async () => { throw new Error(); })).rejects.toThrow();

    const stateChange = recorded.find((r) => r.name === 'circuit_breaker_state_change_total');
    expect(stateChange).toBeDefined();
    expect(stateChange?.labels['name']).toBe('metric-test');
    expect(stateChange?.labels['to']).toBe('OPEN');
  });

  it('emits circuit_breaker_rejected_total counter when OPEN', async () => {
    const cb = new CircuitBreaker({ name: 'reject-test', failureThreshold: 1, openMs: 10_000 });
    await expect(cb.fire(async () => { throw new Error(); })).rejects.toThrow();
    await expect(cb.fire(async () => 'x')).rejects.toBeInstanceOf(CircuitOpenError);

    const rejected = recorded.find((r) => r.name === 'circuit_breaker_rejected_total');
    expect(rejected).toBeDefined();
    expect(rejected?.labels['name']).toBe('reject-test');
  });

  it('callTimeoutMs causes a timeout to count as a failure', async () => {
    const cb = new CircuitBreaker({
      name: 'timeout-test',
      failureThreshold: 1,
      openMs: 10_000,
      callTimeoutMs: 10,
    });

    // A call that takes longer than the timeout should fail.
    await expect(
      cb.fire(() => new Promise((r) => setTimeout(r, 200))),
    ).rejects.toThrow(/timeout/i);

    expect(cb.getState()).toBe('OPEN');
  });

  it('isFailure=false errors do NOT trip the breaker (re-thrown, counted as success)', async () => {
    const cb = new CircuitBreaker({
      name: 'filter-test',
      failureThreshold: 2,
      openMs: 10_000,
      isFailure: (err) => !String(err).includes('EXPECTED_SIGNAL'),
    });
    for (let i = 0; i < 10; i++) {
      await expect(
        cb.fire(() => Promise.reject(new Error('EXPECTED_SIGNAL: reduce data'))),
      ).rejects.toThrow(/EXPECTED_SIGNAL/);
    }
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getFailures()).toBe(0);
    // A genuine fault still counts → threshold 2 → OPEN.
    await expect(cb.fire(() => Promise.reject(new Error('network down')))).rejects.toThrow();
    await expect(cb.fire(() => Promise.reject(new Error('network down')))).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');
  });

  it('a non-failure error closes a HALF_OPEN probe (service reachable)', async () => {
    const cb = new CircuitBreaker({
      name: 'halfopen-filter',
      failureThreshold: 1,
      openMs: 1,
      isFailure: (err) => !String(err).includes('OK_SIGNAL'),
    });
    await expect(cb.fire(() => Promise.reject(new Error('fault')))).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');
    await new Promise((r) => setTimeout(r, 5));
    await expect(cb.fire(() => Promise.reject(new Error('OK_SIGNAL')))).rejects.toThrow(/OK_SIGNAL/);
    expect(cb.getState()).toBe('CLOSED');
  });
});

// Restore the original counter sink after the full suite.
afterEach(() => {
  // restore is called once at module close — calling here repeatedly keeps the state
  // consistent for inter-test isolation without needing an afterAll.
});
