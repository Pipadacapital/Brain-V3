# Platform/SRE — Journal

> Append-only. See /Users/rishabhporwal/.claude/plugins/cache/engineering-os/engineering-os/2.3.1/docs/role-empowerment-model.md for entry shape.

## 2026-06-15T07:19:27Z — system — bootstrap
**Action:** Journal initialized by /eos-init on 2026-06-15T07:19:27Z.

## 2026-06-15T16:06:00Z — Platform/SRE — chore-platform-foundations-sprint0
**Stage:** 3 (Build) · **Affected:** collector, stream-worker, core, web · **Canary:** ArgoCD auto-sync staging / manual prod · **Monitor:** composite EKS-unhealthy alarm armed (CrashLoopBackOff OR node_not_ready)
**Staging smoke:** N/A (scaffolding stage — no live apply) · **Next:** orchestrator stages files; Track A/D engineers consume IRSA outputs and cross-track requests in 05-developer-report-platform.md

### Decisions
- EC10 implemented verbatim: dev=full-apply, staging=nodes@0+RDS/Redis create=false, prod=KMS+OIDC bootstrap only.
- NN-3 enforced in `modules/irsa/` via `StringEquals` on both `:sub` and `:aud`; OPA rule `irsa_no_wildcard.rego` + Checkov `CKV_BRAIN_1` gate every plan in CI.
- NN-4 enforced in `modules/s3-iceberg/` and `modules/s3-audit/`: `object_lock_enabled=true` at bucket creation, `mode="COMPLIANCE"`, `years=7`; OPA `s3_object_lock_compliance.rego` + Checkov `CKV_BRAIN_2` gate.
- NN-5 enforced: workload policies target `${arn}/bronze/brand_id=*/*`; explicit `Deny` on bucket-root ARN; OPA `s3_prefix_least_priv.rego` + Checkov `CKV_BRAIN_3` gate.
- Single NAT gateway dev+staging (cost control); 3-NAT prod (AZ-HA).
- ECR immutable tags; cosign keyless signing; affected-only build matrix.
- Authentik: Helm values declared, NOT applied (scope ruling from 02-cto-advisor-review).
- No CloudWatch dashboards; Grafana Cloud owns SLOs; single composite EKS alarm per cluster.

### Validation
- `terraform fmt -check -recursive infra/terraform/` → exit 0 (clean).
- `terraform validate` on 15 targets (11 modules + bootstrap + dev + staging + prod) → all `Success! The configuration is valid.`
- Redpanda module fmt-checked (third-party provider, registry init skipped per no-live-call constraint).

### Files authored (37 total)
3 workflows, 3 OPA rego, 3 Checkov checks, 1 checkov.yaml, 1 gitleaks.toml, 13 TF modules, 1 TF bootstrap, 6 TF env roots/backends, 1 ArgoCD app-of-apps, 8 ArgoCD Applications (4 staging + 4 prod), 1 Helm values-dev, 1 branch-protection.md, 1 developer report.

## 2026-06-15T14:06:21Z — system — Stakeholder approval received
**Action:** chore-platform-foundations-sprint0 approved at Stakeholder gate; advancing to Stage 8 (deploy).
