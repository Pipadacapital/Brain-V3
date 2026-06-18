# Audit Report — PASS 15: CI/CD & DevOps + IaC (board: devops-cicd)

**Auditor:** Independent principal reviewer (no codebase attachment)
**Scope:** `.github/workflows/{eval,infra,main,pr}.yml`, `infra/{terraform,argocd,helm,observe,redpanda}`, `.checkov.yaml`, `policy/`, `.github/policy/`
**Date:** 2026-06-19
**Method:** Read every workflow + every terraform module + every argocd app manifest; verified path/asset existence on disk.

---

## Executive summary

The IaC *foundation* layer (state bootstrap, KMS, OIDC trust scoping, IRSA `StringEquals` discipline, ECR immutability, S3/RDS encryption, Checkov/OPA gates) is genuinely well-built and shows real security discipline. **But the deploy path is a façade: the CI build job, the ArgoCD apps, and the prod promotion job all reference files that do not exist in the repository.** There is not a single `Dockerfile`, not a single Helm chart for an app service, and the entire `infra/k8s/` Kustomize tree referenced by two of four ArgoCD apps is absent. The "auto-rollback" the workflow advertises in `echo` banners has **no implementing resource** — the CloudWatch composite alarm has no `alarm_actions`. Prod cannot deploy at all (network/EKS/RDS modules are commented out), and the ECR *push* role the build job assumes is never created by Terraform. The pipeline would fail at the first `docker build`.

**Counts:** Critical 4 · High 7 · Medium 6 · Low 4

---

## CRITICAL findings

### C1 — No Dockerfiles exist; the entire build-and-push pipeline is dead on arrival
**Severity:** Critical | **Category:** Build reproducibility / pipeline integrity
**Evidence:** `.github/workflows/main.yml:74` and `pr.yml:146` build with `-f apps/${{ matrix.app }}/Dockerfile`. Filesystem check: `find . -name 'Dockerfile*' -not -path '*/node_modules/*'` returns **zero results**. `ls apps/` shows `collector core stream-worker web` — none contain a Dockerfile.
**Impact (prod):** Every `build-and-push` matrix leg fails at `docker build` ("Dockerfile not found"). No image is ever produced or pushed to ECR. The advertised "deploy pipeline from day one" does not exist as a runnable artifact — it is YAML scaffolding around missing inputs. The DoD claim "a service is not done until it can deploy itself on its own image" is unmet for all four services.
**Root cause:** Workflow + ArgoCD authored ahead of the container assets; never reconciled.
**Recommended fix:** Add multi-stage `apps/<svc>/Dockerfile` (slim base → deps → builder → non-root runner, `HEALTHCHECK`) for all four services; add a CI smoke job that asserts each referenced Dockerfile exists before the matrix runs.
**Priority:** P0 | **Tenant impact:** N/A (nothing ships → all tenants) | **Detection:** CI run fails at build step; no ECR push event/metric.

### C2 — ArgoCD apps reference non-existent manifests (no Helm charts, no `infra/k8s/` tree); GitOps deploy cannot sync
**Severity:** Critical | **Category:** Deploy strategy / GitOps integrity
**Evidence:**
- `infra/argocd/envs/{staging,prod}/core.yaml:17` → `path: infra/helm/core` + `valueFiles: [values-prod.yaml]`. `ls infra/helm` shows only `README.md` and `authentik/values-dev.yaml` — **`infra/helm/core` does not exist**, no `values-*.yaml`.
- `infra/argocd/envs/prod/collector.yaml:26` → `path: infra/k8s/collector/overlays/production` (Kustomize). `ls infra/k8s` → **MISSING infra/k8s**.
- `web.yaml`/`stream-worker.yaml` → `infra/helm/{web,stream-worker}` — also absent.
**Impact (prod):** Every ArgoCD Application enters `ComparisonError`/`Unknown` and never deploys a workload. The "staging auto-sync" and "prod manual promote" gates have nothing to reconcile. No service runs in any cluster.
**Root cause:** App manifests written before the deployment manifests; no CI lint validating the referenced source path renders.
**Recommended fix:** Create the Helm charts / Kustomize bases the apps point at; add an ArgoCD `app diff`/`kustomize build`/`helm template` lint job in CI that fails when a referenced `path` does not render.
**Priority:** P0 | **Tenant impact:** all tenants (no runtime) | **Detection:** ArgoCD app health `Missing`/`Unknown`; sync error in Argo UI.

