<!-- SPEC: 0.4 -->
# AMD-21 — Wave G 501 stub vs shipped recommendations surface (§G)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** CONTRACT-G, G scaffold

## Conflicting spec text
> §G "Schema only: `gold_recommendations {…}` — explainability schema-enforced. `GET /v1/recommendations` → **501 behind flag**. Deferred: all models/scoring."

## Ground truth (delta-plan evidence)
A **working rule-based recommend-only surface already ships**: decisions.routes.ts + detectors + confidence-gate + recommendation_action ledger (migration 0082) + UI. `gold_recommendations` = 0 hits. Applying the spec verbatim (501 everything) would regress a live feature.

## Candidate resolutions
### R1 — Grandfather the shipped surface; scope the 501 stub to the NEW endpoint (adopted)
- The existing decisions/recommendations surface continues untouched.
- The 501-behind-flag stub applies ONLY to the NEW `gold_recommendations`-schema-backed endpoint (`GET /v1/recommendations`), which is net-new scaffold.
- `gold_recommendations` DDL ships with explainability (evidence/model_version/business_rules_applied) schema-enforced, flags OFF.
- Trade-offs: two recommendation surfaces exist until Wave G proper unifies them; mapped in CONTRACT-G.

### R2 — Verbatim spec: 501 the recommendations capability
- Trade-offs: regresses a shipped, ledgered product feature — prohibited by §0.5 (non-breaking).

## RECOMMENDED resolution (BINDING)
**R1.** Additive scaffold beside a grandfathered live surface; no shipped behavior changes.
