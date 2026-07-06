<!-- SPEC: 0.4 -->
# AMD-12 — Splink vs the live rule-based matcher (A.3)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-20 (Splink quarantined layer)

## Conflicting spec text
> §A.3 "Splink Spark (Python) over unstitched sessions […] Output ≥ 0.95 only → `silver_probabilistic_stitch` […] Versioned; train on deterministic labels."

The spec presumes Splink is THE probabilistic layer, with no accounting for an incumbent.

## Ground truth (delta-plan evidence)
A **rule-based, review-gated** Fellegi–Sunter-style matcher is live (`ProbabilisticMatcher.ts`, matcher_id `'probabilistic-fellegi-sunter'`): weak signals only, score capped ≤ 95 sub-exact, **never auto-merges** — routes to MergeReview (20 nodes live). The matcher-registry architecture supports multiple matcher_ids by design.

## Candidate resolutions
### R1 — Splink sits BESIDE the rule-based matcher (adopted)
- Splink is a new matcher_id in the registry; it exclusively owns `silver_probabilistic_stitch` (≥ 0.95, quarantined per §1.4).
- The rule-based matcher keeps feeding MergeReview unchanged.
- Segregation invariants apply to both: neither path can reach attribution/revenue; `customer_sessions_extended_v` unions with `identity_basis`.
- Trade-offs: two probabilistic components to document; their scopes are disjoint (session-stitch scoring vs merge-review candidates), so no double-counting.

### R2 — Replace the rule-based matcher with Splink
- Trade-offs: loses a working, review-gated pipeline with live MergeReview state; regresses shipped behavior — non-additive.

## RECOMMENDED resolution (BINDING)
**R1.** Additive (new matcher registered alongside), preserves the shipped review pipeline, and keeps §1.4's quarantine enforceable per component.