### C3 — Inconsistent deploy tooling across services (Helm for 3, Kustomize for 1) contradicts the documented uniform GitOps structure
**Severity:** Critical | **Category:** Deploy strategy consistency
**Evidence:** Per `grep path:/helm:/kustomize:` across `infra/argocd/envs/prod/*.yaml`: `core/web/stream-worker` use `helm:` + `valueFiles`; `collector` uses `kustomize:` at `infra/k8s/collector/overlays/production`. The `manifest-generate-paths` annotations also disagree: `core.yaml:7` = `infra/helm/core` (no leading slash) vs `collector.yaml:17` = `/infra/k8s/collector/` (leading slash — an ArgoCD path-match footgun). The `devops-aws` reference prescribes one structure (Kustomize base+overlays) per service; the Canon's gitops-bump job (`main.yml:118-128`) `sed`s a `image: ...brain-${app}-staging@sha256` line that matches **neither** the Helm `valueFiles` shape nor the Kustomize `images: []` shape.
**Impact (prod):** The CI digest-bump in `main.yml` is a no-op against both tooling styles (the `sed` regex matches no line in a Helm values file or a Kustomize app `images` list), so even if charts existed, image promotion would silently not update. Mixed tooling doubles the maintenance surface and breaks the selective-deploy uniformity assumption.
**Root cause:** Two authors/two patterns merged without convergence; no schema for the manifest the bump job edits.
**Recommended fix:** Pick ONE tool (Kustomize overlays + `kustomize edit set image`, or Helm + a values key the bump job sets deterministically). Make the CI image-bump operate on that exact key.
**Priority:** P0 | **Tenant impact:** all tenants | **Detection:** post-merge, prod manifest never shows new digest; "promoted" but old image runs.

### C4 — "Auto-rollback" is theater: the composite alarm has no `alarm_actions`; no SNS/Lambda/Argo wiring exists
**Severity:** Critical | **Category:** Rollback safety
**Evidence:** `main.yml:197-207` prints an "AUTO-ROLLBACK ARMED" banner with thresholds (accept rate <99.95%, error >1%, p95 >2s, 2 failed probes). The only alarm resource is `infra/terraform/modules/observability/main.tf:138-149` `aws_cloudwatch_composite_alarm.eks_unhealthy` — it has **no `alarm_actions`, no `ok_actions`, no SNS topic, no Lambda**. `grep 'rollback|alarm_actions|sns|lambda'` in the observability module → empty. No `kind: Rollout` (Argo Rollouts) anywhere; ArgoCD apps are plain `Application` with `automated.selfHeal` only (which re-applies the *new* bad manifest, not a rollback). The collector app comment (`collector.yaml:55`) documents rollback as a **manual** `argocd app rollback` command.
**Impact (prod):** A bad deploy that breaches the stated SLOs triggers nothing automatic. The composite alarm fires into the void. "Auto-rollback armed" in the deployment report is false; an operator must notice and run a manual rollback — there is no bake-window automation. The advertised composite-alarm→rollback chain (`devops-aws` §Auto-rollback) is absent.
**Root cause:** Alarm authored for visibility only; the action/automation half never built; the workflow banner overstates capability.
**Recommended fix:** Wire `alarm_actions = [sns_topic]` → a rollback Lambda/`argocd app rollback` runner (or adopt Argo Rollouts with an `AnalysisTemplate` on the SLO metrics). Add accept-rate/error/p95 metric alarms (only crashloop + node-count exist today — the SLO metrics in the banner have no alarm). Until automated, change the banner to say "MANUAL rollback only."
**Priority:** P0 | **Tenant impact:** multi-tenant blast radius — a cross-brand isolation breach the banner claims auto-rolls-back (`main.yml:205`) in fact does not. | **Detection:** incident postmortem ("alarm fired, nothing happened").

