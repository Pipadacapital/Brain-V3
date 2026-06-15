# Persona Review — Sprint-0 Over-Engineering Skeptic

| Field | Value |
|-------|-------|
| **req_id** | `chore-platform-foundations-sprint0` |
| **Persona** | Sprint-0 Over-Engineering Skeptic |
| **Stage** | 1 — Stress-Test |
| **Reviewed at** | 2026-06-15T11:30:00Z |
| **Decision** | PASS (with concrete deferral candidates) |
| **Tier** | `:sonnet` |

---

## Lens: The 2-Week Cap Is Sacred

My single question for every deliverable: **does this map to one of the 10 binary Sprint-0 exit criteria, or is it M1+ work smuggled into Sprint 0?**

Doc 12 is explicit: *"anything not above is deferred to M1."* A Sprint-0 that silently expands to 3–4 weeks destroys the M3 design-partner timeline (Month 3) and the M4–5 first-paying-customer target. Every extra 0.5ed of gold-plating costs a real week on the critical path.

The total effort estimate in doc 12 Workstreams A–H is **~26–28 engineer-days** across 5 roles (P, B1, B2, D1, D2). With 5 engineers in parallel, the theoretical minimum is 5–6 days (~1 week). The realistic number, given IaC blockers and integration friction, is 2 weeks — exactly the cap. There is **zero slack** for scope that does not directly serve an exit criterion.

---

## Deliverable-by-Deliverable Assessment

### PART 1 — Development Standards

| Deliverable | Exit criterion served | My call | Rationale |
|-------------|----------------------|---------|-----------|
| Turborepo + pnpm monorepo skeleton | EC1 (`pnpm i && turbo build` green) | REQUIRED | Non-negotiable. |
| Import-boundary lint | EC1 (boundary enforcement) | REQUIRED | Locked in Workstream A. |
| `tsconfig.base`, ESLint, Prettier | EC1 (build gate) | REQUIRED | Prerequisite for CI. |
| Money-minor-units lint | Supports I-S07 + PR gate quality | REQUIRED | 0.5ed; prevents a class of bugs from day one; keep. |
| Husky, lint-staged, Commitlint, Conventional Commits | None directly | **DEFER** | See Concern 1 below. |
| Vitest scaffolding | EC2/5/9 (CI tests need a runner) | REQUIRED | The test runner is needed for the exit-criterion CI tests. |
| **Playwright E2E scaffolding** | None | **DEFER** | See Concern 2 below. |
| Contract-testing framework (Pact stubs + buf-breaking) | EC4 (breaking change fails CI) | REQUIRED | Directly maps. |
| Coding guidelines / naming conventions doc | None | **DEFER** | A reference doc does not block any exit criterion. M1 Week 1 work. |
| Error-handling standards doc | None | **DEFER** | Same as above. |

### PART 2 — CI/CD Foundation

| Deliverable | Exit criterion served | My call | Rationale |
|-------------|----------------------|---------|-----------|
| Validation pipeline (lint, typecheck, unit, contract, schema-compat) | EC1/4/5 | REQUIRED | Core gate. |
| Build pipeline (`turbo --affected`) | EC8 (only affected deployables build) | REQUIRED | Directly maps. |
| Security pipeline (dependency scan, secret scan, vulnerability scan) | EC6 (secrets hygiene) + I-S09 | REQUIRED | Pre-commit gitleaks + TruffleHog + CI Trivy are a 1ed task that protects a P0 invariant. Keep. |
| Infrastructure pipeline (terraform fmt, validate, plan) | EC10 (Terraform-managed) | REQUIRED | Keep as `plan`-only gate (see Concern 3). |
| Branch protection (required checks, review requirements) | EC1 support | REQUIRED | 0.5ed. Keep. |
| ArgoCD app-of-apps + staging auto-deploy | EC8 (staging auto-deploys) | REQUIRED | Directly maps. |
| Prod promote + rollback + flag-off drill | EC8 (prod promote + rollback verified) | REQUIRED | EC8 is explicit — rollback + flag-off must be verified. |

### PART 3 — AWS Foundation

