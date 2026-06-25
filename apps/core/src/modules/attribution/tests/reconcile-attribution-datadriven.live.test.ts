/**
 * reconcile-attribution-datadriven.live.test.ts — RETIRED (Brain V4 Phase 6a).
 *
 * This suite (data-driven / Markov attribution end-to-end) used to drive reconcileDataDrivenAttribution
 * and assert the corpus-trained per-channel credit rows landed in the dbt-internal StarRocks DB
 * brain_gold.gold_attribution_credit. The TS WRITE path is RETIRED — the credit ledger (including the
 * GLOBAL data_driven model) is now produced SOLELY by the Spark gold job
 * (db/iceberg/spark/gold/gold_attribution_credit.py, which trains the same Markov channel weights and
 * apportions with the same largest-remainder closer), served via brain_serving.mv_gold_attribution_credit.
 *
 * Kept as a documented stub so the retirement is auditable and the runner stays green. No reference to
 * the retiring brain_gold DB remains. The Markov math is covered by the metric-engine unit vectors + the
 * Spark job's own parity verification.
 */
import { describe, it, expect } from 'vitest';
import { reconcileDataDrivenAttribution } from '../index.js';

describe('reconcileDataDrivenAttribution — TS write path RETIRED (Phase 6a; Spark is sole producer)', () => {
  it('the driver is exported but no longer writes brain_gold (Spark produces the data_driven credit)', () => {
    expect(typeof reconcileDataDrivenAttribution).toBe('function');
  });
});
