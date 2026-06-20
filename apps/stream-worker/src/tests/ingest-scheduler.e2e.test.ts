/**
 * ingest-scheduler.e2e.test.ts — feat-realtime-ingestion-pipeline Track A (data-engineer).
 *
 * Proves the continuous ingestion scheduler's tick contract (architecture §3.3):
 *
 *   T1 (dispatch ALL): a tick enumerates EVERY connected connector across EVERY brand
 *       and dispatches each provider's existing repull run() — SEQUENTIALLY (rate-limit
 *       safe), in enumerate order. Both brands' connectors are dispatched.
 *
 *   T2 (fail-isolation): one connector whose run() THROWS does NOT stop the tick — every
 *       other connector is still dispatched. The bad connector is logged, not fatal.
 *
 *   T3 (overlap-safe / no double-run): a connector whose run() is overlap-skipped (its own
 *       FOR UPDATE SKIP LOCKED returns nothing → run() is a no-op) is dispatched exactly
 *       once per tick — the scheduler adds NO new lock and never re-dispatches within a tick.
 *
 *   T4 (interval floor): startIngestScheduler clamps a sub-floor interval to MIN_INTERVAL_MS
 *       (anti-stampede), and stop() halts the loop.
 *
 *   T5 (isolation NON-INERT under brain_app): enumerateConnectedConnectors runs under a
 *       brain_app pool (is_superuser=false, current_user='brain_app') — the SECURITY-DEFINER
 *       enumerate path is exercised non-inert (the dev superuser 'brain' would mask RLS).
 *
 * The repull run() is mocked at the sync-request-claimer module boundary (the scheduler's
 * ONLY dispatch dependency) so the tick contract is asserted deterministically without
 * hitting a live provider API. T5 uses a real brain_app pool for the non-inert isolation proof.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { assertBrainApp } from './helpers/connector-lifecycle-fixtures.js';
import type { ConnectorRow } from '../jobs/sync-request-claimer/run.js';

// ── Mock the scheduler's dispatch dependency (claim + loadRun) ─────────────────
// P1 work-queue: the scheduler now CLAIMS a due batch via claimDueRepullConnectors + loadRun. We
// control both so the tick contract (sequential dispatch, fail-isolation, overlap-skip) is
// deterministic. The real claim_due_repull_connectors fn is exercised by the work-queue live test.
const claimMock = vi.fn(async (): Promise<ConnectorRow[]> => []);
const loadRunMock = vi.fn();

vi.mock('../jobs/sync-request-claimer/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jobs/sync-request-claimer/run.js')>();
  return {
    ...actual,
    claimDueRepullConnectors: () => claimMock(),
    loadRun: (provider: string) => loadRunMock(provider),
  };
});

// Import AFTER vi.mock so the scheduler binds the mocked symbols.
const { tick, startIngestScheduler, MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS } = await import(
  '../jobs/ingest-scheduler/run.js'
);

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

// Two brands × connectors — the "ALL brands × ALL connectors" enumerate result.
const BRAND_A = '218e5328-0000-4000-8000-00000000aaaa'; // Flipkart-shape
const BRAND_B = '60d543dc-0000-4000-8000-00000000bbbb'; // Bodd Active-shape
const ROWS: ConnectorRow[] = [
  { connector_instance_id: 'ci-a-shopify', brand_id: BRAND_A, provider: 'shopify' },
  { connector_instance_id: 'ci-b-shopify', brand_id: BRAND_B, provider: 'shopify' },
];

// A throwaway pool object — the mocked enumerate ignores it; tick() only forwards it.
const fakePool = {} as Pool;

beforeEach(() => {
  claimMock.mockReset();
  loadRunMock.mockReset();
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ── T1: dispatch ALL connectors across ALL brands, sequentially, in order ──────
describe('T1: tick dispatches every connected connector across every brand', () => {
  it('runs each provider repull once, in enumerate order (sequential)', async () => {
    claimMock.mockResolvedValue(ROWS);
    const callOrder: string[] = [];
    const runStub = vi.fn(async (ciId: string) => {
      callOrder.push(ciId);
    });
    loadRunMock.mockResolvedValue(runStub);

    const dispatched = await tick(fakePool, 100, 45);

    expect(dispatched).toBe(2);
    expect(runStub).toHaveBeenCalledTimes(2);
    // Both brands' connectors dispatched, in enumerate order (no Promise.all reorder).
    expect(callOrder).toEqual(['ci-a-shopify', 'ci-b-shopify']);
  });
});

// ── T2: one failing connector does NOT stop the tick (fail-isolation) ──────────
describe('T2: fail-isolation — a throwing connector does not block others', () => {
  it('continues the tick when one run() throws', async () => {
    claimMock.mockResolvedValue(ROWS);
    const seen: string[] = [];
    const runStub = vi.fn(async (ciId: string) => {
      seen.push(ciId);
      if (ciId === 'ci-a-shopify') throw new Error('provider 429 — rate limited');
    });
    loadRunMock.mockResolvedValue(runStub);

    const dispatched = await tick(fakePool, 100, 45);

    // Both connectors were ATTEMPTED (fail-isolation); only the healthy one counts as dispatched.
    expect(seen).toEqual(['ci-a-shopify', 'ci-b-shopify']);
    expect(dispatched).toBe(1);
  });
});

// ── T3: overlap-safe — an overlap-skipped run() is dispatched exactly once ─────
describe('T3: overlap-safe — no double-run within a tick', () => {
  it('dispatches each connector exactly once per tick (run() own lock is the guard)', async () => {
    claimMock.mockResolvedValue(ROWS);
    const counts = new Map<string, number>();
    // run() that simulates an overlap-skip (its FOR UPDATE SKIP LOCKED found the row locked
    // → no-op). The scheduler must NOT re-dispatch it within the tick.
    const runStub = vi.fn(async (ciId: string) => {
      counts.set(ciId, (counts.get(ciId) ?? 0) + 1);
      // no-op (overlap-skipped) — returns cleanly
    });
    loadRunMock.mockResolvedValue(runStub);

    await tick(fakePool, 100, 45);

    expect(counts.get('ci-a-shopify')).toBe(1);
    expect(counts.get('ci-b-shopify')).toBe(1);
  });

  it('skips a provider with no repull run() (loadRun null) without throwing', async () => {
    claimMock.mockResolvedValue([
      { connector_instance_id: 'ci-unknown', brand_id: BRAND_A, provider: 'tiktok' },
    ]);
    loadRunMock.mockResolvedValue(null);

    const dispatched = await tick(fakePool, 100, 45);
    expect(dispatched).toBe(0); // nothing dispatched, no throw
  });
});

// ── T4: interval floor + stop() ───────────────────────────────────────────────
describe('T4: interval floor + graceful stop', () => {
  it('clamps a sub-floor interval to MIN_INTERVAL_MS and stops cleanly', async () => {
    expect(DEFAULT_INTERVAL_MS).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);

    claimMock.mockResolvedValue([]);
    loadRunMock.mockResolvedValue(vi.fn());

    // Request a 1ms interval — must be clamped to the floor (no stampede).
    const handle = startIngestScheduler(fakePool, 1);
    // Give the first tick a moment to run (enumerate returns []).
    await new Promise((r) => setTimeout(r, 50));
    await handle.stop();

    // After clamp the loop sleeps MIN_INTERVAL_MS between ticks, so at most one tick fired
    // in the 50ms window — proves the floor is in effect (no tight-loop stampede).
    expect(claimMock.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

// ── T5: isolation NON-INERT under brain_app (real DB) ─────────────────────────
describe('T5: enumerate path is non-inert under brain_app', () => {
  it('brain_app pool is non-superuser (RLS enforced — not masked by dev superuser)', async () => {
    const appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 2 });
    try {
      // The load-bearing non-inert proof: if this pool were superuser 'brain', RLS would
      // be bypassed and the scheduler's per-brand isolation would be structurally inert.
      await assertBrainApp(appPool);

      // And the real SECURITY-DEFINER enumerate path executes under brain_app without error
      // (returns the live connected connectors — count is environment-dependent, so we only
      // assert it runs non-inert and returns an array, never throws under brain_app RLS).
      // vi.importActual bypasses the module mock above to exercise the REAL enumerate query.
      const actual = await vi.importActual<typeof import('../jobs/sync-request-claimer/run.js')>(
        '../jobs/sync-request-claimer/run.js',
      );
      const rows = await actual.enumerateConnectedConnectors(appPool);
      expect(Array.isArray(rows)).toBe(true);
    } finally {
      await appPool.end();
    }
  });
});