| Deliverable | Exit criterion served | My call | Rationale |
|-------------|----------------------|---------|-----------|
| Terraform state bucket + VPC/networking | EC10 (3 envs provisioned) | REQUIRED | Prerequisite for everything. |
| EKS + Karpenter + ArgoCD | EC8/EC7 | REQUIRED | ArgoCD is the deploy mechanism; OTel collector needs a cluster. |
| RDS Postgres (Multi-AZ, PITR) — dev | EC5 (RLS test runs against a real DB) | REQUIRED | Dev environment. |
| ElastiCache Redis — dev | Implicit (core service dependency) | REQUIRED | Core service needs it from M1 Day 1; cheap to provision now. |
| S3 Bronze/Iceberg + Glue catalog — dev | EC2/3 | REQUIRED | Non-negotiable for the data spine. |
| IAM/IRSA least-privilege roles per workload | EC6 (secrets via IRSA) | REQUIRED | Directly maps. |
| KMS CMK root + Secrets Manager + secret-injection pattern | EC6 | REQUIRED | Directly maps. |
| **Authentik on EKS — Sprint-0 operational** | **None** | **DEFER** | See Concern 4 below — highest-severity finding. |
| dev/staging/prod env split (Terraform declared) | EC10 | REQUIRED | But see Concern 3 on apply scope. |
| CloudWatch alarms + dashboards | Not in any exit criterion | **SCOPE-REDUCE** | See Concern 5 below. |

### PART 4 — Data Platform Foundation

| Deliverable | Exit criterion served | My call | Rationale |
|-------------|----------------------|---------|-----------|
| Redpanda Cloud cluster + topic IaC | EC2 (hello-world event to Redpanda) | REQUIRED | Directly maps. |
| Iceberg Bronze table format + partition spec | EC2/3 | REQUIRED | Directly maps. |
| Apicurio FULL_TRANSITIVE wiring | EC4 (schema-compat gate in CI) | REQUIRED | Without it, EC4 is incomplete. |
| StarRocks cluster + external Iceberg catalog | EC3 (StarRocks queries Bronze) | REQUIRED | Directly maps. |
| StarRocks row policies (brand isolation) | EC5 (isolation negative-test) | REQUIRED | The CTO Advisor correctly called this out in C2. Exit criterion 5 must cover StarRocks, not just Postgres. |
| Parity-oracle test scaffold (trivial fixture) | EC9 | REQUIRED | Directly maps. |
| Hello-world event flow (stub pixel) | EC2 | REQUIRED | A stub POST-to-collector is sufficient; no production pixel. |
| **dbt project structure + environments + testing + deployment** | **EC3 only (minimally)** | **SCOPE-REDUCE** | See Concern 6 below. |
| **Data-quality FRAMEWORK** | **None in Sprint 0** | **DEFER MOST** | See Concern 7 below. |
| **LiteLLM gateway deploy** | **None** | **DEFER** | See Concern 8 below. |
| **Full Grafana Cloud observability stack** | **EC7** | **SCOPE-REDUCE** | See Concern 9 below. |
| **Identity review-queue** | **None** | **DEFER** | Not in Sprint 0 scope at all; this is M2 work per doc 10 §6. |
| **9-sub-score confidence engine** | **None** | **DEFER** | Not in Sprint 0; no detectors exist until M4. |
| OTel + structured logging + correlation ID | EC7 | REQUIRED | One trace + log with correlation ID in Grafana is EC7. |
| SLO alert on synthetic breach | EC7 | REQUIRED | EC7 is explicit. |

---

## Concrete Deferral Table