---

## HIGH findings

### H1 — Prod environment cannot deploy: network/EKS/RDS/S3 modules are all commented out
**Severity:** High | **Category:** Env parity / deployability
**Evidence:** `infra/terraform/envs/prod/bootstrap.tf` — `grep '^module'` returns only `kms` and `oidc_github`. Lines 62-99 comment out `network`, `eks`, `rds`, `s3_iceberg`, `s3_audit`. The prod root is bootstrap-only ("apply deferred to M4").
**Impact (prod):** There is no prod cluster, DB, VPC, or buckets. The `prod-promote` job (`main.yml:151`) promotes manifests to a cluster that does not exist. "Manual prod promotion" is a no-op. Staging/prod parity is broken at the infra level: staging declares EKS/RDS (count=0), prod declares neither.
**Root cause:** Phased rollout, but the deploy workflow assumes prod exists.
**Recommended fix:** Either gate `prod-promote` on a prod-exists check, or land the prod modules (at node/instance count 0, mirroring staging) so parity holds and the promote job has a real target.
**Priority:** P1 | **Tenant impact:** all (no prod) | **Detection:** `prod-promote` "promotes" but nothing changes; ArgoCD prod cluster unreachable.

### H2 — ECR *push* role assumed by CI is never created by Terraform (only a read-only plan role exists)
**Severity:** High | **Category:** Secrets/credentials / OIDC
**Evidence:** `main.yml:57` assumes `${{ vars.AWS_ECR_PUSH_ROLE_ARN }}`. The only OIDC role Terraform creates is `oidc-github/main.tf:101` `github_plan` — its permission policy (`:112-169`) is `Describe*`/`Get*`/`List*` + state read/lock only; **no `ecr:*` push, no `sts` for an ECR role**. `grep 'ecr.*push|ECRPush'` across `infra/terraform/` → empty.
**Impact (prod):** Even with a Dockerfile, the build job's `configure-aws-credentials` would fail to assume a non-existent role, or (if hand-created out-of-band) the role lives outside IaC — an out-of-band provisioning anti-pattern (the role's trust/permissions are unaudited and undrift-checked).
**Root cause:** The OIDC module models only the plan role; the push role was assumed to exist as a repo var.
**Recommended fix:** Add an `ecr-push` IAM role to the oidc-github module (trust scoped to repo+main, permission = `ecr:GetAuthorizationToken` + `ecr:*Layer*`/`PutImage` on the four repos only). Export its ARN; set `AWS_ECR_PUSH_ROLE_ARN` from the output.
**Priority:** P1 | **Tenant impact:** N/A (build infra) | **Detection:** CI `AssumeRoleWithWebIdentity` AccessDenied.

### H3 — OIDC trust is scoped to `refs/heads/main` only, but the infra plan gate runs on `pull_request` → PR plans cannot assume the role
**Severity:** High | **Category:** OIDC / pipeline correctness
**Evidence:** `oidc-github/main.tf:86-89` scopes `:sub` to `repo:org/repo:ref:refs/heads/${branch}` with `allowed_branches=["main"]` (set in all three envs, e.g. `envs/dev/main.tf:65`). But `infra.yml:5` triggers on `pull_request`, and the OPA plan step (`infra.yml:147-153`) assumes `AWS_DEV_PLAN_ROLE_ARN`. A PR's OIDC `sub` is `repo:org/repo:pull_request` (or `ref:refs/pull/N/merge`), **not** `refs/heads/main` → `StringEquals` fails.
**Impact (prod):** The plan-level OPA/Conftest gate (`infra.yml:187`) can never run on a PR with a real plan — it only ever hits the bootstrap "no plan JSON" skip branch. The plan-time NN-3/4/5 enforcement is effectively dead on PRs; only the static Checkov job covers IaC PRs. Contributors get no `terraform plan` preview on PRs.
**Root cause:** Trust condition copied for the main-push case without a `pull_request` subject.
**Recommended fix:** Add a PR-scoped subject (`repo:org/repo:pull_request`) to a *read-only plan* role's trust, or use a `StringLike` on `repo:org/repo:*` for the plan role *only* with environment protection — never for an apply role.
**Priority:** P1 | **Tenant impact:** N/A | **Detection:** PR infra job: plan step skipped/AccessDenied; OPA gate reports "no plan JSON" forever.

