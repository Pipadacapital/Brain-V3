# Pass 15: CI/CD & DevOps Audit (devops)

**Date:** 2026-06-19
**Board:** devops
**Scope:** `.github/workflows/*.yml`, `infra/terraform/`, `infra/helm/`, `infra/argocd/`, `.checkov.yaml`, `turbo.json`, `Makefile`

---

## Board Verdict

The CI/CD pipeline has a solid structural skeleton — OIDC-federated AWS access, cosign image signing, immutable ECR digests, ArgoCD GitOps with staging auto-sync and manual prod gate, Checkov + OPA/Conftest IaC policy enforcement, gitleaks secret scanning, Trivy + OSV dependency scanning, and Turbo-affected build optimization. However, six concrete defects were found by reading the actual files:

1. **Critical: broken digest propagation** — the `gitops-staging` job references `matrix.app` (which does not exist outside the `build-and-push` matrix job), meaning every staging deploy carries an empty digest, and the `sed` fallback silently no-ops. No staging manifest is ever actually bumped. Prod promotion then reads those empty fields from staging manifests — the entire GitOps digest-pin chain is broken end-to-end.
2. **High: Trivy action pinned to `@master`** — a mutable, unsigned tag; supply-chain risk on the only container-vuln gate.
3. **High: Helm chart bodies missing** — ArgoCD prod/staging manifests for `core`, `stream-worker`, and `web` reference `infra/helm/core`, `infra/helm/stream-worker`, `infra/helm/web` paths that do not exist in the repo; first real deploy will hard-fail.
4. **High: SAST omitted from the pipeline** — doc 04 §L CI diagram lists `SAST` as a blocking scan step; no semgrep, CodeQL, or equivalent is present.
5. **Medium: `eval.yml` is a stub** — the NLQ eval gates (false-bind→0, injection golden-set, narration-faithfulness) mandated by doc 04 §N.5 as Phase-1c blocking checks are a single `echo "TODO"` line.
6. **Medium: `contents: write` permission over-scoped at workflow level** — `main.yml` grants `contents: write` and `packages: write` globally to all jobs including the `build-and-push` job, which only needs `id-token: write`. The write permission should be narrowed to only the gitops commit jobs.
7. **Low: CloudWatch composite alarm has no `alarm_actions`** — the EKS-unhealthy alarm fires silently; no SNS, PagerDuty, or OpsGenie hook is wired.

**Severity count: Critical 1 · High 3 · Medium 2 · Low 1**

---

## Finding DEVOPS-1

**Title:** Broken staging digest propagation — `matrix.app` used outside its matrix context silently nulls every image pin

**Severity:** Critical
**Category:** Pipeline correctness / artifact management
**Priority:** P0

**evidenceRef:** `.github/workflows/main.yml:120-128`

```yaml
for app in collector stream-worker core web; do
  DIGEST_VAR="${app//-/_}_digest"
  DIGEST="${{ needs.build-and-push.outputs[format('{0}_digest', matrix.app)] }}"
```

`matrix.app` is only defined within a `strategy.matrix` job. The `gitops-staging` job (line 100) has **no matrix** — `matrix.app` evaluates to an empty string, so `format('{0}_digest', '')` = `_digest`, and `needs.build-and-push.outputs['_digest']` is always empty. The `if [ -n "$DIGEST" ]` guard on line 123 then silently skips every `sed` update. No staging manifest ever has its `images:` field populated. The `prod-promote` step at lines 178-180 greps for `image:` in the staging YAML and finds nothing meaningful — prod also ships with empty image pins. The cosign signing at line 94 uses the digest correctly within the matrix build, but the GitOps write-back that anchors deployment is dead.

**rootCause:** Copy-paste error — the format expression was written assuming `gitops-staging` runs as a matrix job, but it runs as a single job consuming matrix outputs via `needs.build-and-push.outputs[<key>]`. The correct pattern is to call each output by its literal name (e.g., `needs.build-and-push.outputs.collector_digest`), not via matrix expansion.

**impact:** Staging and prod are never pinned to a specific immutable digest. ArgoCD either deploys the last manually-set image or enters a sync-error state. The entire "immutable digest → staging bake → promote" pipeline described in doc 04 §L is non-functional in its current form.

**fix:** In `gitops-staging`, replace the single-loop body with per-app explicit output references:
```yaml
COLLECTOR_DIGEST="${{ needs.build-and-push.outputs.collector_digest }}"
STREAM_WORKER_DIGEST="${{ needs.build-and-push.outputs.stream-worker_digest }}"
CORE_DIGEST="${{ needs.build-and-push.outputs.core_digest }}"
WEB_DIGEST="${{ needs.build-and-push.outputs.web_digest }}"
```
Then reference each by name inside the loop. Similarly fix `prod-promote` to not rely on staging manifest grep but to use the same named outputs directly.

