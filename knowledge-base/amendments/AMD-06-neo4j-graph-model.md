<!-- SPEC: 0.4 -->
# AMD-06 — Neo4j identity graph model (A.1.5)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-11 (edge enrichment), WA-17 (90-day shared-device rule)

## Conflicting spec text
> §A.1.5 "upsert Neo4j near-real-time: `(:Identifier {type, value_hash, brand_id})`, `(:BrainId {brain_id, brand_id})`, `OBSERVED_WITH {first_seen, last_seen, source, count}`."

## Ground truth (delta-plan evidence)
Live model is `(:Identifier)-[:IDENTIFIES {tier, is_active, created_at}]->(:Customer)` — node label `Customer` (not `BrainId`), edge type `IDENTIFIES` (not `OBSERVED_WITH`), and the edge lacks `first_seen`/`last_seen`/`source`/`count`. Scale: 15,105 Identifier / 3,787 Customer nodes, 15,128 IDENTIFIES edges live (Neo4jIdentityRepository.writeOutcome :291–380; IdentityBridgeConsumer :53).

## Candidate resolutions
### R1 — Ratify the existing model; enrich the IDENTIFIES edge (adopted)
`Identifier→IDENTIFIES→Customer` IS the spec model; add `first_seen`, `last_seen`, `source`, `count` properties additively (`ON CREATE SET first_seen…`, `ON MATCH SET last_seen, count += 1`). This is the prerequisite for the 90-day shared-device rule (A.2.3(4)).
- Trade-offs: spec vocabulary (`BrainId`/`OBSERVED_WITH`) becomes documentation-only aliases; naming mapping recorded here.

### R2 — Introduce the spec's parallel node/edge types
- Trade-offs: duplicates a 15k-edge live graph, two sources of truth for the same relationship, every reader must union both — non-additive risk with zero information gain.

## RECOMMENDED resolution (BINDING)
**R1.** Additive property enrichment on live edges; no existing node/edge is renamed or duplicated.