### H4 — Checkov uses a `check:` allowlist of ~16 IDs → hundreds of default security checks are silently disabled
**Severity:** High | **Category:** Policy-as-code / IaC scanning depth
**Evidence:** `.checkov.yaml:40-56` sets `check:` to an explicit list of 16 IDs. In Checkov, `check:` (allowlist) means **only those run**; every other built-in check (public security groups, IMDSv2, unencrypted EBS, IAM `*:*`, open 0.0.0.0/0 ingress, CloudTrail, VPC flow logs, etc.) is skipped. The header claims it "enforces the AWS security baseline" — it does not; it enforces 16 hand-picked checks.
**Impact (prod):** A wide class of misconfigurations passes the gate. E.g., a future SG with `0.0.0.0/0:22`, an IAM policy with `Action:*`, or a missing IMDSv2 hop-limit would not be caught. The gate gives false assurance.
**Root cause:** `check:` (allowlist) used where `skip-check:` (denylist) was intended.
**Recommended fix:** Remove the `check:` allowlist; run the full Checkov suite with `skip-check:` only for justified, ID-specific exceptions. Keep `hard-fail-on: HIGH`.
**Priority:** P1 | **Tenant impact:** multi-tenant (an undetected open SG/IAM star is cross-tenant) | **Detection:** only via external pentest/incident — the gate won't surface it.

### H5 — `main.yml` digest plumbing is broken: dead-code `sed`, undefined `matrix.app`/`steps.login-ecr` in non-matrix jobs
**Severity:** High | **Category:** Pipeline correctness
**Evidence:** `gitops-staging` (a non-matrix job) references `needs.build-and-push.outputs[format('{0}_digest', matrix.app)]` at `main.yml:122` — `matrix.app` is **undefined** in this job → expands empty. The `sed` at `:125` references `${{ steps.login-ecr.outputs.registry }}` but **no `login-ecr` step runs in `gitops-staging`** → empty registry. The loop var `DIGEST_VAR` at `:121` is computed then never used. The `sed` pattern targets `image:.*brain-${app}-staging@sha256:` which exists in no current manifest (C2/C3).
**Impact (prod):** The staging digest bump writes garbage or nothing; `git diff --staged --quiet` short-circuits to "no changes," so staging never advances to the new image even after a (hypothetical) successful build. The pipeline reports success while deploying nothing new.
**Root cause:** Copy-paste from the matrix build job into a non-matrix job without adjusting context.
**Recommended fix:** Pass digests as explicit job outputs keyed by app; in `gitops-staging` iterate the four named outputs (not `matrix.app`); compute the registry from a real `configure-aws-credentials`+`ecr-login` step or a known account/region; assert a non-empty diff before declaring success.
**Priority:** P1 | **Tenant impact:** N/A | **Detection:** "gitops bump" commit absent or empty after merge; staging pods unchanged.