**tenantImpact:** All tenants — staging and prod carry wrong image for every merge to main.
**detection:** A hard staging deployment failure (ArgoCD health check degraded / ImagePullBackOff) will surface it, but only on the first real deploy. Currently silent because no nodes run.

---

## Finding DEVOPS-2

**Title:** Trivy action pinned to mutable `@master` tag — supply-chain risk on the only container-vuln gate

**Severity:** High
**Category:** Supply chain security / CI integrity
**Priority:** P1

**evidenceRef:** `.github/workflows/pr.yml:151` and `:161`

```yaml
uses: aquasecurity/trivy-action@master
```

Both the image scan step (line 151) and the filesystem scan step (line 161) pin to `@master`, an unsigned mutable ref. Every other action in all four workflows pins to a semver tag (`@v3`, `@v4`, `@v2.3.8` etc.). A supply-chain compromise of the `aquasecurity/trivy-action` repo at HEAD would silently replace the only container-vuln blocking gate with attacker-controlled code that runs with `id-token: write` permission in the PR context.

**rootCause:** Tag chosen from docs that used `@master` as their example; was not caught in code review because the action does produce correct output on `@master` today.

**fix:** Pin to the latest stable SHA or semver release tag, e.g., `aquasecurity/trivy-action@0.30.0` (verify the current stable release), and add the SHA comment. Track in Dependabot/Renovate for automated updates.

**tenantImpact:** No direct tenant impact; impacts CI integrity and code security gate posture.
**detection:** Only surfaced if a supply-chain attack occurs; no automated alert for mutable tag usage.

---

## Finding DEVOPS-3

**Title:** ArgoCD manifests reference non-existent Helm chart directories — first real deploy hard-fails

**Severity:** High
**Category:** Deploy reliability / artifact management
**Priority:** P1

**evidenceRef:**
- `infra/argocd/envs/prod/core.yaml:17` — `path: infra/helm/core`
- `infra/argocd/envs/prod/stream-worker.yaml:18` — `path: infra/helm/stream-worker`
- `infra/argocd/envs/prod/web.yaml:17` — `path: infra/helm/web`
- `infra/argocd/envs/staging/core.yaml:17` — `path: infra/helm/core`
- `infra/argocd/envs/staging/stream-worker.yaml:18` — `path: infra/helm/stream-worker`
- `infra/argocd/envs/staging/web.yaml:17` — `path: infra/helm/web`

`infra/helm/README.md` (line 1) says "one chart per deployable", but only `infra/helm/authentik/` contains any file — there are no `infra/helm/core/`, `infra/helm/stream-worker/`, or `infra/helm/web/` directories (verified with `find infra/helm -type d`). The collector ArgoCD manifests use `infra/k8s/collector/overlays/{staging,production}` (also absent) but are kustomize-backed rather than Helm. All seven prod and staging ArgoCD Application resources will error on sync: `ComparisonError: rpc error: ... path infra/helm/core does not exist`.

**rootCause:** The Helm chart bodies are a known pending deliverable — the `helm/README.md` declares the intent without the implementation. However, the ArgoCD manifests that reference them are committed as if they are ready, which means a sync attempt will immediately hard-fail. This is a pre-production gap: the apps cannot be deployed without the charts.

**fix:** Either stub minimal `Chart.yaml` + `templates/deployment.yaml` + `values-staging.yaml` / `values-prod.yaml` per service (sufficient to unblock ArgoCD), or mark the ArgoCD Application manifests as suspended (`operation: {sync: {prune: false}}`) with a TODO until charts land.

**tenantImpact:** All tenants — no service can be deployed to staging or prod.
**detection:** ArgoCD will show `ComparisonError` / `OutOfSync` on first sync attempt; surfaces immediately on ArgoCD bootstrap.

---

## Finding DEVOPS-4

**Title:** SAST omitted from PR pipeline — doc 04 §L mandates it as a blocking scan step

**Severity:** High
**Category:** Pipeline completeness / security baseline
**Priority:** P1

**evidenceRef:** `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:2101`

```
PAR --> B[docker build] --> SC[scan: trivy + secrets + SAST]
```

The CI architecture diagram explicitly lists SAST as part of the blocking `SC` (scan) gate. The implemented `pr.yml` runs Trivy (image + filesystem) and gitleaks (secrets), but there is no semgrep, CodeQL, njsscan, or any other SAST tool. The missing coverage is particularly relevant for the AI modules (`apps/core/src/modules/ai/`) where prompt injection, untrusted-text envelope escape, and LLM-gateway misconfiguration are the highest-risk code paths for a multi-tenant SaaS.

**rootCause:** SAST was documented but not implemented; the comment in `pr.yml` line 3 (`# Phase-1a BLOCKING gates`) implies completeness but SAST is absent from the actual job list.

**fix:** Add a `semgrep-scan` job (or CodeQL if GitHub Advanced Security is licensed) as a required status check. At minimum run `semgrep --config=auto --error` scoped to `apps/` and `packages/` and add it to the `branch-protection.md` required checks table.

