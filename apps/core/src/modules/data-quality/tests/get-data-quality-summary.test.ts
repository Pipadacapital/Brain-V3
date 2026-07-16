/**
 * get-data-quality-summary.test.ts — pure derivation unit tests for the DQ summary read.
 *
 * Exercises the metric-engine-backed derivation (coverage, freshness-SLA worst-of, cost-floor
 * selection, effective = min(cost, attribution), gate decision) + the fail-closed paths,
 * using a fake pg.Pool that scripts the SQL responses. No live DB (the NON-INERT RLS isolation
 * assertion is Track A's dq-isolation.live.test.ts; here we prove the deterministic math).
 */

import { describe, it, expect } from 'vitest';
import type { EngineDeps, SilverPool } from '@brain/metric-engine';
import { getDataQualitySummary } from '../internal/application/queries/get-data-quality-summary.js';
import { getMetricTrust } from '../internal/application/queries/get-metric-trust.js';

interface ScriptedRow {
  category: string;
  target: string;
  grade: string;
  passing: boolean;
  observed: string;
  threshold: string;
  checked_at: Date;
}

/**
 * A fake pool that returns scripted dq_check_result rows (PG) + a fake Trino srPool that returns the
 * attribution confidence grades from brain_serving.mv_gold_attribution_credit (MEDALLION REALIGNMENT
 * Epic 2: the credit ledger moved to the lakehouse; fetchAttributionLetter reads it via withSilverBrand).
 *
 * BRAIN V4: StarRocks is REMOVED. The serving seam is now Trino — SilverPool aliases the Trino query
 * PORT, whose `query()` returns the ROW ARRAY directly (T[]), NOT the mysql2 `[rows, fields]` tuple.
 * The fake mirrors that contract (the prior mysql2-shape fake made fetchAttributionLetter read `.rows`
 * off the wrong index → 0 grades → fail-closed 'D', masking the real 'A'/'C' derivation).
 */
