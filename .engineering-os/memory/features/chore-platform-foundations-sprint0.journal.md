# Feature Journal — chore-platform-foundations-sprint0

> Brain Platform Foundations (Sprint 0). Append-only cross-stage journal.

## 2026-06-15 — Stage 2 (Architect) — binding plan authored

**Artifact:** `runs/2026-06-15T11-06-27Z__09ba6e__chore-platform-foundations-sprint0__rishabhporwal/03-architecture-plan.md`
**Decision:** ADVANCE → Stage 3 (parallel build fan-out).
**Lane:** high_stakes (6 trigger surfaces: multi_tenancy, schema_changes, system_of_record_audit, secrets_auth_iam, iac, shared_contract_parity).
**Cost paradigm:** deterministic/infrastructure — zero model calls (LiteLLM/AI path deferred).

**Decomposition (5 tracks, against the already-sealed repo scaffold — extend stubs, never re-scaffold):**
- A — Monorepo dev-standards + contracts (`backend-developer`): EC1, EC4. eslint boundary/money(I-S07)/redis-key(NN-7) lints; Zod→types/OpenAPI/Avro/MCP codegen + buf-breaking gate.
- B — CI/CD GitHub Actions (`platform-devops`): EC1, EC4, EC6, EC8. affected-only matrix; gitleaks/trivy/osv; Terraform IaC gate w/ Checkov+OPA for NN-3/4/5; ArgoCD staging-auto/prod-promote+rollback.
- C — AWS Terraform foundation (`platform-devops`): EC6, EC10. **CRITICAL PATH.** account-per-env; state/VPC/EKS/RDS/S3+Glue/KMS/Secrets; IRSA StringEquals (NN-3); S3 Object-Lock COMPLIANCE/7yr (NN-4); prefix-IAM (NN-5). EC10 = dev full-apply / staging scaffold compute-0 / prod bootstrap plan-only.
- D — Data spine (`data-engineer`): EC2, EC3, EC9. Redpanda topics; Iceberg Bronze `bucket(brand_id)+days(event_time)` + FULL_TRANSITIVE; StarRocks external catalog + row-policy template (NN-2); dbt init+compile stub; pixel-fixture→Bronze; parity-oracle scaffold.
- E — Isolation+observability (`data-engineer`+`backend-developer`): EC5, EC6, EC7. migration#1 two-arg RLS (NN-1)+audit_log (I-S06)+brand_keyring; packages/db GUC middleware; brandKey(); OTel SDK+PII redaction (NN-6); 4-layer isolation-fuzz (NN-2); Grafana SLO alert.

**Encoded non-negotiables:** NN-1..NN-7 all folded into pass-1 acceptance contracts.
**Encoded scope rulings (do not re-expand):** Authentik (declare-not-apply), LiteLLM (omit infra), Playwright (defer), Husky/Commitlint (defer; gitleaks stays), dbt (init+compile stub), DQ (stubs), pixel (fixture), CloudWatch (log groups + 1 alarm), EC10 ruling.

**Sequencing:** Group 1 (day 1, zero-AWS, all 5 parallel) → Group 2 (D/E live legs + B IaC gate after C lands state+VPC+EKS+S3/Glue+RDS, ≈ day 4). A→D hard handoff: contracts skeleton + 1 sample event by EOD day 1. Shared-file sole-writers fixed (turbo/tsconfig/eslint=A; docker-compose=D; .github/workflows=B; infra/terraform=C; db/migrations/0001=E; tools/isolation-fuzz=E).

**Next:** Stage 3 builders (backend-developer, platform-devops, data-engineer).
