/**
 * spool-backpressure.test.ts — bounded admission gate hysteresis (C4, R-09).
 *
 * Deterministic tier-1 capacity gate. Tests the pure state machine (applySample/admit/snapshot)
 * and the sampler's fail-open behaviour with a fake repo — no HTTP server, no real DB, no clock.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { SpoolBackpressure, registerSpoolBackpressure } from '../src/interfaces/rest/spool-backpressure.js';
import type { SpoolRepository } from '../src/domain/ingest/repositories/spool.repository.js';

const CFG = {
  maxPending: 100,
  resumePending: 80,
  sampleIntervalMs: 1000,
  retryAfterSeconds: 5,
};

/** A SpoolRepository stub whose countPendingBounded returns scripted depths (or throws). */
function fakeRepo(countImpl: (cap: number) => Promise<number>): SpoolRepository {
  return {
    insert: async () => 1n,
    claimPending: async () => ({
      entries: [],
      markDrained: async () => {},
      commit: async () => {},
      rollback: async () => {},
    }),
    countPendingBounded: countImpl,
    reapDrained: async () => 0,
    ping: async () => true,
  };
}

describe('SpoolBackpressure — hysteresis state machine', () => {
  it('admits while below the high-water mark', () => {
    const gate = new SpoolBackpressure(fakeRepo(async () => 0), CFG);
    gate.applySample(0);
    expect(gate.admit()).toBe(true);
    gate.applySample(99); // below maxPending
    expect(gate.admit()).toBe(true);
  });

  it('trips at the high-water mark (>= maxPending) → sheds', () => {
    const gate = new SpoolBackpressure(fakeRepo(async () => 0), CFG);
    gate.applySample(100);
    expect(gate.admit()).toBe(false);
    expect(gate.snapshot()).toEqual({ pendingDepth: 100, tripped: true });
  });

  it('holds the tripped state inside the deadband (anti-flap)', () => {
    const gate = new SpoolBackpressure(fakeRepo(async () => 0), CFG);
    gate.applySample(100); // trip
    expect(gate.admit()).toBe(false);
    gate.applySample(90); // between resume(80) and max(100) → still shedding
    expect(gate.admit()).toBe(false);
    gate.applySample(80); // still at the low-water mark, not yet below → hold
    expect(gate.admit()).toBe(false);
  });

  it('clears only once depth recedes BELOW the low-water mark', () => {
    const gate = new SpoolBackpressure(fakeRepo(async () => 0), CFG);
    gate.applySample(100); // trip
    gate.applySample(79); // below resumePending → clear
    expect(gate.admit()).toBe(true);
  });

  it('does not flap: an untripped gate stays open inside the deadband', () => {
    const gate = new SpoolBackpressure(fakeRepo(async () => 0), CFG);
    gate.applySample(50); // open
    gate.applySample(90); // deadband, but never tripped → still open
    expect(gate.admit()).toBe(true);
  });

  it('rejects a config without a hysteresis gap (resume >= max)', () => {
    expect(
      () => new SpoolBackpressure(fakeRepo(async () => 0), { ...CFG, resumePending: 100 }),
    ).toThrow(/resumePending/);
  });

  it('exposes the configured Retry-After', () => {
    const gate = new SpoolBackpressure(fakeRepo(async () => 0), CFG);
    expect(gate.retryAfterSeconds).toBe(5);
  });
});

describe('SpoolBackpressure — sampler', () => {
  it('sampleOnce queries with a bounded cap (maxPending + 1) and applies the depth', async () => {
    const seen: number[] = [];
    const gate = new SpoolBackpressure(
      fakeRepo(async (cap) => {
        seen.push(cap);
        return 100;
      }),
      CFG,
    );
    await gate.sampleOnce();
    expect(seen).toEqual([101]); // O(maxPending) bound, not a full COUNT(*)
    expect(gate.admit()).toBe(false); // depth 100 tripped it
  });

  it('fails OPEN on a sampler error — holds the last known state, never fabricates "full"', async () => {
    let mode: 'ok' | 'throw' = 'ok';
    const onError = vi.fn();
    const gate = new SpoolBackpressure(
      fakeRepo(async () => {
        if (mode === 'throw') throw new Error('db hiccup');
        return 10;
      }),
      CFG,
      onError,
    );
    await gate.sampleOnce(); // depth 10 → open
    expect(gate.admit()).toBe(true);
    mode = 'throw';
    await gate.sampleOnce(); // COUNT throws → keep last state (open), not tripped
    expect(gate.admit()).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('registerSpoolBackpressure — uniform shed over /collect, /v1/events and /batch (AUD-PERF-001)', () => {
  async function buildTrippedApp() {
    const gate = new SpoolBackpressure(fakeRepo(async () => 0), CFG);
    gate.applySample(CFG.maxPending); // trip
    const app = Fastify({ logger: false });
    registerSpoolBackpressure(app, gate);
    app.post('/collect', async () => ({ accepted: true }));
    app.post('/v1/events', async () => ({ accepted: true }));
    app.post('/batch', async () => ({ accepted: true }));
    await app.ready();
    return app;
  }

  it('a tripped gate sheds /batch with 503 SPOOL_FULL (was previously unguarded)', async () => {
    const app = await buildTrippedApp();
    const res = await app.inject({ method: 'POST', url: '/batch', payload: { events: [{}] } });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(CFG.retryAfterSeconds));
    await app.close();
  });

  it('a query-string suffix cannot bypass a tripped gate on /collect', async () => {
    const app = await buildTrippedApp();
    const res = await app.inject({ method: 'POST', url: '/collect?x=1', payload: {} });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
