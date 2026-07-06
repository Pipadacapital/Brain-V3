<!-- SPEC: 0.4 -->
# AMD-19 — Wave E feature store vs "features are RUNTIME" invariant (E)

**Status:** FILED · DEFERRED — decision at E-scaffold time (contracts written store-agnostic)
**Date:** 2026-07-06
**Blocks:** CONTRACT-E DDL choice only (contracts themselves proceed)

## Conflicting spec text
> §E "Point-in-time correctness load-bearing: `gold_ai_features {brand_id, entity_type, entity_id, feature_name, feature_value, event_timestamp, created_timestamp, feature_version}`. Training reads = as-of joins on event_timestamp, NEVER 'latest'."

## Ground truth (delta-plan evidence)
The repo has a **CI-enforced invariant against feature precompute**: `tools/lint/v4-naming-guard.sh` forbids it (blocking gate in pr.yml); CLAUDE.md states "Features are RUNTIME — there is NO permanent feature-precompute table"; `RETIRED_feature_customer_daily.md` documents the deliberate teardown. Meanwhile a `gold_ai_features.py` + mv SQL + read seam exist in CODE but are absent live and not in the refresh loop, and are WIDE current-state (not the spec's EAV PIT shape).

## Candidate resolutions
### R1 — Sanctioned, named exception for the E offline store
PIT EAV `gold_ai_features` allowed via an explicit allowlist entry in v4-naming-guard (the invariant's intent — no silent "latest-value" precompute feeding serving — is preserved because the table is event-timestamped PIT, training-only, flag-OFF).
- Trade-offs: weakens a bright-line CI rule to a judged exception; guard change must be deliberate and reviewed.

### R2 — No table: training reads = as-of joins over Silver/Gold at read time
- Trade-offs: keeps the invariant absolute; training-time compute cost and reproducibility burden shift to every consumer; PIT discipline enforced by convention not schema.

## RECOMMENDED resolution (BINDING)
**DEFER the R1-vs-R2 choice to E-scaffold time** (per the delta plan's own analysis — Wave E is scaffold-only and CONTRACT-E can be written either way: the feature CONTRACT specifies entity/name/dtype/PIT semantics, not the physical store). Until then the CI guard and CLAUDE.md invariant stand untouched; no feature table ships in Waves A–D.
