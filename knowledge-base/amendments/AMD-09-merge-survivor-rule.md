<!-- SPEC: 0.4 -->
# AMD-09 — Merge survivor rule (A.2.4)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-19 (merge/unmerge completion)

## Conflicting spec text
> §A.2.4 "Merge on deterministic evidence (shared email/phone hash): **survivor = older brain_id**; `identity_merge_log {…}`; emit `identity.map.changed.v1`; journey re-versioning consumes."

## Ground truth (delta-plan evidence)
The live survivor rule is **LOWEST-UUID canonical** (IdentityResolver.ts:286–288). Deterministic `merge_id` generation and replay idempotency **depend on this rule**; 3 MergeEvents + 11 ALIAS_OF intervals exist in the live graph under it. Changing survivorship would make historical merges non-replayable (same evidence would now pick a different survivor).

## Candidate resolutions
### R1 — Keep lowest-UUID; amend the spec (adopted)
The repo's existing survivor rule is ratified and documented here: **survivor = lowest brain_id by UUID byte order**, deterministic and replay-stable. `identity_merge_log` semantics (survivor/absorbed/evidence/merged_at/actor) apply unchanged on top of it.
- Trade-offs: "older id" intuition lost — survivor age is arbitrary; mitigated because brain_ids are internal (customer_ref BRN- is the public id) and merge audit records both parties.

### R2 — Switch to older-brain_id survivorship (spec verbatim)
- Trade-offs: invalidates replay determinism for existing MergeEvents, requires migrating live ALIAS_OF chains and every derived surface keyed on the current canonical ids — a breaking change to a live graph, prohibited by §0.5.

## RECOMMENDED resolution (BINDING)
**R1.** Changing survivorship of a live graph is not additive; keeping the existing rule preserves the tested replay-idempotency invariant (§1.6).
