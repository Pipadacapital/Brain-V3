/**
 * semantic-preagg-refresh.test.ts — the AUD-SL-10 pre-agg materializer orchestration.
 *
 * Runs against a FAKE Trino pool (no cluster): pins that the job executes EXACTLY the compiler's
 * atomic Trino CTAS for EVERY compiled pre-agg (interactive metric × grain — the D2.snapshot-pinned
 * set), and that one table failing never starves the rest (per-table error collection → errors
 * count drives the non-zero exit at the entrypoint). The CTAS statement CONTENT (atomicity,
 * partitioning, no brand predicate) is pinned in @brain/semantic-metrics' compiler.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { SilverPool } from '@brain/metric-engine';
import { collectPreaggs, runSemanticPreaggRefresh } from './semantic-preagg-refresh.js';

function fakePool(failTables: ReadonlySet<string> = new Set()): { pool: SilverPool; executed: string[] } {
  const executed: string[] = [];
  const pool = {
    query: async (sql: string) => {
      executed.push(sql);
      for (const t of failTables) {
        if (sql.includes(t)) throw new Error(`simulated Trino failure for ${t}`);
      }
      return [];
    },
  } as unknown as SilverPool;
  return { pool, executed };
}

describe('collectPreaggs', () => {
  it('yields every interactive metric × grain pre-agg from the packaged registry (non-empty)', async () => {
    const preaggs = await collectPreaggs();
    expect(preaggs.length).toBeGreaterThan(0);
    for (const p of preaggs) {
      expect(p.tableName).toMatch(/^iceberg\.brain_serving\.preagg_/);
      expect(p.trinoCtasSql).toContain(`CREATE OR REPLACE TABLE ${p.tableName}`);
    }
    // Unique targets — two grains must never fight over one table.
    expect(new Set(preaggs.map((p) => p.tableName)).size).toBe(preaggs.length);
  });
});

describe('runSemanticPreaggRefresh', () => {
  it('executes exactly the compiled atomic CTAS for every pre-agg, in registry order', async () => {
    const { pool, executed } = fakePool();
    const preaggs = await collectPreaggs();

    const result = await runSemanticPreaggRefresh({ srPool: pool });

    expect(result).toEqual({ tables: preaggs.length, refreshed: preaggs.length, errors: 0 });
    expect(executed).toEqual(preaggs.map((p) => p.trinoCtasSql));
  });

  it('one table failing does not starve the rest — per-table errors are counted, not thrown', async () => {
    const preaggs = await collectPreaggs();
    const victim = preaggs[0]!.tableName;
    const { pool, executed } = fakePool(new Set([victim]));

    const result = await runSemanticPreaggRefresh({ srPool: pool });

    // Every table was still attempted; only the victim counts as an error (→ non-zero exit upstream).
    expect(executed.length).toBe(preaggs.length);
    expect(result.tables).toBe(preaggs.length);
    expect(result.errors).toBe(1);
    expect(result.refreshed).toBe(preaggs.length - 1);
  });
});