| Item | Current Sprint-0 scope? | Defer to | Exit criterion blocked by deferral? | Effort saved |
|------|------------------------|----------|-------------------------------------|--------------|
| **Authentik on EKS (operational)** | Yes (Workstream D implicitly; STACK.md ADR-006 binding) | M1 Day 1 | No — no Sprint-0 exit criterion requires a working auth flow | 1.5–2ed |
| **LiteLLM gateway deploy** | Yes (Workstream E explicitly, 0.5ed) | M3 | No — ModelAdapter has zero callers until M4/NLQ | 0.5ed |
| **Staging + prod full `terraform apply`** | Implied by requirement ("provisioned") | M1 (apply); Sprint 0 = plan-passes-clean | Depends on EC10 interpretation — see Concern 3 | 0.5–1ed AWS spend avoidance |
| **Full dbt test harness + deployment pipeline** | Yes (requirement lists "testing + deployment") | M1 | No — EC3 only needs StarRocks to query Bronze; dbt is not in the data path for EC3 | 1ed |
| **Operational DQ pipelines** | Yes (requirement lists DQ framework) | M1 | No — DQ runs on real data; Sprint 0 has no real data | 0.5–1ed |
| **Production-grade brain.js pixel** | Implied by "Pixel → Collector" in Part 4 | M1 | No — EC2 requires a stub event in CI, not a production pixel SDK | 1–1.5ed |
| **Husky + Commitlint + Conventional Commits** | Yes (Part 1) | M1 Week 1 | No — no exit criterion validates commit message format | 0.5ed |
| **Playwright E2E scaffolding** | Yes (Part 1) | M1 Week 1 | No — no Sprint-0 exit criterion requires E2E tests | 0.5ed |
| **Coding guidelines + naming conventions + error-handling standards docs** | Yes (Part 1) | M1 Week 1 | No — docs do not gate any exit criterion | 0.25ed |
| **CloudWatch alarms + dashboards (base infra)** | Yes (Part 3) | M1 | No — EC7 is satisfied by Grafana Cloud + OTel; CloudWatch is redundant at this scale | 0.5ed |
| **Identity review-queue** | Not in requirement text, but Part 4 implies identity framework | M2 | No | 0–1ed |
| **9-sub-score confidence engine** | Not explicit in requirement, but implied by "data-quality framework" | M4 | No | N/A |

**Total deferrable effort: ~7–9 engineer-days.** On a 5-person team this is 1.5–2 additional sprint-days of buffer, or equivalently ~one extra sprint-day per engineer — which is exactly the slack the 2-week cap needs to absorb integration surprises.

---

## Concrete Concerns

### Concern 1 (MEDIUM) — Husky + Commitlint + Conventional Commits are Sprint-0 distractors

**Risk:** These tools take 0.5ed to wire but require every team member to configure their local Git hooks. In the first sprint, the team is standing up infrastructure and will encounter hook failures, bypass attempts, and cross-OS tooling friction (Windows WSL vs macOS). None of the 10 exit criteria validate commit message format. Git hooks that fire on every commit are a daily irritant when the team is in "move fast" mode, and a pre-commit hook that blocks a hotfix during infra wiring is a concrete productivity drag.

**Evidence:** Doc 12 §Final review board explicitly states: *"if a practice doesn't materially raise quality or cut risk, it's not in this model."* Commit-message linting raises neither quality nor risk in Sprint 0 — no exit criterion mentions it, no invariant (I-S01 through I-ST05) depends on it. The rejected practices list includes "sign-off chains beyond CODEOWNERS" and "mandatory story-point estimation rituals" for exactly this reason.

**Severity:** MEDIUM (scope creep, not a functional risk).

**Recommendation:** Set up Commitlint + Conventional Commits in M1 Week 1 as a 30-minute task after the team has shipped their first M1 feature. Keep `gitleaks` pre-commit (that one protects I-S09 and is 5 minutes to configure). The distinction: security hooks stay, ceremony hooks defer.

---

### Concern 2 (MEDIUM) — Playwright E2E scaffolding in Sprint 0 has zero ROI

**Risk:** Playwright requires a running frontend (Next.js web). There is no running frontend in Sprint 0 — there is no business feature, no UI, nothing to test end-to-end. Setting up Playwright scaffolding means configuring a test runner against a hello-world page that does not exist yet. The scaffold will be stale the moment M1 builds the first real page, and whoever sets it up in Sprint 0 will rewrite it in M1 anyway.

**Evidence:** The Sprint-0 exit criteria contain no E2E test requirement. Doc 12 §5 (Testing strategy) lists E2E as "before release" — not before M1. The only test frameworks needed in Sprint 0 are Vitest (unit + integration via Testcontainers) and Pact/buf-breaking (contract tests). Both serve exit criteria directly.

**Severity:** MEDIUM (wasted effort, not a functional risk).

**Recommendation:** Remove Playwright from the Sprint-0 workstream entirely. Add it to M1 Week 2 when the web shell exists and there is a real page to test against.

---

### Concern 3 (HIGH) — "Staging + prod provisioned" in exit criterion 10 must be clarified as plan-passes, not full apply

