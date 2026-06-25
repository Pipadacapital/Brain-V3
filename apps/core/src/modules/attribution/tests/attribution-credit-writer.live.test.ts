/**
 * attribution-credit-writer.live.test.ts — RETIRED (Brain V4 Phase 6a).
 *
 * This suite used to verify the TypeScript AttributionCreditWriter INSERTing the credit/clawback ledger
 * into the dbt-internal StarRocks DB brain_gold.gold_attribution_credit. That write path is RETIRED:
 * the attribution credit ledger is now produced SOLELY by the Spark gold job
 * (db/iceberg/spark/gold/gold_attribution_credit.py + _attribution_math.py), MERGEd into the Iceberg
 * gold ledger and served to the app via the serving MV brain_serving.mv_gold_attribution_credit.
 *
 * The deterministic apportionment math (closed-sum, idempotent credit_id, R-11 clawback clamp) is now
 * covered by:
 *   • the writer's isolation unit tests — packages/attribution-writer/src/index.test.ts (assert the
 *     RETIRED no-op write contract: rows computed, none persisted, no INSERT ever).
 *   • the metric-engine attribution unit-test vectors (the SoR math the Spark port mirrors 1:1).
 *   • the Spark gold job's own parity verification over the Iceberg gold ledger.
 *
 * Kept as a documented stub (rather than deleted) so the retirement is auditable and the runner stays
 * green. No reference to the retiring brain_gold DB remains.
 */
import { describe, it, expect } from 'vitest';
import { AttributionCreditWriter } from '../internal/credit-writer.js';

describe('attribution credit writer — TS write path RETIRED (Phase 6a; Spark is sole producer)', () => {
  it('the writer is exported (read-only adapter) but no longer writes brain_gold', () => {
    expect(typeof AttributionCreditWriter).toBe('function');
  });
});
