/**
 * get-insights-briefing.test.ts — AUD-IMPL-029 regression guard for the briefing provenance probe.
 *
 * resolveBriefingDataSource probes the 4 INSIGHT_GOLD_MARTS for synthetic rows. The audit measured
 * the probes running SERIALLY (an awaited for-loop → up to ~1 s added to every cold briefing read);
 * the fix fans them out with Promise.all. These tests stub the Silver/Gold read seam (no Trino) and
 * assert (a) the synthetic-if-any aggregation + per-mart degradation semantics are unchanged, and
 * (b) all 4 probes are ISSUED before any of them resolves (true fan-out, not an awaited loop).
 *
 * NB: each test overwrites runScoped's implementation and clears recorded calls itself (mockClear) —
 * this file deliberately avoids beforeEach(mockReset) + macrotask waits, which proved flaky against
 * this SUT under the workspace vitest setup.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock the read seam: withSilverBrand hands `fn` a scope whose runScoped we control.
const runScoped = vi.fn();
vi.mock('@brain/metric-engine', () => ({
  withSilverBrand: (_pool: unknown, _brandId: string, fn: (s: { runScoped: typeof runScoped }) => unknown) =>
    fn({ runScoped }),
  BRAND_PREDICATE: 'brand_id = ?',
  // The SUT module also imports computeInsights (unused by resolveBriefingDataSource) — the
  // factory must provide every named export the module under test imports from the mocked module.
  computeInsights: vi.fn(),
}));

import { resolveBriefingDataSource } from './get-insights-briefing.js';

const deps = { srPool: {} as never };

describe('resolveBriefingDataSource — synthetic-if-any over the 4 gold marts', () => {
  it("returns 'synthetic' when ANY mart reports a synthetic row", async () => {
    runScoped.mockClear();
    runScoped.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).includes('mv_gold_customer_scores') ? [{ has_synthetic: 1 }] : [],
    );
    await expect(resolveBriefingDataSource('brand-1', deps)).resolves.toBe('synthetic');
    expect(runScoped).toHaveBeenCalledTimes(4);
  });

  it("returns 'live' when no mart reports synthetic; a throwing mart degrades, never fails", async () => {
    runScoped.mockClear();
    runScoped.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).includes('mv_gold_cac')) throw new Error("Column 'data_source' cannot be resolved");
      return [];
    });
    await expect(resolveBriefingDataSource('brand-1', deps)).resolves.toBe('live');
    expect(runScoped).toHaveBeenCalledTimes(4);
  });

  it('issues all 4 probes CONCURRENTLY (AUD-IMPL-029 — no awaited for-loop)', async () => {
    runScoped.mockClear();
    const resolvers: Array<(rows: unknown[]) => void> = [];
    runScoped.mockImplementation(
      () => new Promise<unknown[]>((resolve) => resolvers.push(resolve)),
    );

    // Promise.all's map issues every probe synchronously (each async arrow runs to its first
    // await, which IS the runScoped call) — so a true fan-out has all 4 probes in flight the
    // moment the SUT returns its promise, with NONE of them resolved yet. The pre-fix serial
    // loop would have issued exactly 1 here (it awaited each probe before issuing the next).
    const pending = resolveBriefingDataSource('brand-1', deps);
    expect(runScoped).toHaveBeenCalledTimes(4);
    expect(resolvers).toHaveLength(4);

    for (const resolve of resolvers) resolve([]);
    await expect(pending).resolves.toBe('live');
  });
});