**Risk:** This is the highest-cost ambiguity in the entire requirement. "3 environments provisioned via Terraform" (EC10) could mean: (a) `terraform apply` run to completion in all three environments (dev + staging + prod), or (b) `terraform plan` passes cleanly in all three, with dev applied and staging/prod declared-but-not-applied. If the builder interprets (a), they will provision:

- 3x EKS clusters (or 3 namespaced environments on 1 cluster — but the requirement says "account isolation strategy")
- 3x RDS Multi-AZ instances
- 3x Redpanda Cloud clusters
- 3x StarRocks clusters
- 3x Authentik + LiteLLM deployments

At India AWS pricing, a full-apply to staging + prod means approximately $800–1,500/month of idle AWS spend from Day 1, on infrastructure that will not be used until M1 (staging) and M4+ (prod). The requirement's own non-goals state: "No production deployments — staging + prod provisioned but unused in Phase 1."

**Evidence:** STACK.md ADR-010 states *"dev/staging/prod on separate AWS accounts"* — if this is taken literally, three AWS accounts must be created, VPCs provisioned, EKS clusters stood up, and IAM bootstrapped in three separate accounts within 2 weeks. This is 6–8ed of IaC work for one Platform engineer, consuming the entire IaC track. It is also entirely wasted spend on staging/prod until M1.

The CTO Advisor's Finding 3 flagged this concern but left it as a clarification item. I am escalating it to a concrete recommendation: the Architect must define "provisioned" operationally before the builder touches Terraform.

**Severity:** HIGH (scope + cost, could break the 2-week cap on its own).

**Recommendation:** Define EC10 operationally as:
- **dev:** `terraform apply` clean — all resources running.
- **staging:** `terraform plan` passes with zero errors; state file exists; `terraform apply` is one command away. Apply deferred to M1 Week 1 when the first feature is ready to deploy.
- **prod:** Terraform workspace/account created; `terraform plan` passes; apply deferred to M4 (first prod-bound deployment). No AWS spend until then.

This interpretation satisfies "3 environments provisioned via Terraform" (the IaC code is written and validated for all three) without triggering idle spend or consuming the IaC track's entire Sprint-0 budget on environment multiplexing.

---

### Concern 4 (HIGH) — Authentik on EKS operational in Sprint 0 is M1 work smuggled in

