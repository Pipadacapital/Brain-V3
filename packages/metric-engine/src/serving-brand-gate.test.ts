// SPEC: D.3 / §1.11.3
/**
 * Per-brand Trino admission gate (concurrency + FIFO queue + timeout) — §1.11.3.
 *
 * The gate protects the single serving chokepoint (the ServingPool) so ONE brand's fan-out cannot
 * exhaust the shared coordinator and starve every other tenant. These tests prove:
 *   1. per-brand concurrency cap: at most N in-flight per brand_id (a 2nd brand is unaffected).
 *   2. FIFO fairness: over-limit queries run in arrival order once slots free up.
 *   3. queue-full → REJECT (fail-loud, bounded memory) not silent drop / unbounded growth.
 *   4. acquire-timeout → REJECT (a saturated brand never pins a BFF request forever).
 *   5. brand key = LAST string param (the ${BRAND_PREDICATE} seam invariant); no tail → shared bucket.
 *   6. a wrapped-pool error still RELEASES the slot (no permanent leak).
 *   7. default-permissive: normal load passes straight through unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPerBrandServingGate, defaultBrandKeyOf, ServingGateRejectedError } from './serving-brand-gate.js';
import type { ServingPool } from './serving-deps.js';

const BRAND_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRAND_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** A controllable pool: each query blocks on a manually-resolved deferred keyed by call order. */
function deferredPool() {
  const gates: Array<{ resolve: (rows: unknown[]) => void; reject: (e: Error) => void }> = [];
  let active = 0;
  let peak = 0;
  const pool: ServingPool = {
    async query<T = Record<string, unknown>>(_sql: string, _params: unknown[] = []): Promise<T[]> {
      active++;
      peak = Math.max(peak, active);
      try {
        return (await new Promise<unknown[]>((resolve, reject) => {
          gates.push({ resolve, reject });
        })) as T[];
      } finally {
        active--;
      }
    },
  };
  return { pool, gates, peakActive: () => peak, activeNow: () => active };
}

describe('D3 / §1.11.3 — per-brand Trino admission gate', () => {
  it('brandKeyOf: last string param is the brand key; no string tail → undefined (shared bucket)', () => {
    expect(defaultBrandKeyOf(['SELECT 1', BRAND_A])).toBe(BRAND_A);
    expect(defaultBrandKeyOf([BRAND_A])).toBe(BRAND_A);
    expect(defaultBrandKeyOf([1, 2, 3])).toBeUndefined();
    expect(defaultBrandKeyOf([])).toBeUndefined();
    expect(defaultBrandKeyOf(['x', ''])).toBeUndefined(); // empty tail is not a key
  });

  it('caps in-flight queries PER brand and lets a second brand run unaffected', async () => {
    const { pool, gates, peakActive } = deferredPool();
    const gate = createPerBrandServingGate(pool, { maxConcurrentPerBrand: 2 });

    // 3 queries for brand A: only 2 admitted; the 3rd queues.
    const a1 = gate.query('q', [BRAND_A]);
    const a2 = gate.query('q', [BRAND_A]);
    const a3 = gate.query('q', [BRAND_A]);
    // 1 query for brand B: its own bucket → admitted immediately despite A being saturated.
    const b1 = gate.query('q', [BRAND_B]);

    await Promise.resolve(); // let microtasks flush
    expect(gates.length).toBe(3); // a1, a2 (A cap=2) + b1 (B) admitted; a3 queued
    expect(peakActive()).toBe(3);

    // Free one A slot → a3 is promoted.
    gates[0]!.resolve([{ ok: 1 }]);
    await a1;
    await Promise.resolve();
    expect(gates.length).toBe(4);

    for (let i = 1; i < gates.length; i++) gates[i]!.resolve([{ ok: 1 }]);
    await Promise.all([a2, a3, b1]);
  });

  it('serves queued waiters in FIFO arrival order', async () => {
    const { pool, gates } = deferredPool();
    const gate = createPerBrandServingGate(pool, { maxConcurrentPerBrand: 1 });
    const order: number[] = [];

    const p0 = gate.query('q', [BRAND_A]).then(() => order.push(0)); // admitted
    const p1 = gate.query('q', [BRAND_A]).then(() => order.push(1)); // queued 1st
    const p2 = gate.query('q', [BRAND_A]).then(() => order.push(2)); // queued 2nd
    await Promise.resolve();
    expect(gates.length).toBe(1);

    // Resolve each admitted query in turn; the gate promotes the next FIFO waiter each time.
    gates[0]!.resolve([]);
    await p0;
    await Promise.resolve();
    gates[1]!.resolve([]);
    await p1;
    await Promise.resolve();
    gates[2]!.resolve([]);
    await p2;

    expect(order).toEqual([0, 1, 2]);
  });

  it('rejects (queue_full) once concurrent + queue are saturated — fail-loud, bounded', async () => {
    const { pool, gates } = deferredPool();
    const gate = createPerBrandServingGate(pool, { maxConcurrentPerBrand: 1, maxQueuePerBrand: 1 });

    const a1 = gate.query('q', [BRAND_A]); // admitted
    const a2 = gate.query('q', [BRAND_A]); // queued (queue=1)
    await Promise.resolve();

    // 3rd exceeds concurrent(1)+queue(1) → immediate reject.
    await expect(gate.query('q', [BRAND_A])).rejects.toBeInstanceOf(ServingGateRejectedError);
    await expect(gate.query('q', [BRAND_A])).rejects.toMatchObject({ reason: 'queue_full', brandKey: BRAND_A });

    gates[0]!.resolve([]);
    await a1;
    await Promise.resolve();
    gates[gates.length - 1]!.resolve([]);
    await a2;
  });

  it('rejects (acquire_timeout) a query that cannot get a slot in time', async () => {
    vi.useFakeTimers();
    try {
      const { pool, gates } = deferredPool();
      const gate = createPerBrandServingGate(pool, { maxConcurrentPerBrand: 1, acquireTimeoutMs: 1_000 });

      const a1 = gate.query('q', [BRAND_A]); // admitted, never resolves in-window
      await Promise.resolve();
      const a2 = gate.query('q', [BRAND_A]); // queued → will time out
      const assertion = expect(a2).rejects.toMatchObject({ reason: 'acquire_timeout' });

      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      gates[0]!.resolve([]);
      await a1;
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the slot even when the wrapped pool THROWS (no permanent leak)', async () => {
    let calls = 0;
    const pool: ServingPool = {
      async query<T = Record<string, unknown>>(): Promise<T[]> {
        calls++;
        throw new Error('trino boom');
      },
    };
    const gate = createPerBrandServingGate(pool, { maxConcurrentPerBrand: 1 });
    await expect(gate.query('q', [BRAND_A])).rejects.toThrow('trino boom');
    // If the slot leaked, this second call would deadlock; it must proceed and throw again.
    await expect(gate.query('q', [BRAND_A])).rejects.toThrow('trino boom');
    expect(calls).toBe(2);
  });

  it('is default-permissive: under normal load it passes params through untouched', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const pool: ServingPool = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        seen.push({ sql, params });
        return [{ n: 1n }] as T[];
      },
    };
    const gate = createPerBrandServingGate(pool); // shipped defaults
    const rows = await gate.query('SELECT 1', ['p', BRAND_A]);
    expect(rows).toEqual([{ n: 1n }]);
    expect(seen).toEqual([{ sql: 'SELECT 1', params: ['p', BRAND_A] }]);
  });
});