function fakePool(opts: {
  dqRows?: ScriptedRow[] | 'undefined_table';
  attributionGrades?: string[] | 'undefined_table';
}): EngineDeps & { srPool: SilverPool } {
  const query = async (text: string): Promise<{ rows: unknown[] }> => {
    if (text.includes('BEGIN') || text.includes('COMMIT') || text.includes('set_config')) {
      return { rows: [] };
    }
    if (text.includes('FROM dq_check_result')) {
      if (opts.dqRows === 'undefined_table') {
        const err = new Error('relation "dq_check_result" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      }
      return { rows: opts.dqRows ?? [] };
    }
    return { rows: [] };
  };
  const client = { query, release: () => undefined };
  const pool = { connect: async () => client } as unknown as EngineDeps['pool'];

  // Fake Trino srPool (ServingPool shape: query() returns the row array directly) serving the
  // mv_gold_attribution_credit confidence grades. runScoped injects `brand_id = ?` then calls query().
  const srPool = {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      const text = String(sql);
      if (text.includes('gold_attribution_credit')) {
        if (opts.attributionGrades === 'undefined_table') throw new Error('unknown table');
        return (opts.attributionGrades ?? []).map((g) => ({ confidence_grade: g })) as T[];
      }
      return [] as T[];
    },
  } as unknown as SilverPool;

  return { pool, srPool };
}

const ts = new Date('2026-06-18T12:00:00.000Z');

describe('getDataQualitySummary — honest no_data', () => {
  it('returns no_data when dq_check_result is not yet migrated (42P01)', async () => {
    const r = await getDataQualitySummary('brand-a', fakePool({ dqRows: 'undefined_table' }));
    expect(r.state).toBe('no_data');
  });

  it('returns no_data when the brand has zero graded rows', async () => {
    const r = await getDataQualitySummary('brand-a', fakePool({ dqRows: [] }));
    expect(r.state).toBe('no_data');
  });
});

describe('getDataQualitySummary — derivation (trusted)', () => {
  it('all A grades + strong attribution → trusted, cap applies, in MMM, no block', async () => {
    const rows: ScriptedRow[] = [
      { category: 'freshness', target: 'ad_spend_ledger', grade: 'A', passing: true, observed: '5', threshold: '60', checked_at: ts },
      { category: 'completeness', target: 'ad_spend_ledger', grade: 'A+', passing: true, observed: '0.0', threshold: '0.0', checked_at: ts },
      { category: 'reconciliation', target: 'bronze_vs_silver.order_state', grade: 'A', passing: true, observed: '0', threshold: '10', checked_at: ts },
    ];
    const r = await getDataQualitySummary('brand-a', fakePool({ dqRows: rows, attributionGrades: ['strong'] }));
    expect(r.state).toBe('has_data');
    if (r.state !== 'has_data') return;
    expect(r.costConfidence).toBe('A'); // floor of A, A+, A
    expect(r.attributionConfidence).toBe('A'); // strong → A
    expect(r.effectiveConfidence).toBe('A');
    expect(r.tier).toBe('trusted');
    expect(r.gate.billingCapApplies).toBe(true);
    expect(r.gate.includedInMmm).toBe(true);
    expect(r.gate.blocksHighRiskRecommendation).toBe(false);
    expect(r.freshnessSla).toBe('green');
  });
});

describe('getDataQualitySummary — derivation (estimated/untrusted gating)', () => {
  it('weak attribution floors effective → untrusted, BLOCKS high-risk, no cap, excluded MMM', async () => {
    const rows: ScriptedRow[] = [
      { category: 'freshness', target: 'ad_spend_ledger', grade: 'A', passing: true, observed: '5', threshold: '60', checked_at: ts },
      { category: 'completeness', target: 'ad_spend_ledger', grade: 'A', passing: true, observed: '0.0', threshold: '0.0', checked_at: ts },
    ];
    const r = await getDataQualitySummary('brand-a', fakePool({ dqRows: rows, attributionGrades: ['weak'] }));
    expect(r.state).toBe('has_data');
    if (r.state !== 'has_data') return;
    expect(r.attributionConfidence).toBe('D'); // weak → D
    expect(r.effectiveConfidence).toBe('D'); // min(A, D)
    expect(r.tier).toBe('untrusted');
    expect(r.gate.blocksHighRiskRecommendation).toBe(true);
    expect(r.gate.billingCapApplies).toBe(false);
    expect(r.gate.includedInMmm).toBe(false);
  });

  it('a breached freshness check → freshnessSla=breached + cost floors to C → estimated', async () => {
    const rows: ScriptedRow[] = [
      // silver.order_state freshness is BOTH a freshness signal AND cost-relevant.
      { category: 'freshness', target: 'silver.order_state', grade: 'C', passing: false, observed: '300', threshold: '120', checked_at: ts },
      { category: 'completeness', target: 'ad_spend_ledger', grade: 'A', passing: true, observed: '0.0', threshold: '0.0', checked_at: ts },
    ];
    const r = await getDataQualitySummary('brand-a', fakePool({ dqRows: rows, attributionGrades: ['strong'] }));
    expect(r.state).toBe('has_data');
    if (r.state !== 'has_data') return;
    expect(r.freshnessSla).toBe('breached');
    expect(r.costConfidence).toBe('C'); // floor of C, A
    expect(r.effectiveConfidence).toBe('C'); // min(C, A)
    expect(r.tier).toBe('estimated');
    expect(r.gate.blocksHighRiskRecommendation).toBe(true);
  });
});

describe('getDataQualitySummary — coverage success metric', () => {
  it('counts distinct (category,target) graded over the expected set', async () => {
    const rows: ScriptedRow[] = [
      { category: 'freshness', target: 'bronze_events', grade: 'A', passing: true, observed: '5', threshold: '60', checked_at: ts },
      { category: 'completeness', target: 'bronze_events', grade: 'A', passing: true, observed: '0.0', threshold: '0.0', checked_at: ts },
    ];
    const r = await getDataQualitySummary('brand-a', fakePool({ dqRows: rows, attributionGrades: ['strong'] }));
    expect(r.state).toBe('has_data');
    if (r.state !== 'has_data') return;
    expect(r.coverage.graded).toBe(2);
    expect(r.coverage.expected).toBeGreaterThanOrEqual(2);
  });
});

describe('getMetricTrust — fail-closed', () => {
  it('no DQ data → effective_confidence=D, untrusted, BLOCKS high-risk', async () => {
    const t = await getMetricTrust('brand-a', fakePool({ dqRows: 'undefined_table' }));
    expect(t.effectiveConfidence).toBe('D');
    expect(t.tier).toBe('untrusted');
    expect(t.gate.blocksHighRiskRecommendation).toBe(true);
  });

  it('attribution ledger not migrated → attribution floors to D (fail-closed)', async () => {
    const rows: ScriptedRow[] = [
      { category: 'freshness', target: 'ad_spend_ledger', grade: 'A', passing: true, observed: '5', threshold: '60', checked_at: ts },
    ];
    const r = await getDataQualitySummary('brand-a', fakePool({ dqRows: rows, attributionGrades: 'undefined_table' }));
    expect(r.state).toBe('has_data');
    if (r.state !== 'has_data') return;
    expect(r.attributionConfidence).toBe('D');
    expect(r.effectiveConfidence).toBe('D');
  });
});