### H6 — CI applies migrations only "through 0020" but 37 migrations exist (latest 0036) → tests run against a stale schema
**Severity:** High | **Category:** Env parity / test fidelity
**Evidence:** `pr.yml:60` comment "Apply all migrations through 0020"; it runs `pnpm migrate:up` (`package.json` → `node-pg-migrate -m db/migrations up`, which applies ALL). The comment is stale but the bigger issue: the parity/isolation tests (`pr.yml:67-69`) depend on later migrations (e.g. `0035_dq_check_result`, `0036_ai_provenance`, `0033_consent_record_tombstone`). `ls db/migrations | wc -l` = 37 (latest `0036`). If `migrate:up` is correct the comment lies; if any test or seed assumes ≤0020 there is a real drift.
**Impact (prod):** At minimum, misleading documentation of the CI schema state. If `brain_app` role provisioning (`pr.yml:43-61`) or any test fixture is pinned to 0020-era schema, parity/isolation gates validate a schema that diverges from prod's 37-migration state — a false-green on RLS/isolation.
**Root cause:** Comment not updated as migrations grew; CI schema assertion not pinned to "all applied + count check."
**Recommended fix:** Drop the "through 0020" comment; add a CI assertion that `count(applied migrations) == count(db/migrations/*.sql)`; ensure parity/isolation tests run on the full, current schema.
**Priority:** P1 | **Tenant impact:** multi-tenant (RLS/isolation tested on wrong schema) | **Detection:** isolation-fuzz green in CI but RLS gap in prod.

### H7 — `eval.yml` is a stubbed gate (`echo "TODO"`) presented as a quality job
**Severity:** High | **Category:** Pipeline integrity / gate honesty
**Evidence:** `.github/workflows/eval.yml:9` — the entire `ai-eval` job body is `- run: 'echo "TODO: run AI eval gates"'`. The comment (`:8`) lists NLQ-resolution, injection golden-set, narration-faithfulness as the intended gates.
**Impact (prod):** AI safety/quality gates (prompt-injection golden set, NLQ false-bind, narration faithfulness — directly relevant to an AI-native Commerce OS) are not enforced. A regression in the decision/AI layer ships unblocked. The workflow's existence implies coverage that is absent.
**Root cause:** Placeholder never implemented.
**Recommended fix:** Implement the three eval gates or remove the workflow so it doesn't masquerade as a gate; if kept as a placeholder, make it `exit 1` (visible red) rather than a green `echo`.
**Priority:** P1 | **Tenant impact:** multi-tenant (AI misbehavior) | **Detection:** green CI; AI regression reaches users.

---

## MEDIUM findings

### M1 — `latest` tag pushed to an IMMUTABLE-tag ECR repo → push will fail on the second deploy
**Severity:** Medium | **Category:** Artifact management
**Evidence:** `main.yml:71` tags `...:latest` and `:81` pushes `:${{ github.sha }}` (sha push is fine). But the `docker build` also tags `:latest` (`:71`); if a later step or cache pushes `latest`, ECR `image_tag_mutability = "IMMUTABLE"` (`eks/main.tf:240`) rejects re-pushing `latest`. Even the SHA tag is immutable — re-running a failed job for the same SHA fails the second push.
**Impact (prod):** Job re-runs (common on flakes) fail at push with `ImageTagAlreadyExists`. The `latest` convenience tag is unusable under IMMUTABLE.
**Root cause:** Mutable-tag habit applied to an immutable repo.
**Recommended fix:** Drop the `:latest` tag; push only the immutable digest/SHA; deploy by digest (already the intent). Make push idempotent (skip if digest exists).
**Priority:** P2 | **Tenant impact:** N/A | **Detection:** re-run push fails.

