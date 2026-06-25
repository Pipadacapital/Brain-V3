# Brain V4 — Architecture Migration Audit (Index)

Decision-grade deliverables for the Brain V4 architecture migration. The **OFFICIAL V4 architecture is the final source of truth**; where code, migrations, dbt, UI, or APIs disagree, **ARCHITECTURE WINS**. Every claim traces to the validated audit bundle (RECON-1 + 8 workstream audits).

⚠️ **HIGH-RISK** callouts throughout mark load-bearing changes (revenue, attribution, billing, identity, tenant isolation) that require stakeholder sign-off and a parity gate before execution.

## Reports

| # | File | What it covers |
|---|------|----------------|
| 00 | [00-INDEX.md](./00-INDEX.md) | This index — links to all V4 reports. |
| 01 | [01-architecture-impact-report.md](./01-architecture-impact-report.md) | Current vs. V4 target by layer, the named drift, the 12-principle conformance scorecard (4 conformant / 4 partial / 4 violated), and the sequenced migration program. |
| 02 | [02-repository-impact-report.md](./02-repository-impact-report.md) | Per app/package/module/infra disposition (KEEP/REFACTOR/DEPRECATE/REMOVE) plus the wrong-ownership matrix (who does whose job). |
| 03 | [03-documentation-impact-report.md](./03-documentation-impact-report.md) | For each canonical doc 01..12, the exact edits required to match V4 and the verified code reality. |

## One-line verdict

The V4 spine is half-built and conformant (Collector ingress, Spark Bronze hop, Neo4j identity, consumer-only UI), but the **compute and serving tiers are an inversion of V4**: Spark builds Bronze only, **dbt is the live Silver+Gold compute engine**, **Gold lives in StarRocks base tables (zero `mv_*`)**, and business truth is computed in TypeScript. The fix is a **Spark-first, parity-gated, store-then-cutover re-platform** of the transform + serving tiers — never a big-bang dbt deletion.
