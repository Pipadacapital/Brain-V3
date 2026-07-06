<!-- SPEC: 0.4 -->
# AMD-15 — Revenue recognition language (C.1)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** Wave C (C.1 ledger verification test, C.3 economics_state mapping)

## Conflicting spec text
> §C.1 "confirm recognition rules (**prepaid at capture**; COD at delivery confirmation; reversals on RTO/refund)"

## Ground truth (delta-plan evidence)
The live ledger is **two-stage**: `provisional_recognition` at booking → `finalization` for prepaid after a horizon; plus `cod_delivery_confirmed`, `cod_rto_clawback`, `cancellation`, `refund` (gold_revenue_ledger.py:284–315; deterministic ledger_event_id; idempotent MERGE). Verified exact 3-way reconcile ₹1,746,754,034. There is no "capture" trigger in the recognition model.

## Candidate resolutions
### R1 — Adopt provisional/finalized language (adopted)
Spec's "prepaid at capture" is amended to the live two-stage model: **provisional recognition at booking → finalized after the prepaid horizon**; COD at delivery confirmation and reversal events unchanged. Wave C's `economics_state: provisional|settled|reversed` maps onto these recognition states.
- Trade-offs: none material — the live model is strictly more conservative (revenue is not "final" at capture).

### R2 — Add a capture-trigger recognition event
- Trade-offs: changes a live, reconciled, audited ledger's event grammar; recomputes history; violates §0.5 and C.4's "never revenue changes" parity rule.

## RECOMMENDED resolution (BINDING)
**R1.** Pure language ratification of the verified live behavior; zero code change to the ledger seam.