### M2 — No remote build cache; affected-detection recomputed in every job; matrix builds all four images then skips inside
**Severity:** Medium | **Category:** Pipeline efficiency / cost
**Evidence:** `main.yml:18-21` and `pr.yml:115-119` hardcode the matrix `[collector, stream-worker, core, web]` then compute `turbo --affected` *inside each leg* (`main.yml:42-50`) to set `skip`. There is no Turbo remote cache configured (no `TURBO_TOKEN`/`TURBO_API`/`turbo.json remoteCache`). Each of the four legs re-runs `pnpm install` + `turbo --dry-run`.
**Impact (prod):** 4× redundant installs + dry-runs per push; no cross-run cache reuse → slower, costlier CI. The `devops-aws` selective-deploy spec calls for a remote build cache making affected-but-unchanged a cache hit.
**Root cause:** Static matrix + in-leg skip instead of a dynamic matrix from `turbo --affected` JSON; no remote cache.
**Recommended fix:** Generate the matrix dynamically from the affected set (one `turbo --affected --dry-run=json` job → `fromJSON` matrix); configure Turbo remote cache (S3/Vercel) with OIDC.
**Priority:** P2 | **Tenant impact:** N/A | **Detection:** CI minutes/cost trend.

### M3 — Terraform state still on legacy DynamoDB lock; `use_lockfile` (TF 1.10+, native S3 lock) commented out though `required_version >= 1.9`
**Severity:** Medium | **Category:** IaC state safety
**Evidence:** `envs/dev/backend.tf:11` `dynamodb_table = "brain-tfstate-lock-dev"`; `:15` `# use_lockfile = true` commented. `bootstrap/main.tf:139` still creates the DynamoDB lock table. `devops-aws` (Terraform binding) flags `dynamodb_table` deprecated in 1.11 and recommends `use_lockfile` for 1.10+.
**Impact (prod):** Extra resource + cost; on a TF 1.11 bump the deprecated arg warns/breaks. Not a correctness bug today (locking works), but tech debt against the documented binding.
**Root cause:** Conservative compatibility choice; native locking left as a comment.
**Recommended fix:** Bump `required_version >= 1.10`, enable `use_lockfile = true`, retire the DynamoDB table after migration.
**Priority:** P2 | **Tenant impact:** N/A | **Detection:** TF deprecation warning on upgrade.

