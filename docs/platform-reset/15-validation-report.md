# 15 — Validation Report (repo-wide sweep)

**Branch:** `feat/platform-selective-rebuild`
**Date:** 2026-07-14
**Scope:** VALIDATION LANE — read + validate only. Only new file created is this report.
**Program:** Selective rebuild (ADR-0001…0005), additive / reversible / flag-gated.

## Overall verdict: **GREEN**

All infra validators pass. `terraform fmt -recursive` reports zero drift; `terraform validate`
succeeds on all three envs (prod/dev/staging); all 5 changed Helm charts lint + template + parse
clean under both `values-prod.yaml` and default values; all changed workflow YAML parses; both
changed/new shell scripts pass `bash -n`; and no destructive/live-apply artifacts were introduced
(the only `terraform destroy` strings are targeted per-module ROLLBACK comments — additive
reversibility documentation, not apply steps). The one non-green signal — `knip` exit=1 — is a
**pre-existing** unused file unrelated to this branch (this branch touches zero TS/JS). No lane
crossed into another lane's file ownership; no two lanes edited the same file with conflicting intent.

---

## 1. Validator results (summary)

| Validator | Command | Result |
|---|---|---|
| Terraform fmt | `terraform fmt -check -recursive infra/terraform` | **PASS** (exit 0, no drift) |
| Terraform validate — prod | `(cd envs/prod && terraform validate)` | **PASS** (Success! config valid) |
| Terraform validate — dev | `(cd envs/dev && terraform validate)` | **PASS** |
| Terraform validate — staging | `(cd envs/staging && terraform validate)` | **PASS** |
| Helm lint × 5 charts | `helm lint <chart> -f <chart>/values-prod.yaml` | **PASS** (0 failed; only `icon is recommended` INFO) |
| Helm template × 5 (prod values) | `helm template <chart> -f values-prod.yaml` | **PASS** (all exit 0, rendered YAML parses) |
| Helm template × 5 (default values) | `helm template <chart>` | **PASS** (all exit 0) |
| Workflow YAML parse × 2 | `yaml.safe_load` | **PASS** |
| Shell syntax × 2 | `bash -n` | **PASS** |
| Destructive-artifact grep | see §5 | **PASS** (none; only rollback comments) |
| knip | `npx knip` | **exit 1 — PRE-EXISTING, not this branch** (see §6) |

Note on offline limits: `terraform validate` needs an initialized backend/providers. The prod, dev
and staging env roots were already `.terraform`-initialized, so validate ran for real and passed.
The standalone module dirs (`alerting`, `security-baseline`, `observability`, `aurora`, etc.) are
not independently init'd, but they are consumed by the env roots that DID validate, so their HCL is
covered transitively. No `terraform plan`/`apply` was run (correctly — this is filesystem-only lane).

---

## 2. Change surface (`git diff --stat HEAD`)

37 tracked files changed (+883 / −45) plus 13 untracked new files. Total ≈ 50 files, all
IaC / Helm / workflow / docs / shell — **zero application TS/JS**.

---

## 3. Files grouped by lane (attributed by subsystem)

Lane names are inferred from the ADR/redesign structure; the orchestrator's 6 implementation lanes
map cleanly onto distinct subsystems with **no file-ownership overlap**.

### Lane A — Catalog + Trino topology rebuild (ADR-0002)
| File | Δ (add/del) | Validator |
|---|---|---|
| `infra/helm/iceberg-rest/templates/deployment.yaml` | +31/−1 | lint+template PASS |
| `infra/helm/iceberg-rest/templates/pvc.yaml` (new) | +24 | template PASS |
| `infra/helm/iceberg-rest/values-prod.yaml` | +8 | PASS |
| `infra/helm/iceberg-rest/values.yaml` | +34/−4 | PASS |
| `infra/helm/trino/templates/_helpers.tpl` | +17 | PASS |
| `infra/helm/trino/templates/configmaps.yaml` | +96 | PASS |
| `infra/helm/trino/templates/batch-coordinator-deployment.yaml` (new) | +112 | PASS |
| `infra/helm/trino/templates/batch-worker-deployment.yaml` (new) | +113 | PASS |
| `infra/helm/trino/templates/batch-service.yaml` (new) | +22 | PASS |
| `infra/helm/trino/templates/batch-worker-scaledobject.yaml` (new) | +28 | PASS |
| `infra/helm/trino/values-prod.yaml` | +57 | PASS |
| `infra/helm/trino/values.yaml` | +75 | PASS |
| `docs/platform-reset/runbooks/iceberg-catalog-migration.md` (new) | +203 | doc |

### Lane B — Compute topology: Karpenter Spot/Graviton + KEDA scale-to-zero (ADR-0003)
| File | Δ | Validator |
|---|---|---|
| `infra/helm/karpenter/templates/nodepools.yaml` | +25 | lint+template PASS |
| `infra/helm/karpenter/values.yaml` | +29 | PASS |
| `infra/terraform/modules/aurora/main.tf` | +29/−1 | fmt+validate PASS |
| `infra/terraform/modules/elasticache/main.tf` | +17 | PASS |
| `infra/terraform/modules/nat-instance/main.tf` | +17/−3 | PASS |

### Lane C — Kafka reliability (AZ-spread, 2× Connect)
| File | Δ | Validator |
|---|---|---|
| `infra/helm/strimzi-kafka/templates/kafka-cr.yaml` | +11 | lint+template PASS |
| `infra/helm/strimzi-kafka/values-prod.yaml` | +25 | PASS |
| `infra/helm/strimzi-kafka/values.yaml` | +6 | PASS |
| `infra/helm/kafka-connect/templates/deployment.yaml` | +12 | PASS |
| `infra/helm/kafka-connect/templates/service.yaml` | +11 | PASS |
| `infra/helm/kafka-connect/values-prod.yaml` | +41/−1 | PASS |
| `infra/helm/kafka-connect/values.yaml` | +12/−1 | PASS |

