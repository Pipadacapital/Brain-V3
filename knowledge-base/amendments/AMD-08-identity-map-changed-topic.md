<!-- SPEC: 0.4 -->
# AMD-08 — identity.map.changed.v1 topic (A.2.3(5) / B.2)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-15 (map-mutation lane), WA-18 (re-stitch consumer), WA-19, B.2 event trigger

## Conflicting spec text
> §A.2.3(5) "Re-stitch on identity change: Kafka `identity.map.changed.v1` (keyed brand_id+identifier_hash, emitted on every map mutation); stitch job consumes it […]"
> §B.2 "re-version consumer on `identity.map.changed.v1` → mark dirty brain_ids […]"

## Ground truth (delta-plan evidence)
`identity.map.changed` = 0 hits repo-wide. The LIVE lane is the 5-topic set `{env}.identity.{minted,linked,merged,suppressed,review_queued}.v1`, with `IdentityChangeRecomputeConsumer` already consuming it for mart-scoped recompute. Adding a verbatim 6th topic would overlap the existing lane's semantics and split consumers.

## Candidate resolutions
### R1 — EXTEND the live `{env}.identity.*.v1` lane + existing recompute consumer (adopted)
- Every map mutation emits on the **existing topics** (minted/linked/merged/suppressed) — or, where no existing topic fits a mutation class, ONE new sibling following the discovered `{env}.identity.<name>.v1` convention — **keyed `brand_id+identifier_hash`**, schema-registered per AMD-03.
- Consumers unified: the stitch re-run (WA-18) and journey re-version (B.2) consume this lane; `IdentityChangeRecomputeConsumer` is the wiring template.
- **Mapping (spec → live):** `identity.map.changed.v1` ≙ the union of `{env}.identity.{minted,linked,merged,suppressed}.v1`; "emitted on every map mutation" ≙ each mutation class emits its specific topic; the spec's key contract (brand_id+identifier_hash) is adopted verbatim on these topics.
- Trade-offs: consumers subscribe to N topics instead of 1 (kafkajs multi-topic subscribe is already the house pattern); mutation-class coverage must be audited (WA-15).

### R2 — Add the 6th overlapping topic verbatim
- Trade-offs: duplicate emission for every mutation (existing topic + new topic), two consumer paths to keep consistent, naming drift from the discovered convention.

## RECOMMENDED resolution (BINDING)
**R1.** Additive (new emissions on existing lane; at most one convention-following sibling), preserves the live consumer, and satisfies §1.7's "new topics follow the existing naming convention".
