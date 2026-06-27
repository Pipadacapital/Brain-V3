# v3 Identity Resolution & Customer Intelligence Platforms — build log

Single-run build per the v3 master prompt, executed against the merged **Brain V4** repo.

## Decisions (locked at start, repo-grounded)
- **Query engine: ADD Trino** over Iceberg for ad-hoc / AI / cache-miss reads (the prompt's locked stack),
  ADDITIVELY alongside the existing StarRocks `mv_*` serving (which keeps powering current dashboards).
  Rationale: user chose "introduce Trino"; done additively so no existing serving is ripped out.
- **Gap-extend, do NOT rebuild.** Both platforms already exist in V4 (identity: Neo4j SoR/ADR-0004,
  `apps/core/src/modules/identity`, `identity-core`, journey-stitch, `silver_identity_link`; intelligence:
  `db/iceberg/spark/gold/gold_customer_360|attribution_*|cohorts|customer_scores|customer_segments|executive_metrics`).
  Build ONLY the genuine missing spec pieces; conform to existing conventions (PRIME DIRECTIVE = no rework).
- **Crypto-shred: extend the existing** KMS PII-vault + per-brand salt + `erase_contact_pii_for_customer`
  to the layers that lack it (Neo4j props, Gold, Redis) — incremental, not a parallel new system.
- **Full build attempted in one run**, with every unit flagged VERIFIED vs SCAFFOLDED. Deferred strategies
  are registered-and-disabled with explicit NotImplementedYet — never silently faked.

## Conflicts found vs the prompt (repo wins, recorded per PRIME DIRECTIVE)
- Prompt says Trino is THE query engine; repo uses StarRocks → resolved: Trino added additively (user choice).
- Prompt says the two platforms "do not yet exist in full form"; repo (V4) has both substantially → resolved:
  gap-extend (user choice).
- Prompt calls the architecture "v3"; repo is "Brain V4" (dbt removed, Spark sole compute, StarRocks serving) →
  conform to V4 conventions.

(Discovery + gap analysis appended below as the workflow completes.)
