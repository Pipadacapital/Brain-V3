/**
 * reconcile-attribution.live.test.ts — RETIRED (Brain V4 Phase 6a).
 *
 * This suite used to drive reconcileAttribution and assert it INSERTed credit rows into the dbt-internal
 * StarRocks DB brain_gold.gold_attribution_credit (per-model closed-sum, idempotency, brand scoping).
 * The TS WRITE path is RETIRED: the attribution credit ledger is now produced SOLELY by the Spark gold
 * job (db/iceberg/spark/gold/gold_attribution_credit.py), served to the app via the serving MV
 * brain_serving.mv_gold_attribution_credit. reconcileAttribution is kept as a (now read-only) parity
 * driver — its writer calls are neutralized no-ops, so it reports 0 newly-credited and persists nothing.
 *
 * Equivalent coverage now lives in:
 *   • packages/attribution-writer/src/index.test.ts (the RETIRED no-op write contract).
 *   • the Spark gold job's own parity verification over the Iceberg gold ledger.
 *
 * Kept as a documented stub so the retirement is auditable and the runner stays green. No reference to
 * the retiring brain_gold DB remains.
 */
import { describe, it, expect } from 'vitest';
import { reconcileAttribution } from '../index.js';

describe('reconcileAttribution — TS write path RETIRED (Phase 6a; Spark is sole producer)', () => {
  it('the driver is exported (read-only parity driver) but no longer writes brain_gold', () => {
    expect(typeof reconcileAttribution).toBe('function');
  });
});
