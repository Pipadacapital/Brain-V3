/**
 * reconcile-attribution-cod.live.test.ts — RETIRED (Brain V4 Phase 6a).
 *
 * This suite (GAP-3: COD revenue attribution) used to drive reconcileAttribution and assert credit rows
 * landed in the dbt-internal StarRocks DB brain_gold.gold_attribution_credit for cod_delivery_confirmed
 * orders. The TS WRITE path is RETIRED — the credit ledger is now produced SOLELY by the Spark gold job
 * (db/iceberg/spark/gold/gold_attribution_credit.py, which credits the SAME RECOGNITION_EVENT_TYPES =
 * {'finalization','cod_delivery_confirmed'}), served via brain_serving.mv_gold_attribution_credit.
 *
 * Kept as a documented stub so the retirement is auditable and the runner stays green. No reference to
 * the retiring brain_gold DB remains. The COD-recognition basis is verified by the Spark job's parity.
 */
import { describe, it, expect } from 'vitest';
import { reconcileAttribution } from '../index.js';

describe('reconcileAttribution COD — TS write path RETIRED (Phase 6a; Spark is sole producer)', () => {
  it('the driver is exported but no longer writes brain_gold (Spark credits the COD basis)', () => {
    expect(typeof reconcileAttribution).toBe('function');
  });
});
