# Engineering Advisor — Stage 1 Intake Review

| Field | Value |
|-------|-------|
| **req_id** | `chore-platform-foundations-sprint0` |
| **Stage** | 1 — Intake |
| **Reviewer** | Engineering Advisor (cto-advisor) |
| **Reviewed at** | 2026-06-15T11:09:57Z |
| **Decision** | ADVANCE |
| **Lane** | high_stakes |

---

## 1. Dependency Pre-flight

No prior runs exist (`linked_prior_runs: none`). This is the first requirement in the pipeline. No blocking dependency in `proposed_children[].blocks` to check. Pre-flight: CLEAR.

---

## 2. Lane Validation — Surfaces

The deterministic scan returned `multi_tenancy` as the primary surface. Validated and expanded below. I am ADDING surfaces; I am not removing the scan's result.

| Surface | Scan | My validation | Basis |
|---------|------|---------------|-------|
| `multi_tenancy` | flagged | CONFIRMED | RLS day-one, brand_id on every row/event/key/log, StarRocks row policies, isolation negative-test as a P0 exit criterion. Per TRIGGER-SURFACES.md §Multi-tenancy. |
| `schema_changes` | not flagged | ADDED | This requirement creates the Postgres migrations (including RLS, app-role, audit_log), the Iceberg Bronze table format + partition spec, and the Apicurio FULL_TRANSITIVE schema registry wiring. All three are listed schema-change trigger surfaces in TRIGGER-SURFACES.md. |
| `system_of_record_audit` | not flagged | ADDED | Migration #1 establishes the hash-chained audit_log with no-UPDATE/DELETE grant and the WORM S3 Object Lock anchor path. The Bronze layer's append-only immutability (Iceberg S3+Glue) is the SoR, and its Bronze bucket + Object Lock are provisioned here. INVARIANTS.md I-S06 + I-E02. |
| `secrets_auth_iam` | not flagged | ADDED | KMS CMK set, per-brand DEK envelope path, Secrets Manager, IRSA least-privilege roles per workload, and the secret-injection pattern are all provisioned in Part 3. ADR-007 (SecretsAdapter), ADR-006 (IdentityAdapter). |
| `iac` | not flagged | ADDED | The entire AWS foundation is Terraform-managed: no manual AWS is an explicit constraint. Part 2 (CI) gates on `terraform fmt/validate/plan`; Part 3 provisions dev/staging/prod. A Terraform misconfiguration touching VPC, IAM, or bucket policies has blast radius across all environments. |
| `shared_contract_parity` | not flagged | ADDED | Part 1 + Part 2 establish the contract-first codegen pipeline (Zod → types/OpenAPI/Avro/MCP) and the buf-breaking + Pact stub CI gate. The parity-oracle test scaffold (exit criterion 9) is a direct trigger-surface item under TRIGGER-SURFACES.md §Shared-contract parity. |

**Final trigger surfaces for this requirement:**
`[multi_tenancy, schema_changes, system_of_record_audit, secrets_auth_iam, iac, shared_contract_parity]`

**Lane confirmed:** high_stakes. The scan's conservative call is correct — six surfaces are in play simultaneously.

---

## 3. Sharpened Requirement Fields

### Problem statement (sharpened)
Brain has a frozen, ratified architecture (docs 01–12, 13 ADRs) but zero executable substrate. Every subsequent milestone (M1 thin spine, M3 design partner, M4–5 first paying customer) hard-depends on Sprint 0 delivering: a reproducible, tenant-isolated monorepo; a CI pipeline that enforces isolation, contract parity, and secrets hygiene; Terraform-managed AWS environments; and an operational data-platform spine (Redpanda→Iceberg Bronze→StarRocks) with day-one observability. Without this substrate, no builder can work safely on any feature. The risk of getting Sprint 0 wrong is that every subsequent build inherits a broken foundation.

### Target user (unchanged — confirmed)
Brain engineering team (Founder + data-heavy build team). The deliverable is developer-facing: the paved path all later builders self-serve on.

### Success metric (canonical — from doc 12 §Sprint-0 exit criteria, binary)
All 10 exit criteria from doc 12 ARTIFACT 2 must be green before M1 begins:
1. `pnpm i && turbo build` green; import-boundary lint enforced.
2. Hello-world event flows pixel→collector→Redpanda→Bronze in CI.
3. StarRocks queries a Bronze test table via the Iceberg catalog.
4. Contracts codegen produces types/OpenAPI/Avro/MCP; breaking change fails CI.
5. RLS on; isolation negative-test passes (brand-A→brand-B = 0 rows/403).
6. Secrets via KMS/IRSA; no-PII-log lint active.
7. Trace + structured log with correlation ID in Grafana; SLO alert fires on synthetic breach.
8. CI deploy matrix builds only affected deployables; staging auto-deploys; prod promote + rollback + flag-off verified.
9. Parity-oracle test scaffold runs green on a trivial fixture.
10. dev/staging/prod provisioned via Terraform.

Doc 12 is explicit: these are binary (all must be green), duration cap is 2 weeks, and "no business logic, no attribution, no decision engine."

