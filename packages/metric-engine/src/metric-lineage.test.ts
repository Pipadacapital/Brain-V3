// SPEC:C.5.1
/**
 * C.5.1 — measurement lineage: every executive metric traces to Measurement facts.
 *
 * Unit-level proof over a fake TrinoPool (no live stack): asserts the descriptor invariants and the
 * brand-scoped query shape (every count/version SQL carries the ${BRAND_PREDICATE} sentinel → the
 * withSilverBrand seam injects `brand_id = ?`). The live golden numbers are recorded in GATE-C.md.
 */
import { describe, it, expect } from 'vitest';
import {
  computeMetricLineage,
  MEASUREMENT_LINEAGE,
  isLineageMetric,
  listLineageMetrics,
  type LineageMetricId,
} from './metric-lineage.js';
import type { SilverPool } from './silver-deps.js';

/** A fake Trino pool recording every SQL it sees and returning deterministic counts/versions. */
function fakePool(): { pool: SilverPool; seen: string[] } {
  const seen: string[] = [];
  const pool: SilverPool = {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      seen.push(sql);
      // withSilverBrand → withTrinoBrand replaces the sentinel with `brand_id = ?` before calling query.
      if (/count\(\*\)/i.test(sql)) return [{ c: 7 }] as unknown as T[];
      if (/DISTINCT/i.test(sql)) return [{ v: 'c3.economics.v1' }] as unknown as T[];
      return [] as T[];
    },
  };
  return { pool, seen };
}

describe('C.5.1 measurement lineage descriptors', () => {
  it('every supported metric maps to ≥1 measurement fact (traces to Measurement facts)', () => {
    const metrics = listLineageMetrics();
    expect(metrics.length).toBeGreaterThan(0);
    for (const m of metrics) {
      expect(MEASUREMENT_LINEAGE[m].facts.length).toBeGreaterThan(0);
    }
  });

  it('isLineageMetric gates the catalog surface', () => {
    expect(isLineageMetric('cm3')).toBe(true);
    expect(isLineageMetric('not_a_metric')).toBe(false);
  });
});

describe('C.5.1 computeMetricLineage', () => {
  it('rejects a malformed as-of date', async () => {
    const { pool } = fakePool();
    await expect(computeMetricLineage('brand-a', 'cm3', '22-03-2026', { srPool: pool })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('every count/version query is brand-scoped (brand_id = ? injected by the seam)', async () => {
    const { pool, seen } = fakePool();
    await computeMetricLineage('brand-a', 'cm3', '2026-03-22', { srPool: pool });
    expect(seen.length).toBeGreaterThan(0);
    for (const sql of seen) {
      // The seam has already substituted ${BRAND_PREDICATE} → `brand_id = ?` by query() time.
      expect(sql).toMatch(/brand_id = \?/);
    }
  });

  it('returns machine-readable facts with row counts + job versions', async () => {
    const { pool } = fakePool();
    const lineage = await computeMetricLineage('brand-a', 'cm3', '2026-03-22', { srPool: pool });
    expect(lineage.metric).toBe('cm3');
    expect(lineage.date).toBe('2026-03-22');
    expect(lineage.traces_to_measurement).toBe(true);
    expect(lineage.facts.length).toBe(MEASUREMENT_LINEAGE.cm3.facts.length);
    for (const f of lineage.facts) {
      expect(f.catalog).toBe('iceberg');
      expect(f.fqtn).toBe(`iceberg.${f.schema}.${f.table}`);
      expect(typeof f.row_count).toBe('number');
      expect(f.job_versions.length).toBeGreaterThan(0);
      expect(['column', 'producer']).toContain(f.job_version_source);
    }
    // gold_order_economics carries a real per-row job_version column → 'column' source.
    const oe = lineage.facts.find((f) => f.table === 'gold_order_economics');
    expect(oe?.job_version_source).toBe('column');
    expect(oe?.job_versions).toContain('c3.economics.v1');
  });

  it('all-time (no date) omits the date filter', async () => {
    const { pool, seen } = fakePool();
    await computeMetricLineage('brand-a', 'realized_revenue', null, { srPool: pool });
    for (const sql of seen) expect(sql).not.toMatch(/CAST\(.* AS date\) <=/);
  });

  it('covers the full metric catalog without throwing', async () => {
    const { pool } = fakePool();
    for (const m of listLineageMetrics() as LineageMetricId[]) {
      const l = await computeMetricLineage('brand-a', m, null, { srPool: pool });
      expect(l.traces_to_measurement).toBe(true);
    }
  });
});