### M4 — EKS bootstrap deadlock risk: no static system node group when `system_node_min=0` (staging/prod), no Karpenter
**Severity:** Medium | **Category:** IaC correctness / cluster bring-up
**Evidence:** `eks/main.tf:193-228` defines one managed node group whose `desired/min/max` come from vars; staging sets all to `0` (`envs/staging/main.tf:82-84`), prod (when uncommented) intends the same per its commented block. There is **no Karpenter** module and **no always-on system node group** for CoreDNS/kube-proxy/Karpenter-controller. `devops-aws` warns: without a static MNG for system add-ons you hit a Karpenter bootstrap deadlock; here there's neither Karpenter nor a guaranteed system node.
**Impact (prod):** When compute is enabled at M4, a 0-min node group means no node hosts CoreDNS/controllers until something scales it — and nothing scales it (no Karpenter, no HPA on system pods). The cluster comes up with no schedulable capacity. The `devops-aws` Karpenter pattern (capacity-type, consolidation, arm64) is entirely absent.
**Root cause:** Cost-zero staging design (`min=0`) without a separate always-on system pool.
**Recommended fix:** Keep a tiny always-on system MNG (1/AZ) for add-ons even in "zero-compute" envs, or document that M4 must add it before workloads. Add the Karpenter module the reference prescribes.
**Priority:** P2 | **Tenant impact:** all (cluster won't bring up) | **Detection:** M4 bring-up: pods Pending, CoreDNS unschedulable.

### M5 — App-of-apps uses an ApplicationSet pattern in comments but ships hardcoded per-env Application files; no ApplicationSet resource
**Severity:** Medium | **Category:** GitOps structure
**Evidence:** `app-of-apps.yaml:40-41` comments "ApplicationSet generator picks up all env-specific app manifests," and the root Application `path: infra/argocd/envs` (`:26`) syncs a directory of hand-written `Application` YAMLs. There is **no `kind: ApplicationSet`** anywhere (`grep` confirms only `kind: Application`). The `devops-aws` selective-deploy spec calls for an ApplicationSet git-directory generator + webhook sync; `app-of-apps.yaml:17` sets `argocd.argoproj.io/hook: PostSync` (a sync-hook annotation) on the root app, which is not how webhook-driven sync is configured.
**Impact (prod):** Adding a service = hand-authoring 2 more YAMLs (staging+prod) instead of a generator; drift between the documented ApplicationSet model and the actual app-of-apps. The misplaced `hook: PostSync` annotation does nothing useful on a parent Application.
**Root cause:** ApplicationSet intended, hand-rolled apps shipped.
**Recommended fix:** Replace the per-env Application files with an ApplicationSet (git-directory generator over `infra/{helm,k8s}/<svc>` × env overlays); configure ArgoCD webhook on the repo. Remove the stray `hook: PostSync`.
**Priority:** P2 | **Tenant impact:** N/A | **Detection:** manual when onboarding a new service.

### M6 — No SBOM / provenance attestation despite cosign signing; supply-chain chain is half-built
**Severity:** Medium | **Category:** Supply-chain security
**Evidence:** `main.yml:87-95` installs cosign and `cosign sign --yes` the digest (keyless OIDC — good). But there is **no `cosign attest` with an SBOM** (no `syft`/`trivy sbom` generation), **no SLSA provenance**, and **no admission-side verification** (no Kyverno/cosign policy controller in any manifest) that the cluster only runs signed images. Signing without cluster-side verification provides no runtime guarantee.
**Impact (prod):** An unsigned/tampered image could still be deployed because nothing rejects unsigned images at admission. The signature is produced but never checked. No SBOM for vuln-triage of deployed images.
**Root cause:** Signing step added; attestation + verification half (per `supply-chain-security`) not wired.
**Recommended fix:** Add SBOM generation + `cosign attest`; add a cluster admission policy (Kyverno/sigstore policy-controller) that verifies the keyless signature + provenance for the four ECR repos.
**Priority:** P2 | **Tenant impact:** multi-tenant (a poisoned image is cross-tenant) | **Detection:** none today — that's the gap.

---

## LOW findings

### L1 — `continue-on-error` "bootstrap-only" escape hatches remain in the policy gate path
**Severity:** Low | **Category:** Gate durability
**Evidence:** `infra.yml:185` `continue-on-error: true` on the dev plan; `:196-205` the OPA step silently exits 0 when `tfplan-dev.json` is absent. Both are heavily commented as "remove post-bootstrap," but as written the plan-level OPA gate is non-blocking until someone remembers to remove them. Combined with H3 (OIDC scope), the plan never produces JSON on PRs anyway.
**Impact:** The plan-level NN-3/4/5 gate is silently bypassable indefinitely. (Static Checkov still runs — partial coverage.)
**Recommended fix:** Track removal with a hard CI assertion that fails once `DEV_TF_STATE_BUCKET` is set; or invert to fail-closed.
**Priority:** P3 | **Tenant impact:** N/A | **Detection:** code review / forgotten TODO.

### L2 — Placeholder account IDs (`<PROD_ACCOUNT_ID>`, `<DEV_ACCOUNT_ID>`) hardcoded in backend bucket names
**Severity:** Low | **Category:** IaC correctness
**Evidence:** `envs/prod/backend.tf:8` `bucket = "brain-tfstate-prod-<PROD_ACCOUNT_ID>"`; `envs/dev/backend.tf:8` similarly. `terraform init` against these literal strings fails until replaced; the assume_role provider blocks are commented out (`envs/prod/bootstrap.tf:21`), so account isolation isn't actually enforced.
**Impact:** `init` fails until a human edits the literal; the documented account-per-env isolation is aspirational (assume_role commented). Low because it's a known fill-in.
**Recommended fix:** Drive bucket name + account from `-backend-config` (CI already does this for dev in `infra.yml:176-179`) and `TF_VAR`/assume_role; remove literal placeholders.
**Priority:** P3 | **Tenant impact:** N/A | **Detection:** `init` error.

### L3 — `web` service has IRSA, ECR, ArgoCD app — but no IRSA module call in dev/staging roots
**Severity:** Low | **Category:** Consistency
**Evidence:** EKS module creates an ECR repo for `web` (`eks/main.tf:234`) and ArgoCD has `web` apps, but `envs/{dev,staging}/main.tf` define `irsa_collector/stream_worker/core` only — no `irsa_web`. If `web` (Next.js) needs AWS access (secrets, S3 for assets) it has no scoped role.
**Impact:** Either `web` needs no AWS (then the ECR repo/ArgoCD app are consistent) or it silently lacks a role. Ambiguous; likely fine for a static front-end but undocumented.
**Recommended fix:** Either add `irsa_web` or add a comment stating `web` requires no IRSA (no AWS API calls).
**Priority:** P3 | **Tenant impact:** N/A | **Detection:** runtime AccessDenied if web later calls AWS.

### L4 — gitleaks gate depends on a paid license secret; absent license may degrade to no-op on forks/org
**Severity:** Low | **Category:** Secret scanning
**Evidence:** `pr.yml:106` `GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}`. gitleaks-action v3 requires a license for organization repos; if the secret is unset the action errors or skips. No fallback (e.g. the OSS `gitleaks` binary run directly, which needs no license).
**Impact:** On an org repo without the license configured, the secret-scan gate may fail-open or hard-error, leaving PRs unscanned for secrets.
**Recommended fix:** Run the `gitleaks` CLI directly (`gitleaks detect --no-banner`) which is license-free, or assert the license secret is present and fail-closed.
**Priority:** P3 | **Tenant impact:** N/A | **Detection:** PR check error / missing scan.

---

## What is genuinely good (for balance)
- IRSA module (`modules/irsa/main.tf:83-94`): `StringEquals` on both `:sub` and `:aud`, never `StringLike` — exemplary NN-3 discipline.
- OIDC short-lived creds throughout; no static AWS keys in any workflow.
- ECR `IMMUTABLE` tags + `scan_on_push` + KMS encryption + 7-day untagged lifecycle (`eks/main.tf:237-275`).
- State bootstrap: versioned, KMS-encrypted, public-access-blocked S3 + KMS rotation + noncurrent expiry (`bootstrap/main.tf:99-155`).
- RDS: `backup_retention=35`, `skip_final_snapshot=false`, `deletion_protection` true in prod, PITR, performance insights with CMK (`modules/rds/main.tf:137-154`).
- EKS: secrets envelope-encrypted with CMK, private endpoint default, full control-plane audit logging (`modules/eks/main.tf:96-106`).
- Custom Checkov + OPA/Conftest policies for S3 prefix least-priv, IRSA no-wildcard, S3 object-lock (`policy/checkov/`, `.github/policy/`).

---

## Verdict
The IaC *security primitives* are strong and clearly authored by someone who knows AWS least-privilege — OIDC scoping, IRSA `StringEquals`, KMS-everywhere, immutable ECR, encrypted/protected RDS. **But the CI/CD *delivery* path is non-functional and partly fictional.** There are no Dockerfiles (C1), no app Helm charts or `infra/k8s/` tree for ArgoCD to render (C2), inconsistent and mutually-incompatible deploy tooling whose image-bump `sed` matches nothing (C3), and an "auto-rollback" that is an `echo` banner over an actionless alarm (C4). Prod has no compute infrastructure at all (H1), the build job assumes an ECR push role Terraform never creates (H2), the OIDC trust can't be assumed on PRs where the plan gate runs (H3), Checkov silently runs only 16 checks (H4), the staging digest-bump is dead code (H5), and the AI-eval gate is a TODO stub (H7). This pipeline cannot, as committed, build or deploy a single service. It is a well-decorated scaffold, not a working delivery system. **Domain status: FAIL** — the deploy path must be made real (Dockerfiles + one consistent manifest tooling + a verified push role + wired rollback) before any "deploy from day one" claim holds.