### Constraints (confirmed)
- Architecture frozen: 3 deployables + web + Argo jobs; 13 ADRs locked; stack is managed-first per STACK.md.
- Phase-1 scope: single-region ap-south-1 only; RegionAdapter seam built but single India binding active.
- Duration cap: 2 weeks (doc 12). A Sprint 0 that expands to 4 weeks is explicitly rejected.
- Multi-tenant by default: brand_id on every row/event/key/log; RLS day-one.
- Security by default: KMS + Secrets Manager + IRSA; no secrets in repo; no public resources unless required.
- Cost-aware: managed services over self-host; single CMK set for Phase 1 (small); Grafana Cloud (managed-first, not self-hosted Mimir/Loki/Tempo per doc 10 §5/§13).

### Non-goals (confirmed and complete)
- No business features, attribution, decision engine, Customer 360, analytics, or UI features.
- No data-quality business rules (enforcement framework only).
- No production deployments (staging + prod provisioned but unused in Phase 1).
- No Phase 2/3+ capabilities: probabilistic identity, MMM, holdouts, Python ML, multi-region, WhatsApp/CAPI adapters, Athena/Trino/Spark.
- No per-brand KMS DEK provisioning in Terraform at this stage (path + CMK root only; per-brand DEK creation is a runtime operation triggered by brand onboarding).

---

## 4. "Make It Less Dumb" Pass

### What can be deleted or deferred without violating exit criteria?

**Finding 1 — Authentik on EKS is a Sprint-0 scope risk.**
The requirement lists "security by default" and "IAM/IRSA least-privilege roles" but does not explicitly call out self-hosted Authentik on EKS as a Sprint-0 deliverable. STACK.md ADR-006 binds Authentik as the IdentityAdapter, and doc 12 Workstream D calls out EKS as a dependency for the cluster — but Authentik's EKS deployment is not listed in the 10 exit criteria. The exit criteria only require KMS/IRSA secrets injection, RLS isolation, and CI gates. Authentik can be scheduled as an early M1 task (before any user-facing auth is needed) rather than a Sprint-0 blocker. Recommend the Architect confirm whether Authentik needs to be operational (rather than merely deployed) for any Sprint-0 exit criterion — if not, it should be deferred to M1 Day 1 to protect the 2-week cap.

**Finding 2 — LiteLLM gateway in Sprint 0 is placeholder work.**
Doc 12 Workstream E calls for "LiteLLM gateway deploy (0.5ed — gateway health green)." The requirement includes this under "Platform foundation." However, no Sprint-0 exit criterion exercises the AI gateway. The ModelAdapter (ADR-013) has zero usage until the NLQ/Morning Brief features (M4+). This 0.5ed task can be deferred to the M3 sprint without any exit criterion risk. It is low-effort but it creates IaC + EKS namespace entries that someone must maintain. Recommend the Architect confirm whether the AI gateway is a Sprint-0 deliverable or an M3 setup task.

**Finding 3 — Staging + prod environments: provision vs configure.**
The requirement says "provisioned but unused." Terraform applying VPC/networking, IAM, and S3 bucket skeletons to staging and prod is correct Sprint-0 scope. However, RDS Multi-AZ, ElastiCache, and the Redpanda Cloud cluster likely need only to be provisioned in dev for Sprint-0 exit criterion 10. Staging and prod environments need their Terraform resources declared and state-bucket-anchored, but the actual `terraform apply` of all resources to staging/prod may be deferred until M1 deployment is needed. Exit criterion 10 says "3 environments provisioned via Terraform" — this likely means apply-clean in dev + plan-passes in staging/prod (not necessarily full apply to staging/prod). The Architect should clarify this with the Stakeholder before the builder executes, to avoid unnecessary AWS spend in Phase 1.

**Finding 4 — "Production-readiness" framing in the output-format request.**
The Stakeholder asks for output "from the perspective of Principal Platform/DevOps/Data/Cloud Architects + Staff Engineer" with "Design Decisions, Folder Structure, Configuration, Terraform Layout, Implementation Steps, Validation Steps, Risks, Recommendations" per section. This is the right framing for the PLAN-phase deliverable the Architect produces. It is not a Sprint-0 scope concern, but the Architect must structure the plan output this way.

**What stays (non-negotiable for Sprint 0):**
- Migration #1: non-owner app role + RLS policy template + audit_log (no UPDATE/DELETE grant). This is INVARIANT I-S01/I-S06 — not deferrable.
- Isolation negative-test in CI. INVARIANT I-S01 + exit criterion 5 — P0 gate.
- Contract codegen + breaking-change CI gate. INVARIANT I-E01 + exit criterion 4 — not deferrable.
- Parity-oracle test scaffold (trivial fixture). INVARIANT I-E03/I-E04 + exit criterion 9.
- KMS CMK root + IRSA + Secrets Manager secret-injection pattern. INVARIANT I-S09 + exit criterion 6.
- Grafana Cloud + OTel + correlation ID. INVARIANT (every span carries brand_id + correlation_id, ADR-009) + exit criterion 7.
- Bronze bucket (Iceberg on S3 + Glue catalog) + Bronze table format + partition spec. INVARIANT I-E02 (immutable SoR) + exit criteria 2/3.

---

## 5. Domain Check Against Product Canon