**tenantImpact:** All tenants — undetected injection or logic bugs in shared code affect all brands.
**detection:** Not detected until a security incident; no automated signal.

---

## Finding DEVOPS-5

**Title:** `eval.yml` AI gate is a no-op stub — Phase-1c NLQ eval blocking gates do not exist

**Severity:** Medium
**Category:** Pipeline completeness / AI quality gate
**Priority:** P2

**evidenceRef:** `.github/workflows/eval.yml:9`

```yaml
- run: 'echo "TODO: run AI eval gates"'
```

Doc 04 §L defines Phase-1c blocking gates: NLQ resolution eval (false-bind→0), injection golden-set, narration-faithfulness. The `eval.yml` workflow exists, has the correct trigger (paths to `apps/core/src/modules/ai/**`), but its only step is an echo stub. If an AI change is merged, the gate fires but always passes. The `nlq-resolution.eval.test.ts` file exists in `apps/core/src/modules/ai/evaluation/` (referenced in the bounded context map) but is not invoked from this workflow.

**rootCause:** Eval tooling scaffolding was committed as a placeholder for Phase-1c; the actual invocation command was not implemented.

**fix:** Wire the existing eval test file: `pnpm turbo run eval:nlq --affected` (or equivalent) and add the step. Ensure the eval exits non-zero on false-bind rate > 0 per the Phase-1c spec.

**tenantImpact:** All brands using NLQ — a regressions in false-bind rate or prompt injection bypass would pass CI silently.
**detection:** Only surfaced via a customer-reported incorrect answer or a security incident; no automated signal.

---

## Finding DEVOPS-6

**Title:** `main.yml` workflow-level `contents: write` over-scopes all jobs including build-only jobs

**Severity:** Medium
**Category:** CI permissions / least-privilege
**Priority:** P2

**evidenceRef:** `.github/workflows/main.yml:6-9`

```yaml
permissions:
  contents: write       # bump Helm values + gitops commit
  id-token: write       # OIDC for AWS ECR push
  packages: write
```

The `contents: write` and `packages: write` permissions are declared at the workflow level, meaning every job — including `build-and-push` (which only needs `id-token: write` for OIDC) — inherits write access to the repository contents. If the build step executes compromised third-party code (e.g., a malicious `pnpm` package or a supply-chain attack on `aquasecurity/trivy-action@master`), it can write arbitrary commits to `main`. The gitops write-back justifies `contents: write` in `gitops-staging` and `prod-promote` jobs, but not in `build-and-push`.

**rootCause:** Permissions were set at the workflow level as a convenience rather than being scoped per-job.

**fix:** Move permissions to job level. `build-and-push` should declare only `id-token: write`. `gitops-staging` and `prod-promote` should declare `contents: write`. Remove `packages: write` unless GHCR is intentionally used (ECR is the primary registry).

**tenantImpact:** All tenants — a compromised build step with write access to main could inject malicious code affecting all deployments.
**detection:** GitHub audit log would show unexpected pushes; not proactively alerted.

---

## Finding DEVOPS-7

**Title:** CloudWatch composite EKS alarm has no `alarm_actions` — fires silently

**Severity:** Low
**Category:** Operational readiness / observability
**Priority:** P3

**evidenceRef:** `infra/terraform/modules/observability/main.tf:138-149`

```hcl
resource "aws_cloudwatch_composite_alarm" "eks_unhealthy" {
  alarm_name        = "${var.project}-${var.environment}-eks-cluster-unhealthy"
  alarm_description = "Composite: EKS cluster health degraded (${var.environment}). See child alarms."
  alarm_rule        = "ALARM(...) OR ALARM(...)"
  # No alarm_actions, ok_actions, or insufficient_data_actions
}
```

The composite alarm and both child alarms (`pod_crashloop`, `node_not_ready`) have no `alarm_actions`. The auto-rollback narrative in `main.yml:197-206` references Grafana Cloud as the SLO monitoring surface, but the EKS infrastructure-level alarm (CrashLoopBackOff, node not ready) has no SNS topic or notification hook. This means EKS cluster degradation can go unnoticed until someone manually checks the dashboard.

**rootCause:** SNS topic creation (and PagerDuty/OpsGenie endpoint binding) was deferred as out of scope for Sprint-0 IaC bootstrap; the alarm resources were declared without the notification wire-up.

**fix:** Add an `aws_sns_topic` and `alarm_actions = [aws_sns_topic.ops_alerts.arn]` to the composite alarm. The SNS topic subscription (email/PagerDuty/Slack) can be managed outside Terraform but the topic itself should be declared alongside the alarm.

**tenantImpact:** All tenants — silent EKS degradation means slower incident response, extending outage window beyond the 30-min RTO commitment.
**detection:** Surfaced only when someone manually opens CloudWatch or Grafana; no proactive alert.
