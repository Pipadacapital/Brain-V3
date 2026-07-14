/**
 * eval-gate.unit.test.ts — unit tests for the promote-model eval gate (no DB required).
 *
 * Proves:
 *   1. runEvalGate blocks promotion when AUC is below the default baseline (0.6).
 *   2. runEvalGate blocks promotion when AUC is exactly at the historic bug value (0.01).
 *   3. runEvalGate blocks promotion when metrics are missing entirely.
 *   4. runEvalGate passes when all metrics meet or exceed the baseline.
 *   5. runEvalGate EXEMPTS deterministic-framework models (no learned metrics).
 *   6. EVAL_GATE_METRIC_FLOORS.auc = 0.5 (no config can allow a random-classifier to ship).
 *   7. Per-name baseline override via EVAL_GATE_BASELINES_JSON env var.
 *   8. The floor is always enforced even when the override is set below the floor.
 *   9. A model with SOME metrics meeting baseline but one failing → still blocks.
 *  10. EvalGateError exposes the failures array with the actual + baseline values.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetAllConfigCaches } from '@brain/config';
import {
  runEvalGate,
  EvalGateError,
  DEFAULT_EVAL_BASELINES,
  EVAL_GATE_METRIC_FLOORS,
} from '../internal/application/promote-model.js';

// Hermetic unit tier (AUD-IMPL-007/-016): runEvalGate reads loadCoreConfig(), whose schema
// requires DATABASE_URL (the ONLY required var). The gate itself never touches the DB — provide
// a dummy URL so this suite runs without a provisioned env instead of failing on config parse.
process.env['DATABASE_URL'] ??= 'postgres://unit:unit@localhost:5432/unit_test_never_connected';

const MODEL_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const MODEL_NAME = 'customer_churn_rfm';

/** Good metrics that pass all default baselines. */
const GOOD_METRICS = {
  auc: 0.82,
  precision: 0.75,
  recall: 0.68,
  f1: 0.71,
  accuracy: 0.80,
};

/**
 * runEvalGate reads its per-name overrides from loadCoreConfig().EVAL_GATE_BASELINES_JSON,
 * which memoizes+freezes on first call. Reset the cache before each case so the env var
 * a case sets below is actually re-parsed (not read from an earlier test's frozen snapshot).
 */
beforeEach(() => {
  resetAllConfigCaches();
});

/** Wipe the env var after each test that sets it. */
afterEach(() => {
  delete process.env['EVAL_GATE_BASELINES_JSON'];
});