### Multi-tenancy (INVARIANTS.md I-S01, TRIGGER-SURFACES.md)
The requirement correctly places RLS + isolation negative-test as a P0 exit criterion. The requirement also correctly demands `brand_id` on every row/event/key/log. ONE gap: the requirement does not explicitly call out StarRocks row policies as a Sprint-0 deliverable. Exit criterion 3 (StarRocks queries Bronze via Iceberg catalog) needs StarRocks to have the row-policy framework in place — or at minimum the namespace/user setup that allows it. The Architect must confirm StarRocks row policies are part of the StarRocks cluster setup task, not deferred to M1.

### Audit log (INVARIANTS.md I-S06, THE-MOAT.md)
Migration #1 must include: non-owner app role, no UPDATE/DELETE grant on audit_log, hash-chain write seeded. The requirement references this correctly (doc 12 Workstream F + doc 05 §14). The WORM S3 Object Lock anchor (hourly checkpoint) is a runtime job (Argo), not a Sprint-0 IaC item — this is correct; the S3 bucket with Object Lock enabled is the Sprint-0 item; the checkpoint job ships in M1/M2 with the audit writer.

### Secrets / KMS (INVARIANTS.md I-S09, STACK.md ADR-007)
The requirement correctly specifies KMS + IRSA + Secrets Manager + no-secrets-in-repo. The CMK set for Phase 1 is small (one root CMK, per-brand DEK path). The per-brand DEK is a runtime provisioning event (brand onboarding), not Sprint-0 IaC — this is correct and cost-aware.

### Bronze immutability (INVARIANTS.md I-E02)
The requirement correctly calls out Iceberg Bronze as append-only + 24-month retention. The partition spec and schema evolution policy (additive-optional only; FULL_TRANSITIVE in Apicurio) must be established at table-creation time — not retrofittable. This is a high-risk implementation detail the Data Engineer must get right in Sprint 0; the Architect's plan must explicitly state the initial partition spec (e.g. `brand_id / year / month / day`) and the schema registry FULL_TRANSITIVE compatibility setting.

### Contract-first (INVARIANTS.md I-E01)
The codegen pipeline (Zod → types/OpenAPI/Avro/MCP) and the buf-breaking + Pact stub CI gate are correctly in scope. The Apicurio FULL_TRANSITIVE wiring is a Sprint-0 dependency (Workstream C requires it for the Redpanda topic/schema validation). The CODEOWNERS rule on packages/contracts (consuming-domain owner approval required) must also be established in Sprint 0, not deferred.

### Cost-routing (engineering-discipline + cost-routing-paradigms skills)
This is a pure infrastructure + tooling requirement — no model calls, no effort-tier decisions needed in Sprint 0 itself. The LiteLLM gateway is deferred (Finding 2 above). No cost-routing concern for Sprint 0 beyond the managed-services cost-awareness constraint already in the requirement. The one cost watch item: Grafana Cloud ingestion cost at baseline (structured logs + traces from day one) — the Architect should confirm the Grafana Cloud plan tier is appropriate for a 2-engineer Sprint 0 output volume before committing.

### Observability (STACK.md ADR-009)
The requirement correctly specifies Grafana Cloud + OpenTelemetry (not self-hosted Mimir/Loki/Tempo). This is confirmed by doc 10 §5/§13 managed-first. Every span/log must carry `brand_id` + `correlation_id` from day one.

### Money (INVARIANTS.md I-S07)
No money operations in Sprint 0. The money-lint CI gate (float-money column detector) belongs in the ESLint / lint-staged setup (Part 1 — Development Standards). The requirement lists "money-minor-units lint" implicitly under "coding guidelines." The Architect must make this an explicit deliverable in the monorepo setup, not a future add.

---

## 6. Challenge Findings

### C1 — Sprint-0 scope vs the 2-week cap (MEDIUM concern, not a KILL)
The requirement describes a large surface: 4 parts, 10 exit criteria, 8 workstreams (A–H in doc 12), involving monorepo, CI, AWS, Redpanda, Iceberg, StarRocks, dbt, observability. The doc 12 effort estimates total roughly 25–28 engineer-days across Platform(P), Backend-1(B1), Backend-2(B2), Data-1(D1), Data-2(D2), Founder/FE(F). This fits a 2-week window only if parallelism is high and no workstream is blocked. The key risk: Workstream D (IaC) blocks Workstreams E, F, G, H — the EKS cluster + RDS + S3+Glue must be up before the data platform, security, and observability workstreams can execute. If IaC slips even 2 days, the whole sprint compresses. The Architect must sequence these dependencies explicitly in the plan and identify the critical-path bottleneck.

**Recommendation:** The Architect should produce a day-by-day sequencing for Workstreams A–D (which are blockers), and note that Workstreams E–H can only begin after D-day 3 (at the earliest). Finding 1 and Finding 2 above (Authentik, LiteLLM deferral) would reduce the critical path.

### C2 — StarRocks row policies (LOW concern, but a gap)
The requirement mentions "StarRocks Silver+Gold (analytics serving, low-latency, tenant isolation)" and lists isolation negative-test as exit criterion 5. However, the isolation test as written targets Postgres RLS (brand-A→brand-B = 0 rows/403). StarRocks row policies (TRIGGER-SURFACES.md §Multi-tenancy) are a separate enforcement point — if the StarRocks cluster is provisioned but row policies are not configured, isolation at the analytics layer is unprotected. The Architect must include StarRocks row policy setup as an explicit deliverable in Workstream E.