**Risk:** Self-hosted Authentik on EKS (ADR-006) is a real Sprint-0 IaC dependency in STACK.md ("IdentityAdapter (self-hosted Authentik on EKS)"), but **no Sprint-0 exit criterion requires a working authentication flow**. The 10 exit criteria test:
- RLS isolation (no auth needed — the isolation test uses direct DB connections with the test app role, not HTTP auth)
- KMS/IRSA (service-to-service, not Authentik)
- Grafana Cloud (Grafana Cloud's own auth, not Authentik)
- ArgoCD (ArgoCD's own auth, not Authentik)

Authentik becomes a hard dependency in M1 when the web shell and BFF (`frontend-api`) need OIDC login. Before that, it is a Kubernetes deployment with its own Postgres, Redis, media volume, and SMTP config — a non-trivial 1.5–2ed operational task that will consume a Platform engineer's time during the most critical IaC phase.

**Evidence:** The CTO Advisor's Finding 1 flagged this as a "Sprint-0 scope risk" and recommended the Architect confirm whether Authentik needs to be operational (vs merely deployed) for any Sprint-0 exit criterion. Having read all 10 exit criteria, I confirm: it does not. Not one exit criterion touches the OIDC/SAML flow or the 4-role permission model. The isolation negative-test (EC5) tests Postgres RLS, not Authentik JWTs.

**Severity:** HIGH (blocks Platform track for 1.5–2ed; can cascade to delay data platform workstream if EKS provisioning is crowded).

**Recommendation:** Defer Authentik on EKS to M1 Day 1. In Sprint 0, create the Authentik Helm chart values file and the Kubernetes namespace declaration in the IaC repo (30 minutes), but do not apply. The EKS cluster and namespace structure must exist (required for Workstream D), but the Authentik pod should not be running. The first person who needs to log in to the web shell (M1) can trigger the apply then.

---

### Concern 5 (LOW) — CloudWatch alarms + dashboards are redundant with Grafana Cloud in Sprint 0

**Risk:** The requirement asks for "CloudWatch alarms + dashboards" as part of the AWS Foundation (Part 3), while simultaneously requiring Grafana Cloud + OTel as the observability stack (Part 4, ADR-009). These two observability systems serve overlapping functions. In Sprint 0, setting up CloudWatch alarms means writing Terraform for CloudWatch metric filters, alarm resources, SNS topics, and dashboard JSON — for a system that is not yet producing meaningful traffic.

EC7 requires: *"Trace + structured log with correlation ID visible in Grafana; SLO alert fires on synthetic breach."* This is 100% Grafana Cloud. CloudWatch is not mentioned in any exit criterion. Doc 10 §5 / ADR-009 explicitly chose Grafana Cloud (managed-first) over self-hosted Mimir/Loki/Tempo. CloudWatch is the AWS-native fallback monitoring layer, not the primary observability plane.

**Severity:** LOW (0.5ed waste, not a functional risk).

**Recommendation:** In Sprint 0, provision only the CloudWatch log groups and a single composite alarm for "EKS cluster unhealthy" (2-line Terraform). This satisfies basic AWS infrastructure hygiene without duplicating the Grafana Cloud observability work. Full CloudWatch dashboard build is M1+ if the team decides they want it alongside Grafana Cloud.

---

### Concern 6 (MEDIUM) — dbt scope in Sprint 0 exceeds what EC3 actually requires

**Risk:** The requirement includes "dbt (project structure, environments, testing, deployment)" in Part 4. The CTO Advisor flagged this as C3 with a "LOW concern" label — I am re-labeling it MEDIUM because the word "deployment" in that list implies a CI-wired dbt pipeline with run + test + docs generate, which is 1–1.5ed of work against a cluster with no real tables yet.

EC3 requires: *"StarRocks queries a Bronze test table via the Iceberg catalog."* This test does not require dbt at all. The Bronze table is Iceberg on S3+Glue, queried via StarRocks's external catalog. dbt is the Silver/Gold transformation layer — M1/M2 work. In Sprint 0, the StarRocks cluster only needs to demonstrate it can read from the Iceberg external catalog. That is a SQL query run manually or in a Testcontainers test — no dbt involved.

**Evidence:** Workstream E in doc 12 lists "StarRocks cluster + external Iceberg catalog" as the Sprint-0 task for EC3. There is no dbt line item in Workstream E. The dbt project appears in the requirement text but not in the Sprint-0 workstream breakdown — suggesting it crept in from the general architecture description, not from a deliberate Sprint-0 decision.

**Severity:** MEDIUM (1ed scope creep that competes with the IaC critical path).

**Recommendation:** Sprint-0 dbt scope = `dbt init` (project skeleton) + profile config for dev + one empty model that compiles without errors + CI invocation stub that runs `dbt compile` (not `dbt run`). Everything else — Silver/Gold model build, dbt tests, dbt docs, dbt deployment pipeline — defers to M1 where real Bronze data exists to transform.

---

### Concern 7 (LOW) — Data-quality framework in Sprint 0 is schema declarations, not operational pipelines

**Risk:** The requirement describes "Data-quality FRAMEWORK only (freshness, completeness, schema validation, reconciliation — no business rules yet)." The word "framework" is doing a lot of work here. If a builder interprets this as "wire a Grafana DQ dashboard that shows freshness and completeness scores," they will spend 1ed building a dashboard that will show all zeros (because no real data flows in Sprint 0).

A DQ framework in Sprint 0 can only mean: Zod schema declarations for what "fresh" and "complete" mean, empty dbt test stubs that will fail when wired against real data, and the CI invocation stub that runs `dbt test` (which passes trivially against empty models).

**Severity:** LOW (scope ambiguity, not a functional risk — but the Architect must define it precisely).

**Recommendation:** Architect must define DQ framework deliverables as: (a) Zod schemas for DQ metric categories in `packages/contracts`, (b) empty `dbt test` stubs, (c) `dbt test` CI invocation that returns green on an empty model. No operational DQ pipeline, no Grafana DQ panels with live data, no freshness alerting — those are M1 when real data flows.

---

### Concern 8 (MEDIUM) — LiteLLM gateway in Workstream E is confirmed M3 work

**Risk:** Workstream E explicitly lists "LiteLLM gateway deploy (no app use yet) | P | EKS | gateway health green | 0.5ed." The CTO Advisor's Finding 2 correctly identified this as premature. I am adding one additional dimension the Advisor did not note: the LiteLLM gateway is a Kubernetes deployment with its own config, secrets (API keys for Claude/GPT/Gemini), and health probes. Creating the secrets in AWS Secrets Manager for API keys that will not be used until M4 means those secrets must be managed, rotated, and audited from Sprint 0 onward — adding operational overhead with zero value.

**Evidence:** ADR-013 (ModelAdapter) states LiteLLM is the Phase 1 binding, but Phase 1 usage starts at M4 (NLQ/Morning Brief). No Sprint-0 exit criterion mentions the AI gateway. Deferring to M3 (when the first AI-dependent feature is being built) means zero idle EKS resources and zero idle API key management.

**Severity:** MEDIUM (0.5ed + ongoing ops overhead for a feature that is 4 months away).

**Recommendation:** Remove LiteLLM from Workstream E. Add it to M3 sprint planning. The `packages/ai-gateway-client` package stub (a TypeScript interface + a TODO comment) can be committed to the monorepo in Sprint 0 at zero cost — that satisfies the contract-first principle without deploying infrastructure.

---

### Concern 9 (MEDIUM) — "Production-readiness" framing risks a full observability build vs a sprint-0 scaffold

**Risk:** The Stakeholder's output-format request asks for deliverables described "from the perspective of Principal Platform/DevOps/Data/Cloud Architects + Staff Engineer" with "Risks, Recommendations" per section. This framing is correct for the Architect's PLAN document — but it may inadvertently signal to the builder that Sprint-0 observability means a full production observability stack (SLO dashboards for all components, DLQ alerting, freshness breach alerting, parity drift alerting, connector health panels).

EC7 requires: *"Trace + structured log with correlation ID visible in Grafana; SLO alert fires on synthetic breach."* This is a single OTel span + one structured log line + one Grafana alert rule. It is a 1.5ed task (Workstream G). The parity + DQ dashboard skeletons (Workstream G: 0.5ed) are additional Sprint-0 scope, but they render empty — which is fine.

The full observability stack (DLQ growth, freshness breach, parity drift, connector health, materialization lag) only makes sense when real data flows — M1+.

**Severity:** MEDIUM (risk of builder interpreting "production-grade observability" as a 3–4ed task vs the 2ed Workstream G estimate).

**Recommendation:** The Architect's plan must explicitly state: Sprint-0 observability = OTel collector running + one trace + one log + correlation ID in Grafana + one SLO alert on a synthetic metric. All other dashboards (DLQ, freshness, parity drift) are shells only — panels exist but show no data. Full dashboard wiring is M1 when real data flows.

---

## Summary Judgment

The Sprint-0 requirement is structurally sound — the 10 exit criteria are well-defined, binary, and achievable in 2 weeks **if the team defers the 7–9 engineer-days of gold-plating identified above.** None of the deferred items block M1 start. The two highest-risk items are:

1. **Authentik on EKS operational** (HIGH): 1.5–2ed of Platform work that serves no exit criterion; defer to M1 Day 1.
2. **EC10 staging/prod full apply** (HIGH): if interpreted as full `terraform apply` to all three environments, this alone could consume the entire IaC track and generate $800–1,500/month of idle spend; must be clarified as plan-passes for staging/prod before builder touches Terraform.

The remaining concerns (Concern 1–9) are individually small but collectively represent a 1.5–2 week scope expansion that would push Sprint 0 past the 2-week cap without adding a single green exit criterion.

The Architect's plan should include a "Sprint-0 scope contract" section that lists exactly which Workstream tasks are in scope, with explicit deferral notes for the items above. This prevents well-intentioned builders from gold-plating a foundation that is already well-designed.

---

## Journal Stub

```
## 2026-06-15T11:30:00Z — Persona:sprint0-overengineering-skeptic — chore-platform-foundations-sprint0
**Angle:** Right-sizing Sprint-0 deliverables against the 10 binary exit criteria · **Top concern:** Authentik on EKS + staging/prod full-apply together can consume 3–4ed of Platform track with zero exit-criterion payoff · **Severity:** H
```