describe('eval gate — runEvalGate unit', () => {
  it('1. blocks promotion when AUC is below the default baseline (0.6)', () => {
    const metrics = { ...GOOD_METRICS, auc: 0.55 };
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', metrics)).toThrow(EvalGateError);

    const err = (() => {
      try { runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', metrics); }
      catch (e) { return e; }
    })() as EvalGateError;
    expect(err.failures.some((f) => f.metric === 'auc')).toBe(true);
    const aucFail = err.failures.find((f) => f.metric === 'auc')!;
    expect(aucFail.actual).toBe(0.55);
    expect(aucFail.baseline).toBe(DEFAULT_EVAL_BASELINES['auc']);
  });

  it('2. blocks promotion at the historical bug value auc=0.01 (the gap this gate closes)', () => {
    const metrics = { ...GOOD_METRICS, auc: 0.01 };
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', metrics)).toThrow(EvalGateError);
  });

  it('3. blocks promotion when metrics object is empty (no eval evidence)', () => {
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', {})).toThrow(EvalGateError);
  });

  it('4. blocks promotion when metrics is null', () => {
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', null)).toThrow(EvalGateError);
  });

  it('5. passes when all default metrics meet or exceed the baseline', () => {
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', GOOD_METRICS)).not.toThrow();
  });

  it('6. passes when metrics exactly equal the baselines (boundary)', () => {
    const boundary = {
      auc: DEFAULT_EVAL_BASELINES['auc']!,
      precision: DEFAULT_EVAL_BASELINES['precision']!,
      recall: DEFAULT_EVAL_BASELINES['recall']!,
      f1: DEFAULT_EVAL_BASELINES['f1']!,
      accuracy: DEFAULT_EVAL_BASELINES['accuracy']!,
    };
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', boundary)).not.toThrow();
  });

  it('7. EXEMPTS deterministic-framework models (no learned metrics — ships by design)', () => {
    // Deterministic model with no metrics → should NOT throw (deterministic models bypass the gate).
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'deterministic', {})).not.toThrow();
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'deterministic', null)).not.toThrow();
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'deterministic', { auc: 0.01 })).not.toThrow();
  });

  it('8. EVAL_GATE_METRIC_FLOORS.auc = 0.5 (random classifier cannot ship)', () => {
    expect(EVAL_GATE_METRIC_FLOORS['auc']).toBe(0.5);
  });

  it('9. DEFAULT_EVAL_BASELINES.auc = 0.6 (above the floor)', () => {
    expect(DEFAULT_EVAL_BASELINES['auc']).toBeGreaterThan(EVAL_GATE_METRIC_FLOORS['auc']!);
  });

  it('10. per-name baseline override via EVAL_GATE_BASELINES_JSON', () => {
    // Override: require auc >= 0.75 for customer_churn_rfm.
    process.env['EVAL_GATE_BASELINES_JSON'] = JSON.stringify({
      [MODEL_NAME]: { auc: 0.75 },
    });

    // auc=0.70 passes the default baseline (0.6) but NOT the override (0.75).
    const metrics = { ...GOOD_METRICS, auc: 0.70 };
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', metrics)).toThrow(EvalGateError);

    // auc=0.80 passes the override (0.75).
    const goodMetrics = { ...GOOD_METRICS, auc: 0.80 };
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', goodMetrics)).not.toThrow();
  });

  it('11. floor is enforced even when override is set below the floor', () => {
    // Try to configure auc baseline below the floor (0.5) — should use the floor.
    process.env['EVAL_GATE_BASELINES_JSON'] = JSON.stringify({
      [MODEL_NAME]: { auc: 0.1 },  // below floor of 0.5
    });

    // auc=0.4 is above the configured 0.1 but below the floor 0.5 → should fail.
    const metrics = { ...GOOD_METRICS, auc: 0.4 };
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', metrics)).toThrow(EvalGateError);

    const err = (() => {
      try { runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', metrics); }
      catch (e) { return e; }
    })() as EvalGateError;
    const aucFail = err.failures.find((f) => f.metric === 'auc')!;
    // Effective baseline = max(floor=0.5, configured=0.1) = 0.5.
    expect(aucFail.baseline).toBe(0.5);
  });

  it('12. blocks when one metric fails even if all others pass', () => {
    // Only f1 is below the baseline; everything else is above.
    const metrics = { ...GOOD_METRICS, f1: 0.2 };
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', metrics)).toThrow(EvalGateError);

    const err = (() => {
      try { runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', metrics); }
      catch (e) { return e; }
    })() as EvalGateError;
    // Only f1 should be in failures (auc/precision/recall/accuracy all pass).
    expect(err.failures.some((f) => f.metric === 'f1')).toBe(true);
    expect(err.failures.every((f) => f.metric === 'f1')).toBe(true);
  });

  it('13. EvalGateError.failures exposes actual + baseline values', () => {
    const metrics = { ...GOOD_METRICS, auc: 0.45, precision: 0.3 };
    const err = (() => {
      try { runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', metrics); }
      catch (e) { return e; }
    })() as EvalGateError;

    expect(err).toBeInstanceOf(EvalGateError);
    const aucFail = err.failures.find((f) => f.metric === 'auc');
    const prFail = err.failures.find((f) => f.metric === 'precision');
    expect(aucFail?.actual).toBe(0.45);
    expect(prFail?.actual).toBe(0.3);
    expect(aucFail?.baseline).toBeGreaterThanOrEqual(EVAL_GATE_METRIC_FLOORS['auc']!);
    expect(prFail?.baseline).toBeGreaterThanOrEqual(EVAL_GATE_METRIC_FLOORS['precision']!);
  });

  it('14. malformed EVAL_GATE_BASELINES_JSON falls back to defaults gracefully', () => {
    process.env['EVAL_GATE_BASELINES_JSON'] = 'not-valid-json{{{';
    // Should not throw a parse error — should fall back to defaults.
    expect(() => runEvalGate(MODEL_ID, MODEL_NAME, 'sklearn', GOOD_METRICS)).not.toThrow();
  });
});