### C3 — dbt project structure in Sprint 0 (LOW concern, potentially over-scoped)
The requirement includes "dbt (project structure, environments, testing, deployment)" in Part 4. Doc 12 does not list a dbt workstream in Sprint 0 — dbt transforms (Silver/Gold materialization) are M1/M2 work. Sprint 0 only needs the StarRocks cluster + Iceberg external catalog operational (exit criterion 3). The dbt project structure is a 0.5–1ed task that can happen in Sprint 0 as a scaffold (project init + environment config + empty model directory), but a full dbt test harness and deployment pipeline are M1 work. The Architect should scope dbt in Sprint 0 to: project init, profile config for dev/staging/prod, one empty model that builds, CI invocation stub. Anything more is over-scoped.

### C4 — "Data-quality FRAMEWORK" scope ambiguity (LOW concern)
The requirement says "Data-quality FRAMEWORK only (freshness, completeness, schema validation, reconciliation — no business rules yet)." In Sprint 0, a data-quality framework means: the DQ metric categories exist in the dbt project (as empty model stubs or Zod schema declarations), and the CI invocation for DQ checks is wired. It does NOT mean operational DQ pipelines (those run on real data in M1+). The Architect should define DQ framework deliverables precisely: schema declarations + empty test stubs + CI invocation (not running DQ checks in Sprint 0, since there is no real data yet).

### C5 — Pixel (brain.js) scope in Sprint 0
Exit criterion 2 requires "hello-world event flows pixel→collector→Redpanda→Bronze in CI." This means a stub pixel (a simple JS snippet posting a synthetic event to the collector endpoint) is sufficient for Sprint 0 — not a production-grade `brain.js` with CNAME routing and first-party cookie setting. The production pixel is M1 work. The Architect should confirm this interpretation so the builder does not attempt to build the full Brain Pixel in Sprint 0.

---

## 7. Recommended Build-Track Decomposition

The following tracks map to the doc 12 Workstreams A–H and are recommended for the Architect's parallel fan-out plan. These are recommendations; the Architect owns the binding plan.