### Lane D — Security baseline: CloudTrail + GuardDuty + KMS (ADR-0004/0005)
| File | Δ | Validator |
|---|---|---|
| `infra/terraform/modules/security-baseline/main.tf` (new) | +264 | fmt+validate PASS |
| `infra/terraform/envs/prod/security-baseline.tf` (new) | +69 | PASS |
| `infra/terraform/modules/kms/main.tf` | +91/−1 | PASS |
| `infra/terraform/modules/s3-audit/main.tf` | +64 | PASS |

### Lane E — Observability + actionable alerting (ADR-0004)
| File | Δ | Validator |
|---|---|---|
| `infra/terraform/modules/alerting/main.tf` (new) | +284 | fmt+validate PASS |
| `infra/terraform/envs/prod/alerting.tf` (new) | +75 | PASS |
| `infra/terraform/envs/prod/observability.tf` (new) | +42 | PASS |
| `infra/terraform/modules/observability/main.tf` | +32/−3 | PASS |
| `infra/terraform/envs/prod/log-retention-aud-infra-014.tf` | +7/−1 | PASS |

### Lane F — Repo standards, guards, prod-env glue, docs
| File | Δ | Validator |
|---|---|---|
| `tools/lint/v4-naming-guard.sh` | +13/−7 | `bash -n` PASS |
| `tools/lint/cost-guard.sh` (new) | +218 | `bash -n` PASS |
| `.github/workflows/pr.yml` | +21 | YAML parse PASS |
| `.github/workflows/knip.yml` | +16/−10 | YAML parse PASS |
| `infra/terraform/envs/prod/bootstrap.tf` | +24 | fmt+validate PASS |
| `infra/terraform/envs/prod/terraform.tfvars` | +29 | validate PASS |
| `infra/terraform/envs/prod/variables.tf` | +21 | validate PASS |
| `claude.md → CLAUDE.md` (rename +4/−4) | +4/−4 | doc; reflects Spark→DuckDB (PR #148) + R6 guard |
| `docs/platform-reset/00-executive-summary.md` | +2/−2 | doc |
| `docs/platform-reset/02-destruction-plan.md` | +1/−1 | doc (shelved) |
| `docs/platform-reset/adr/adr-0001…0005.md` | +1/−1 each | doc |
| `docs/platform-reset/10-hygiene-and-apply-runbook.md` (new) | +176 | doc |

---

## 4. File-ownership / overlap check

**No overlap.** Each subsystem is edited by exactly one lane. Cross-lane touch points are only the
shared prod-env glue files (`bootstrap.tf`, `variables.tf`, `terraform.tfvars`) which are owned by
Lane F and merely reference the new modules — they do not duplicate module bodies. The three new
per-env include files (`alerting.tf`, `observability.tf`, `security-baseline.tf`) are cleanly split:
alerting.tf/observability.tf (Lane E) vs security-baseline.tf (Lane D), each `module` block distinct.
No two lanes wrote the same resource address. No merge-conflict markers present.

---

## 5. Destructive / live-apply artifact scan — CLEAN

Grepped the full tracked diff **and** all untracked files (excluding the shelved
`02-destruction-plan.md`, the `10-hygiene-and-apply-runbook.md`, and `runbooks/*`) for:
`terraform destroy`, `delete-cluster`, `force-delete`, `skip_final_snapshot`, `force_destroy`,
`kubectl delete`, `--force`.

- **Zero** live-apply artifacts in code.
- The only `terraform destroy` hits are ROLLBACK-instruction comments — targeted, additive-module
  removal (`terraform destroy -target module.alerting` / `module.security_baseline`) documenting
  reversibility. These are comments, not apply steps.
- Aurora safety settings move in the SAFE direction: `skip_final_snapshot = false` (takes a final
  snapshot) and `deletion_protection = true` for prod. **No regression** to banked posture.
- `cluster_version = "1.33"` preserved (EKS STANDARD/AL2023 banked win intact).

---

## 6. Honest failures / caveats

1. **knip exit=1 (NOT this branch).** knip reports 1 unused file:
   `.claude/workflows/wave1-parallel-prep.js`. This file is **pre-existing and tracked**, is NOT in
   this branch's change surface, and this branch touches **zero** TS/JS. The exit code is therefore
   not attributable to the selective-rebuild work. It does mean the repo's `knip` gate is currently
   red on `master` baseline independent of this PR — worth a separate cleanup, but out of this lane's
   scope. (Remaining knip output is 61 "configuration hints," all advisory.)
2. **terraform validate module coverage is transitive, not standalone.** The new standalone module
   dirs aren't independently `terraform init`'d offline; they validated via the prod env root that
   consumes them. A full `terraform init && validate` per module (needs provider download) is the
   only thing not exercised offline. Env-root validate passing is strong coverage.
3. **No `terraform plan`.** Correctly not run (filesystem-only lane; would touch remote state). Plan
   remains the owner's Part-B step in `10-hygiene-and-apply-runbook.md`.

---

## 7. Top follow-ups

1. Owner runs `terraform plan` per env (Part B of the hygiene runbook) before any promotion — this
   report validates syntax/lint only, not the resource-level plan diff.
2. Address the pre-existing `knip` red (`.claude/workflows/wave1-parallel-prep.js`) in a separate
   housekeeping PR so the gate is green independent of this branch.
3. (Optional) Add `helm template | kubeconform`/`kubectl --dry-run=server` in CI to catch schema
   issues that `helm lint` cannot (lint validates chart structure, not K8s API conformance).