### Track 1 — Monorepo + Dev Standards + Contracts
**Owner agent:** `backend-developer`
**Workstreams:** A (repo setup), C (contracts foundation)
**Contents:**
- Turborepo + pnpm monorepo; apps/* + packages/* skeleton.
- Import-boundary lint (apps/ never imports apps/; metric-engine import rule).
- CODEOWNERS + PR template + branch protection.
- tsconfig.base, ESLint/Prettier, Husky, lint-staged, Commitlint, Conventional Commits.
- Money-minor-units lint (float-money column detector — must be explicit).
- Vitest + Playwright scaffolding; Testcontainers harness.
- packages/contracts Zod → types/OpenAPI/Avro/MCP codegen.
- buf-breaking + Pact stub CI gate.
- Apicurio registry wiring (FULL_TRANSITIVE) — coordinates with Track 3.
**Why separable:** pure developer-tooling track; no AWS dependency; parallelizable from day 1.

### Track 2 — CI/CD + GitHub Actions
**Owner agent:** `platform-devops`
**Workstreams:** H (CI/CD foundation)
**Contents:**
- GitHub Actions pipelines: Validation (lint, typecheck, unit, contract validation, schema-compat) on every PR.
- Build (turbo --affected, verify dependency graph).
- Security (dependency scan, secret scan with gitleaks/TruffleHog, vulnerability scan with Trivy).
- Infrastructure (terraform fmt, validate, plan).
- Branch protection (required checks, review/merge requirements).
- ArgoCD app-of-apps; staging auto-deploy; prod manual promote.
- Rollback (ArgoCD revert) + feature-flag-off drill.
**Dependencies:** Track 1 (repo skeleton must exist for CI to run against); Track 3 (Terraform state bucket must exist for `terraform plan` gate).
**Why separable:** GitHub Actions workflows are repo files; they can be written in parallel with AWS provisioning and merged once AWS state is ready.

### Track 3 — AWS Foundation + IaC
**Owner agent:** `platform-devops`
**Workstreams:** D (infrastructure foundation), F (security foundation — IAM/KMS/Secrets)
**Contents:**
- Terraform state bucket in ap-south-1.
- VPC, private/public subnets, NAT strategy, security groups.
- EKS cluster + Karpenter + ArgoCD.
- RDS Postgres (Multi-AZ, PITR), ElastiCache Redis — dev environment; declared in staging/prod.
- IAM/IRSA least-privilege roles per workload (collector, stream-worker, core, jobs).
- KMS CMK root + per-brand DEK envelope path; Secrets Manager; secret-injection pattern.
- S3 buckets: Bronze/Iceberg storage, Terraform state, WORM Object Lock enabled on audit bucket.
- CloudWatch alarms + dashboards (base infra only; product SLOs come from Grafana Cloud).
- dev/staging/prod environment split via Terraform workspaces or account-per-env.
**Critical path note:** this track is the blocker for Tracks 4 and 5. Prioritize Terraform state + VPC + EKS as day-1 work.

### Track 4 — Data Platform Spine
**Owner agent:** `data-engineer`
**Workstreams:** E (platform foundation — Redpanda/Iceberg/StarRocks), B (testcontainers/parity scaffold)
**Contents:**
- Redpanda Cloud cluster + topic IaC (topic naming: {env}.{domain}.{event}.v{n}; retention/replay strategy).
- Iceberg (S3+Glue) catalog + Bronze table format + partition spec (brand_id/year/month/day).
- Schema registry (Apicurio FULL_TRANSITIVE) wiring — coordinates with Track 1.
- StarRocks cluster + external Iceberg catalog; StarRocks row policies for brand isolation.
- dbt project init (profile config for dev/staging/prod; one empty model; CI invocation stub — Sprint 0 scope only).
- Data-quality framework: schema declarations + empty test stubs + CI invocation stub.
- Parity-oracle test scaffold (green on trivial fixture — exit criterion 9).
- Hello-world event flow: stub pixel → collector → Redpanda → Bronze (exit criterion 2).
- Testcontainers + Vitest harness for integration tests.
**Dependencies:** Track 3 (AWS: EKS, S3+Glue, Redpanda Cloud cluster provisioned).

### Track 5 — Observability + Security Foundation
**Owner agent:** `platform-devops` (observability infra); `data-engineer` + `backend-developer` (SDK wiring)
**Workstreams:** G (observability), F (security — RLS + isolation test)
**Contents:**
- Grafana Cloud + OTel collector; structured logging lib (packages/observability).
- SLO dashboards + burn alerts (collector/product).
- Parity + DQ dashboard skeletons.
- Migration #1: non-owner app role + RLS policy template + hash-chained audit_log (no UPDATE/DELETE grant) + brand_keyring table.
- Isolation negative-test harness in CI (brand-A→brand-B = 0 rows/403 — exit criterion 5).
- no-PII-in-logs lint + PII-hash helper (packages/identity-core stub).
- gitleaks + TruffleHog pre-commit hooks (coordinates with Track 2 CI setup).
**Dependencies:** Track 3 (AWS: RDS live, EKS for OTel collector deployment).

---

## 8. Stress-Test Personas

Two personas are required for high_stakes lane. Each must surface at minimum one concrete concern.

### Persona 1 — "The Sprint-0 Over-Engineering Skeptic" (`:sonnet`)
**Angle:** This persona pressure-tests whether the Sprint-0 scope is right-sized for 2 weeks. They challenge every item that is not directly required by one of the 10 binary exit criteria. They ask: "Which exit criterion does this serve? If none, why is it in Sprint 0?" They are sensitive to scope creep that kills the 2-week cap and pushes the design-partner timeline (M3 target). They will surface concrete concerns about: Authentik on EKS (Finding 1), LiteLLM gateway (Finding 2), full dbt test harness (C3), operational DQ pipelines (C4), production brain.js pixel (C5), and the staging+prod full-apply question (Finding 3). They will also ask whether dev-standards work (Commitlint, Playwright scaffolding, Conventional Commits) is a Sprint-0 gate or can be set up asynchronously in M1 week 1.

**Required to surface:** at least one concrete item they believe should be deferred from Sprint 0, with the rationale that it does not appear in the 10 exit criteria and its absence does not block M1 start.

### Persona 2 — "The Isolation + Secrets Hardness Skeptic" (`:sonnet`)
**Angle:** This persona pressure-tests whether the multi-tenancy and secrets/IAM design decisions are hardened enough to be trusted at the foundation level, given that Sprint 0 sets patterns that every subsequent PR inherits. They are not checking whether isolation is mentioned — they are checking whether the implementation plan makes it structurally impossible to break. They challenge: whether the isolation negative-test covers StarRocks row policies (not just Postgres RLS), whether the no-PII-in-logs lint is integrated at the OTel layer (not just the app logger), whether the IRSA role bindings are scoped to namespace+service-account (not just cluster-level), whether the Apicurio FULL_TRANSITIVE setting is enforced in the CI gate (not just configured in the registry), and whether the S3 Bronze bucket's Object Lock and per-brand prefix are both enforced at bucket creation (not added later). They will also ask: what happens if a developer forgets to set the tenant-context GUC before a query in a new module — does the RLS policy return nothing or throw? (The answer should be: return nothing by design, and the middleware must set it before every query.)

**Required to surface:** at least one gap in the isolation or secrets hardening that the builders' implementation steps must explicitly address, citing the specific INVARIANT at risk.

---

## 9. Decision

**ADVANCE** to Architect (after persona synthesis).

This requirement is sound. The problem statement is real (no executable substrate = no safe build), the target users are clear (the engineering team), the success metric is binary and already canonically defined in doc 12, and the constraints are fully aligned with the Product Canon and frozen ADRs. No INVARIANT is violated; no moat component is weakened; no frozen ADR is re-opened.

The 5 challenge findings (C1–C5) and 4 "make it less dumb" findings are directional clarifications for the Architect's plan, not blockers at intake. The 2 personas will stress-test scope sizing and isolation hardness. ADVANCE is the correct decision.

No escalation trigger is met. The requirement is within the Engineering Advisor's authority to advance.

---

## 10. Intake DoD Checklist

- [x] Review filled (no TBD).
- [x] Lane confirmed: high_stakes; trigger surfaces validated and expanded (6 surfaces).
- [x] Sharpened requirement fields: problem, user, success metric, constraints, non-goals.
- [x] "Make it less dumb" pass: 4 findings (Authentik deferral candidate, LiteLLM deferral candidate, staging/prod apply scope, output-format framing).
- [x] Domain check vs Product Canon: multi-tenancy, audit, secrets, Bronze immutability, contract-first, cost-routing, observability, money-lint all verified.
- [x] Challenge findings: 5 findings (Sprint-0 cap risk, StarRocks row policies gap, dbt scope, DQ framework scope, pixel scope).
- [x] Recommended build-track decomposition: 5 tracks with owner agents.
- [x] 2 personas named with angles: Sprint-0 Over-Engineering Skeptic (scope sizing), Isolation + Secrets Hardness Skeptic (multi-tenancy + IAM hardness).
- [x] Decision: ADVANCE.
- [x] Journal and audit-log entries: pending (written next).
- [x] State declared in HANDOFF (orchestrator writes active.json).

---

## Persona Synthesis & Final Intake Decision — Architect Brief

**Synthesized at:** 2026-06-15T11:40:00Z
**Synthesis by:** Engineering Advisor (cto-advisor) — Stage 1 synthesis pass
**Personas synthesized:** 02a (Sprint-0 Over-Engineering Skeptic, :sonnet) + 02b (Isolation & Secrets Hardness Skeptic, :sonnet)
**Final decision:** ADVANCE to Architect

---

### A. SCOPE RULINGS — Over-Engineering Skeptic Synthesis

The over-engineering persona surfaced 9 concerns across the 4-part requirement. Below are the Architect's rulings on each deferral candidate, with a one-line reason mapped to the Sprint-0 exit criterion it does or does not serve.

| Deferral Candidate | Ruling | Rationale mapped to exit criterion |
|---|---|---|
| **Authentik on EKS (operational)** | **DEFER to M1 Day 1** | No Sprint-0 exit criterion requires a working OIDC/SAML flow. EC5 tests Postgres RLS (direct DB connection, not HTTP auth); EC6 tests KMS/IRSA (service-to-service, not Authentik). Sprint-0 deliverable = Helm chart values + namespace declaration in IaC only; do not apply. |
| **LiteLLM gateway deploy** | **DEFER to M3** | Zero Sprint-0 exit criteria exercise the AI gateway. ModelAdapter (ADR-013) has no callers until NLQ/Morning Brief (M4). Defer the Kubernetes deployment and API key secrets to M3. Sprint-0 deliverable = `packages/ai-gateway-client` TypeScript interface stub only (zero infra). |
| **Playwright E2E scaffolding** | **DEFER to M1 Week 2** | No Sprint-0 exit criterion requires E2E tests. No running frontend exists in Sprint 0. Playwright scaffolding built against a non-existent UI will be rewritten in M1. Remove from Workstream A entirely. |
| **Husky + Commitlint + Conventional Commits** | **DEFER to M1 Week 1** | No exit criterion validates commit-message format. No invariant depends on it. Security hooks (`gitleaks` pre-commit) STAY — they protect I-S09. Ceremony hooks (Commitlint) defer. Distinction: security hooks in, ceremony hooks out. |
| **Coding guidelines + error-handling standards docs** | **DEFER to M1 Week 1** | Reference docs do not gate any exit criterion. A 30-minute write does not justify Sprint-0 track time when IaC is the critical-path bottleneck. |
| **Full dbt test harness + deployment pipeline** | **DEFER to M1** | EC3 requires StarRocks to query a Bronze test table via the Iceberg catalog — it does NOT require dbt. dbt is the Silver/Gold layer. Sprint-0 dbt scope = `dbt init` + profile config (dev) + one empty model that compiles (`dbt compile` passes) + CI invocation stub. `dbt run`, `dbt test`, `dbt docs`, dbt deployment pipeline are M1. |
| **Operational DQ pipelines** | **DEFER to M1** | DQ pipelines run on real data. Sprint 0 has no real data. DQ framework Sprint-0 scope = Zod schema declarations for DQ metric categories in `packages/contracts` + empty `dbt test` stubs + CI invocation that returns green on an empty model. No Grafana DQ panels with live data. |
| **Production-grade brain.js pixel** | **DEFER to M1** | EC2 requires a stub event in CI (a synthetic POST to the collector endpoint). It does not require a production pixel SDK with CNAME routing and first-party cookie handling. Sprint-0 pixel = a Node.js test fixture that POSTs one synthetic event. |
| **CloudWatch alarms + dashboards (full)** | **SCOPE-REDUCE** | EC7 is satisfied entirely by Grafana Cloud + OTel. CloudWatch is not mentioned in any exit criterion. Sprint-0 CloudWatch scope = log groups + one composite "EKS cluster unhealthy" alarm (2-line Terraform) for basic AWS hygiene only. No CloudWatch dashboards. |

**Staging + prod Terraform interpretation (Concern 3 from persona 02a — HIGH severity, requires a definitive ruling):**

The Stakeholder explicitly wrote: "we are setting up dev/staging/prod; staging and prod must be PROVISIONED but remain unused; no prod deployments." Exit criterion 10 says "dev/staging/prod provisioned via Terraform." The over-engineering persona escalated this as HIGH severity — a full `terraform apply` to all three environments could consume the entire IaC track and generate $800–1,500/month of idle AWS spend from Day 1.

**Recommended interpretation for the Architect (no escalation required — the Stakeholder intent is resolvable):**

The correct reading of "provisioned but unused" is: apply the full Terraform resource declarations to all three accounts such that the environments are reproducibly provisionable, but with no running compute in staging and prod during Phase 1.

Operationally:

- **dev:** `terraform apply` clean — all resources running (EKS, RDS, ElastiCache, Redpanda, S3+Glue, IAM, KMS, Secrets Manager).
- **staging:** `terraform apply` clean for network/IAM/S3/state/buckets/KMS — the account's structural scaffold exists and is reproducible. EKS node groups either not created (module instantiated but `desired_size = 0, min_size = 0`) or set to zero-node pool; RDS declared but not applied (commented module call, ready to uncomment for M1 deploy). `terraform plan` passes with zero errors.
- **prod:** Terraform workspace/account bootstrapped (state bucket created, OIDC provider registered, root IAM bootstrapping complete); all resource declarations exist; `terraform plan` passes. `terraform apply` deferred to M4 (first prod-bound deployment). Zero running AWS resources; zero idle spend.

This satisfies "3 environments provisioned via Terraform" (the IaC code exists, is validated, and is reproducibly applicable for each environment) without triggering idle compute spend in staging/prod during Phase 1. The Architect must encode this interpretation as the explicit EC10 definition in the plan. If the Stakeholder disputes this reading, the orchestrator can surface it via `/escalate` — but the reading is the minimum coherent interpretation of "provisioned but unused at near-zero idle cost" and does not require pre-authorization.

---

### B. ISOLATION/SECRETS HARDNESS DIRECTIVES — Non-Negotiables for the Architect

The isolation/secrets persona surfaced 1 CRITICAL concern and 7 HIGH/MEDIUM concerns. Every item below is elevated to a **non-negotiable Architect/builder directive**. These protect the ONE invariant (I-S01 brand isolation, multi-layer, structural) and are expensive or impossible to retrofit. The Architect must encode each as an explicit acceptance criterion in the relevant workstream, and the Security/QA gates will verify them before Sprint-0 sign-off.

**NN-1 (CRITICAL) — RLS predicate MUST use two-argument `current_setting()` form.**

Migration #1 MUST use `current_setting('app.current_brand_id', true)::uuid` in the USING clause of every brand-scoped RLS policy — the two-argument form where the second argument is `true` (missing_ok). The one-argument form throws `ERROR: unrecognized configuration parameter` on a missed GUC; that exception can be caught and swallowed by ORMs or middleware, allowing a subsequent query in the same connection-pool slot to execute with a stale or unset brand_id. The two-argument form returns null on miss, making the predicate `brand_id = null` — which is always false by SQL null semantics, returning zero rows structurally.

Additionally, `packages/db` query middleware MUST: (a) reset the GUC to null at connection checkout, AND (b) re-set it explicitly before every query. Both, not either/or — to eliminate the connection-pool stale-GUC vector. A unit test must assert that a query issued without the GUC set returns zero rows (not an exception).

This must be the explicitly mandated form in the Architect's implementation plan for migration #1. The builder may not use the one-argument form. This is non-negotiable; it cannot be revisited at PR review.

**NN-2 (HIGH) — Isolation-fuzz CI gate MUST cover all 4 layers.**

Exit criterion 5 as currently written covers only Postgres RLS. TRIGGER-SURFACES.md §Multi-tenancy and COMPLIANCE.md §Brand isolation explicitly require the CI isolation-fuzz to cover: (a) Postgres RLS, (b) StarRocks row policies, (c) Redis `brandKey()` construction, (d) MCP scope authorization. The Architect must expand the Workstream F acceptance criterion to include all four. Stubs are acceptable for StarRocks and MCP in Sprint-0 CI if the full implementations are not yet running, but the test assertions must exist and must fail if the enforcement is absent. The StarRocks row policy template (tied to `brand_id`) must be provisioned at cluster-setup time (Workstream E) so it applies to every subsequent table provisioned from that template.

**NN-3 (HIGH) — IRSA trust policies MUST use `StringEquals` with explicit namespace+service-account; no wildcards.**

The Terraform IRSA module for every workload (collector, stream-worker, core, jobs) must use the `StringEquals` condition on both the OIDC namespace and service-account name fields — never `StringLike` with wildcards. A wildcard IRSA trust policy collapses workload isolation to cluster-level: any pod that can mount a service account token can assume any workload's IAM role, breaking both secrets isolation (I-S09) and per-brand S3 prefix scoping (I-S01 physical layer).

A Checkov/OPA policy rule must be active in the Workstream H IaC CI gate: any IRSA trust policy using `StringLike` on the subject field fails the `terraform plan` gate before any apply to dev. This rule must be in place before the first EKS apply.

**NN-4 (HIGH) — S3 Object Lock MUST be `COMPLIANCE` mode, 7-year retention, set at bucket creation.**

The Terraform S3 bucket resource for the audit WORM anchor must explicitly set `object_lock_configuration { rule { default_retention { mode = "COMPLIANCE", years = 7 } } }`. `GOVERNANCE` mode is not acceptable — it can be bypassed by any IAM principal with `s3:BypassGovernanceRetention`, defeating the WORM guarantee. Objects written with a short retention period (e.g., 90 days for dev convenience) cannot have their retention extended retroactively — this is a non-retrofittable decision. A Checkov rule must enforce that no bucket tagged `purpose=audit` uses `GOVERNANCE` mode or a retention period below 7 years. This applies to both the audit WORM anchor bucket and the Bronze Iceberg bucket (which is the system-of-record per I-E02).

**NN-5 (HIGH) — Per-brand S3 prefix isolation MUST be IAM-enforced, not convention-enforced.**

The Terraform IAM policy for every workload's IRSA role that accesses S3 must scope permissions to the specific prefix pattern the workload owns — not the full bucket. The stream-worker gets `s3:PutObject` on `arn:aws:s3:::bucket/bronze/brand=*/...` but NOT `s3:GetObject` on the bucket root. The Analytics API / StarRocks Iceberg external catalog role gets `s3:GetObject` scoped to the relevant prefixes. A bug in the stream-worker's prefix construction must have no S3-layer backstop at the broader bucket scope. Document this as a required policy structure in the Architect's IaC design; validate in Checkov.

**NN-6 (MEDIUM) — OTel span-attribute PII redaction MUST be a Sprint-0 deliverable in `packages/observability` + collector.**

`packages/observability` SDK must include a span-attribute wrapper that refuses to set attributes whose key matches a PII-pattern list (`email`, `phone`, `name`, `address`, `pan_`, `card_`). The OTel collector pipeline config must include a `transform` processor that redacts known PII attribute patterns before forwarding to Grafana Cloud. The no-PII-in-logs static lint does not cover `span.setAttributes()` at runtime — PII embedded in span attributes bypasses the logger entirely and flows to Grafana Cloud (a third-party sub-processor), which is a DPDP violation. Both SDK wrapper and collector transform must ship in Workstream G, not deferred to M1.

**NN-7 (MEDIUM) — Redis raw-key lint MUST be an explicit Sprint-0 deliverable in Workstream A.**

The ESLint rule banning raw Redis key string construction outside `tenant-context.brandKey()` must be added as an explicit Workstream A deliverable alongside the money-minor-units lint. This is a 30-minute implementation task. Without it, the invariant is convention-only until the first cache usage in M1 sets a raw-key pattern that becomes copy-pasted. Retrofitting the lint rule against a codebase with established cache usage is high-friction. The lint rule must be active and green before M1 Day 1.

---

### C. Architect Directives Summary

The Architect's plan MUST:

1. Define EC10 operationally as: dev = full apply; staging = structural scaffold applied (network/IAM/S3/KMS), compute at zero/not-created; prod = workspace bootstrapped + `terraform plan` passes, no apply until M4.
2. Remove Authentik from Sprint-0 operational scope; add IaC declaration only (Helm values + namespace).
3. Remove LiteLLM from all Sprint-0 infra; add `packages/ai-gateway-client` TypeScript interface stub only.
4. Remove Playwright from Sprint-0; add to M1 Week 2.
5. Remove Commitlint/Conventional Commits from Sprint-0; keep `gitleaks` pre-commit.
6. Scope dbt to: `dbt init` + profile config + one empty model + `dbt compile` CI stub.
7. Scope DQ framework to: Zod declarations + empty `dbt test` stubs + CI invocation.
8. Scope pixel to: a Node.js test fixture that POSTs one synthetic event to collector.
9. Encode NN-1 through NN-7 as explicit acceptance criteria in the relevant workstreams (Workstreams A, D, E, F, G, H).
10. Ensure isolation-fuzz CI gate is expanded to all 4 canonical layers before Sprint-0 sign-off.

Lane: high_stakes (6 trigger surfaces). Decision: ADVANCE.

---

### D. Journal Entry

```
## 2026-06-15T11:40:00Z — Engineering Advisor (cto-advisor) — chore-platform-foundations-sprint0
**Stage:** 1 · **Action:** Persona synthesis (02a + 02b) · **Personas:** sprint0-overengineering-skeptic:sonnet + sprint0-isolation-secrets-hardness-skeptic:sonnet · **Decision:** ADVANCE
**Rationale:** 9 scope rulings issued (Authentik/LiteLLM/Playwright/Commitlint/dbt/DQ/pixel/CloudWatch deferred; EC10 staging/prod interpreted as plan-passes-for-staging-prod-not-full-apply); 7 non-negotiable isolation/secrets directives elevated (NN-1 CRITICAL RLS two-arg predicate; NN-2 isolation-fuzz 4-layer expansion; NN-3 IRSA StringEquals; NN-4 S3 Object Lock COMPLIANCE+7yr; NN-5 S3 prefix IAM-enforced; NN-6 OTel PII redaction; NN-7 Redis key lint). All persona concerns resolved or framed for Architect. · **Next:** Architect Stage 2 — binding plan with these directives as acceptance criteria
```
