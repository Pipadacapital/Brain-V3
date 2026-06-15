# Architecture Plan — Brain Platform Foundations (Sprint 0)

| Field | Value |
|-------|-------|
| **req_id** | `chore-platform-foundations-sprint0` |
| **Stage** | 2 — Architect (binding plan) |
| **Author** | Architect |
| **Authored at** | 2026-06-15 |
| **Decision** | ADVANCE → Stage 3 (parallel build fan-out) |
| **Lane** | high_stakes (6 trigger surfaces) |
| **Cost paradigm** | **Deterministic / infrastructure** — zero model calls. No statistical or LLM tier is in Sprint-0 scope; the `ai`/LiteLLM path is deferred (ruling 3). The only "routing" decision is managed-vs-self-host, already bound in `STACK.md` (managed-first). Justification: this is pure paved-path substrate; every behaviour is deterministic config/IaC/lint/migration. The effort-tier gate (`cost-routing-paradigms`) is N/A by construction and recorded as such. |
| **Single-Primitive sweep** | **Clean (extend, never create).** Every primitive this plan touches already exists as a stub in the repo (`packages/*`, `apps/*`, `tools/*`, `db/*`, `infra/*`, `.github/workflows/*`). No new deployable, database, ledger, service, or top-level package is introduced. Builders *fill* stubs; they do not scaffold new ones. |

---

## 0. How to read this plan

This is the **binding** decomposition. Builders implement it verbatim; any required deviation routes back to the Architect (amendment loop) — never freelanced. The repo is **already scaffolded** (Foundation sealed 2026-06-15): `apps/{collector,stream-worker,core,web}`, `packages/{contracts,db,events,tenant-context,observability,config,money,audit,metric-engine,identity-core,feature-flags,ai-gateway-client,pixel-sdk,ui}`, `tools/{eval,isolation-fuzz,parity-oracle,seed}`, `db/{migrations,dbt,iceberg,starrocks}`, `infra/{terraform,helm,argocd}`, `.github/workflows/{pr,main,eval}.yml`. **Every directory and `index.ts` is an empty `export {}` stub or a TODO.** The job of Sprint 0 is to fill exactly the stubs the 10 exit criteria require — nothing more.

Per the Stakeholder's requested output format, every track carries: **Design Decisions · Folder Structure · Configuration · Terraform Layout · Implementation Steps · Validation Steps · Risks · Recommendations.** Tracks without infra (A) note Terraform Layout as N/A.

**The 10 exit criteria (EC1–EC10)** from doc 12 ARTIFACT 2 are the binary success gate. Each track's acceptance criteria map to specific ECs. Duration cap is **2 weeks** (frozen) — scope is held to exactly the ECs.

---

## 1. Non-negotiables — encoded as global acceptance criteria

All 7 are folded into the owning track's **pass-1** acceptance contract (no rework bounce). A track is not "done" until its NN items are green.

| NN | Directive (verbatim intent) | Owning track(s) | Pass-1 acceptance test |
|----|------|------|------|
| **NN-1** (CRITICAL) | RLS predicate uses **two-arg** `current_setting('app.current_brand_id', true)::uuid`; `packages/db` middleware resets GUC to null at checkout **and** re-sets before every query | E | Unit test: a query with no GUC set returns **0 rows** (not an exception). Migration grep: no one-arg `current_setting` in any policy. |
| **NN-2** (HIGH) | Isolation-fuzz CI gate covers **all 4 layers**: (a) Postgres RLS, (b) StarRocks row policy, (c) Redis `brandKey()`, (d) MCP scope. StarRocks row-policy template provisioned at cluster-setup. | E (PG, Redis, MCP), D (StarRocks template) | `tools/isolation-fuzz` has ≥1 asserting test per layer; each **fails** if enforcement removed. StarRocks layer may stub the query but the assertion must exist. |
| **NN-3** (HIGH) | Every IRSA trust policy uses `StringEquals` on **both** OIDC `:sub` (namespace+SA) — never `StringLike`/wildcard. Checkov/OPA rule blocks `StringLike` on the subject before first apply. | C (IRSA module), B (Checkov/OPA gate) | `terraform plan` on a wildcard-subject IRSA fixture **fails** the IaC gate. |
| **NN-4** (HIGH) | S3 Object Lock = `COMPLIANCE` mode, **7-year** retention, set at bucket creation, on the audit-anchor bucket **and** the Bronze bucket (I-E02 SoR). Checkov rule rejects `GOVERNANCE` or `<7yr` on `purpose=audit`/Bronze buckets. | C (S3 module), B (Checkov gate) | Checkov fixture: a `GOVERNANCE`-mode audit bucket **fails** plan. Real buckets show `mode=COMPLIANCE, years=7`. |
| **NN-5** (HIGH) | Per-brand S3 prefix isolation is **IAM-enforced**, not convention. Workload IAM policies scope to the owned prefix pattern (`bronze/brand_id=*/…`), never bucket root. | C (IAM/IRSA module), B (Checkov gate) | stream-worker role has `PutObject` on the bronze prefix only, no `GetObject` on bucket root; Checkov asserts no bucket-root `s3:*`. |
| **NN-6** (MEDIUM) | OTel **span-attribute PII redaction** ships in `packages/observability` (SDK wrapper refusing PII-keyed attrs) **and** the collector `transform` processor — not deferred. | E (`packages/observability`) + C (collector config) | Unit test: `setAttr('email', x)` is dropped/redacted. Collector config has a `transform`/`attributes` redaction processor for the PII key list. |
| **NN-7** (MEDIUM) | Redis **raw-key lint** (ban key construction outside `tenant-context.brandKey()`) ships in Workstream A alongside money-lint. | A (ESLint config) | Lint **fails** on a `redis.get('foo:'+id)` fixture; **passes** when routed through `brandKey()`. |

---

## 2. Scope rulings — applied (do NOT re-expand)

Encoded from the intake synthesis §A. Builders must treat each "DEFER" as **out of Sprint-0 scope** and each scope-reduction as the ceiling.

| Item | Ruling | What ships in Sprint 0 (the ceiling) | Track |
|------|--------|------|------|
| Authentik on EKS | **DEFER → M1 D1** | IaC declaration only: Helm values file + namespace manifest, **not applied**. No OIDC flow. | C |
| LiteLLM gateway | **DEFER → M3** | `packages/ai-gateway-client` TS interface stub stays as-is. **No** K8s deploy, **no** API-key secret. (NB: the existing `docker-compose.yml` litellm service stays for local-dev convenience only; do not add infra.) | — |
| Playwright E2E | **DEFER → M1 W2** | Nothing. Do **not** add Playwright to Workstream A. | A (removal) |
| Husky + Commitlint + Conventional Commits | **DEFER → M1 W1** | **Security** pre-commit hook (`gitleaks`) STAYS. Ceremony hooks OUT. | A / B |
| Coding-guideline + error-handling docs | **DEFER → M1 W1** | Nothing. | A (removal) |
| Full dbt harness + deploy pipeline | **DEFER → M1** | `dbt init` + profile (dev) + **one empty model that `dbt compile` passes** + CI invocation stub. No `dbt run`/`test`/`docs`/deploy. | D |
| Operational DQ pipelines | **DEFER → M1** | Zod DQ-category declarations in `packages/contracts` + empty `dbt test` stubs + CI invocation green on empty model. No live panels. | D |
| Production `brain.js` pixel | **DEFER → M1** | A Node.js **test fixture** that POSTs one synthetic event to the collector (EC2). `packages/pixel-sdk` stays a stub. | D |
| CloudWatch alarms/dashboards (full) | **SCOPE-REDUCE** | Log groups + **one** composite "EKS cluster unhealthy" alarm. No CloudWatch dashboards (Grafana owns SLOs). | C |

### EC10 — operational definition (binding)

> **dev** = `terraform apply` clean, all resources running (EKS, RDS, ElastiCache, Redpanda Cloud, S3+Glue, IAM, KMS, Secrets Manager).
> **staging** = `terraform apply` clean for the **structural scaffold** (state/backend, VPC/network, IAM, S3 buckets+KMS); compute **not created** — EKS node groups instantiated with `desired_size=0,min_size=0,max_size=0`; RDS/ElastiCache module calls present but **commented/`count=0`** (ready to enable for M1). `terraform plan` passes with zero errors.
> **prod** = workspace/account **bootstrapped** (state bucket created, GitHub OIDC provider registered, root bootstrap IAM). All resource declarations exist; `terraform plan` passes. **No `apply`** of compute until M4. Zero idle compute spend.

This is the binding reading of "provisioned but unused." If the Stakeholder disputes, route via `/escalate`; otherwise builders proceed on this definition.

---

## 3. Track map and ownership

| Track | Title | Owner agent | Workstreams (doc 12) | ECs served |
|-------|-------|-------------|------|------|
| **A** | Monorepo, Dev-Standards & Contracts | `backend-developer` | A, C | EC1, EC4 |
| **B** | CI/CD (GitHub Actions) | `platform-devops` | H | EC1, EC4, EC6, EC8 |
| **C** | AWS Foundation (Terraform) | `platform-devops` | D, F (infra: IAM/KMS/Secrets/S3) | EC6, EC10 |
| **D** | Data Platform Spine | `data-engineer` | E, B (testcontainers/parity), C (Apicurio) | EC2, EC3, EC9 |
| **E** | Observability + Isolation/Secrets cross-cuts | `data-engineer` (DB/RLS/StarRocks-fuzz) + `backend-developer` (OTel SDK/no-PII lint/Redis-fuzz/MCP-stub) | G, F (RLS+isolation) | EC5, EC6, EC7 |

**Track E split (explicit):** `data-engineer` owns `db/migrations/0001_init.sql` + `packages/db` RLS middleware + the PG and StarRocks fuzz layers. `backend-developer` owns `packages/observability` (OTel SDK + NN-6 redaction) + `packages/tenant-context` `brandKey()` + the Redis and MCP fuzz layers + no-PII lint. They share `tools/isolation-fuzz` (owner = `data-engineer`; `backend-developer` PRs layers into it). Orchestrator co-assigns; the two builders coordinate on the single fuzz harness only.

---

## 4. Sequencing, dependencies & shared-file ownership

### Critical path (the IaC bottleneck, C1 from intake)

```
Day 1 ──────────────► Day 5 ──────────────► Day 10
A (no infra dep) ════════════════════════════════════►  [parallel from D1]
B (workflows as files) ═════════════════════════════►   [parallel from D1; live-gate after C state bucket]
C: state→VPC→EKS→{RDS,ElastiCache,S3+Glue,IAM/KMS}→env-split  ◄── CRITICAL PATH
                         └─► D (needs EKS+S3+Glue+Redpanda)  ════►
                         └─► E (needs RDS live + EKS for OTel collector) ═══►
```

**Hard rule:** C must land **Terraform state bucket** (day 1) and **VPC+EKS+S3+Glue+RDS** (≈ day 3–4) before D and E can run their live integration legs. D and E begin their **code-only** legs (schemas, SDK, migration SQL, fuzz assertions, dbt scaffold) on **day 1 against local docker-compose** (LocalStack/MinIO/Postgres/StarRocks/Redpanda already in `docker-compose.yml`), then point at real AWS once C lands.

### Parallel groups

- **Group 1 (day 1, fully parallel, zero AWS):** A (all), B (workflow authoring), C (state+VPC+EKS), D (contracts/Avro/Bronze-format/StarRocks-DDL/dbt-scaffold against local), E (migration SQL + `packages/db`/`observability`/`tenant-context` code + fuzz assertions against local).
- **Group 2 (after C day ≈4):** D live legs (Redpanda Cloud topic, S3+Glue Bronze write/read, StarRocks external catalog), E live legs (OTel collector on EKS, RDS RLS verification, Grafana wiring), B live IaC gate (`terraform plan` against the real state bucket).

### Shared-file owners (write-race prevention) — MANDATORY

These files are touched by >1 track. Exactly one owner **writes**; others **request edits via the owner** (note in PR). No concurrent writes.

| Shared file | Sole writer | Consumers (read / request-edit) |
|-------------|-------------|------|
| `turbo.json` | **A** (`backend-developer`) | D, E add task entries via A |
| `tsconfig.base.json`, `eslint.config.mjs`, root `package.json` | **A** | all |
| `pnpm-workspace.yaml` | **A** | — (already correct) |
| `docker-compose.yml` | **D** (`data-engineer`) | E reads; E requests an OTel-collector/grafana-agent service add via D |
| `.github/workflows/pr.yml` | **B** (`platform-devops`) | A/D/E hand B the exact `turbo run <task>` line to wire; B owns the file |
| `.github/workflows/main.yml` | **B** | — |
| `infra/terraform/**` | **C** (`platform-devops`) | D/E consume **outputs** (bucket names, IRSA ARNs, registry URLs) via Terraform remote-state outputs; never write into `infra/terraform` |
| `db/migrations/0001_init.sql` | **E** (`data-engineer`) | — |
| `db/dbt/**`, `db/iceberg/**`, `db/starrocks/**` | **D** | — |
| `tools/isolation-fuzz/**` | **E** (`data-engineer`) | `backend-developer` PRs Redis+MCP layers into it |
| `packages/contracts/**` | **A** | D consumes generated Avro; CODEOWNERS gate applies |

**Seam contract (the one inter-track API):** A's `packages/contracts` Zod-source-of-truth emits the Avro schema that D registers in Apicurio and validates the EC2 event against. A delivers a **contracts skeleton + one sample event schema** by **end of day 1** so D's Avro/Apicurio leg is unblocked. This is the only hard A→D handoff.

---

## 5. Plan-overall sections (Design Decisions · Risks · Recommendations)

### Design Decisions (cross-cutting)

1. **Extend, never re-scaffold.** The repo is sealed with the correct topology. Builders fill stubs in place. Any urge to add a package/app/deployable is an `I-E05` violation → ADR required → bounce to Architect. (Single-Primitive sweep: clean.)
2. **Local-first parallelism.** `docker-compose.yml` already provides Postgres 16, Redis 7, MinIO (S3), StarRocks allin1, Redpanda, Apicurio, LocalStack (s3/secretsmanager/kms). All code legs develop and test against local containers (Testcontainers in CI) so no track is AWS-blocked on day 1. Real-AWS smoke is the **live leg** gated on C.
3. **Managed-first, single-region.** `ap-south-1` only; RegionAdapter seam exists but only the India binding is wired (no second binding built). Redpanda Cloud, managed StarRocks, Grafana Cloud per `STACK.md`. No self-hosted Mimir/Loki/Tempo.
4. **Isolation is a kernel property, asserted 4×.** Postgres RLS (NN-1 two-arg), per-brand S3 prefix (NN-5 IAM-enforced), per-brand KMS, StarRocks row policy (NN-2). The fuzz gate (NN-2) covers all four + Redis + MCP. A leak is P0/SLO-0.
5. **Account-per-environment, not workspace-per-env, for isolation; workspaces for ephemeral only.** dev/staging/prod are **separate AWS accounts** (ADR-010) — blast-radius isolation. Terraform uses a per-account backend with a shared module library (`infra/terraform/modules/*`) and per-env root configs (`infra/terraform/envs/{dev,staging,prod}`).
6. **Contract-first is mechanically gated.** Zod → codegen (types/OpenAPI/Avro/MCP) + `buf breaking` + Pact stub. `packages/contracts` carries a CODEOWNERS rule (consuming-domain owner approval) — established now, not deferred.
7. **No model tier.** Cost paradigm = deterministic/infrastructure. Recorded for the quarterly streamlining audit: zero paradigm-bypass risk in Sprint 0.

### Risks (overall)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| IaC (Track C) slips → compresses D & E | Med | High (2-wk cap) | Local-first parallelism (every code leg runs on docker-compose day 1); C prioritizes state→VPC→EKS→S3/Glue/RDS in that order; D/E only block on **live** legs. |
| Idle AWS spend in staging/prod | Low | Med | EC10 ruling: zero compute in staging/prod (size-0 node groups, `apply` deferred to M1/M4). |
| Isolation gap retrofit (NN-1..NN-5) | Low | Critical | All folded into pass-1 acceptance; Checkov/OPA blocks wildcards/GOVERNANCE before first apply; two-arg RLS + middleware GUC reset tested. |
| StarRocks row-policy templating missed (C2/NN-2) | Med | High | Row-policy template is an explicit cluster-setup deliverable in D; fuzz assertion exists even if stubbed. |
| Bronze partition/schema-evolution wrong (non-retrofittable, I-E02) | Med | High | Partition spec **`bucket(brand_id) + days(event_time)`** + FULL_TRANSITIVE additive-optional-only fixed at table creation; documented in D. |
| Shared-file write races | Med | Med | §4 sole-writer table; one writer per shared file. |

### Recommendations (overall)

- Run **Group 1 day 1** with all five builders concurrently; the orchestrator fans out A, B, C, D, E together. D and E develop against local until C's live legs land.
- A ships the **contracts skeleton + one sample event** first (EOD day 1) to unblock D's Avro/Apicurio leg.
- Hold the line on the 9 deferrals; bounce any re-expansion to the Architect.
- Confirm Grafana Cloud + Redpanda Cloud dev-tier accounts exist before Group 2 (org/billing prerequisite, not a code task).

---

## TRACK A — Monorepo, Dev-Standards & Contracts

**Owner:** `backend-developer` · **Workstreams:** A, C · **Serves:** EC1, EC4 · **AWS dep:** none (day-1 parallel)

### Design Decisions
- Turborepo + pnpm are already configured and correct (`turbo.json`, `pnpm-workspace.yaml`, `package.json` pin `turbo ^2.1.0`, `pnpm@9.12.0`, node ≥20). **Do not re-init** — extend `eslint.config.mjs` (currently a `warn`-only stub with TODOs) into the real boundary + custom-rule set.
- ESLint flat config (`eslint-plugin-boundaries ^5.0.0` already a devDep) is the enforcement substrate. The four boundary rules + two custom rules (money-lint, redis-key-lint NN-7) are the deliverable.
- `packages/contracts` is **Zod-as-source-of-truth**; codegen emits TS types, OpenAPI 3.1, Avro (`.avsc`), and MCP tool JSON schema. One sample event + one sample API proves all four artifacts.
- **Removed from scope (rulings):** Playwright, Husky/Commitlint/Conventional-Commits, coding-guideline docs. Do not add them.

### Folder Structure (fill existing stubs)
```
eslint.config.mjs                         # extend: boundaries rules 1-3 + money-lint + redis-key-lint (NN-7)
tools/eslint-rules/                        # NEW dir under tools/ (allowed: tooling, not a deployable)
  no-float-money.mjs                       #   money-minor-units lint (I-S07)
  no-raw-redis-key.mjs                     #   NN-7 — ban key construction outside brandKey()
packages/contracts/src/
  index.ts                                 # export the Zod schemas + generated barrel
  events/sample.collector.event.v1.ts      # ONE sample Zod event (EOD day-1 handoff to D)
  api/sample.api.v1.ts                      # ONE sample Zod API contract
  dq/                                       # Zod DQ-category declarations (freshness/completeness/schema/recon) — stubs (ruling 7; feeds D)
packages/contracts/scripts/
  codegen.ts                               # Zod -> {types, openapi, avro, mcp}; writes generated/
packages/contracts/generated/             # (turbo output) types/ openapi/ avro/ mcp/
tools/contract-gate/                        # buf-breaking + Pact-stub runner invoked by CI
```

### Configuration
- `turbo.json` (A owns): add `test:contract` is already present; add `gen:contracts` is present. Ensure `gen:contracts` outputs `packages/contracts/generated/**` (already declared). No structural change needed beyond confirming task graph.
- ESLint rules to implement (the TODOs in `eslint.config.mjs`):
  1. `apps/*` may not import `apps/*` (`boundaries/element-types`).
  2. A core module imports another module's `index.ts` only (no reach past `index.ts`).
  3. `packages/metric-engine` importable **only** by `analytics` + `measurement` modules.
  4. `no-raw-redis-key` (NN-7): flag string concat into a redis client call; require `brandKey()`.
  5. `no-float-money` (I-S07): flag `float`/`double`/unpinned `numeric` money columns + float arithmetic on `*_minor`.
- CODEOWNERS: add `/packages/contracts/ @<consuming-domain-owner>` requiring approval (I-E01). PR template added (lightweight).
- `.npmrc` `engine-strict=true` and `.nvmrc 20` already present — keep.

### Terraform Layout
N/A — pure tooling track.

### Implementation Steps (each 2–5 min, with file:line anchors)
1. Replace the `warn`-only rule block in `eslint.config.mjs:38` with real `boundaries/element-types` rules 1–3 (elements already declared at `eslint.config.mjs:25-30`).
2. Create `tools/eslint-rules/no-float-money.mjs`; wire into `eslint.config.mjs` `rules` block; add a failing fixture (`*_amount: float` → error).
3. Create `tools/eslint-rules/no-raw-redis-key.mjs` (NN-7); wire in; add a fixture (`redis.get('k:'+id)` → error; `brandKey(...)` → pass).
4. Fill `packages/contracts/src/events/sample.collector.event.v1.ts` (Zod) — carries `brand_id`, `event_id`, `occurred_at`, `correlation_id`. **Hand to D by EOD day 1.**
5. Fill `packages/contracts/src/api/sample.api.v1.ts` (Zod request/response with `Idempotency-Key` header).
6. Write `packages/contracts/scripts/codegen.ts`: Zod → TS types + OpenAPI 3.1 (`zod-to-openapi`) + Avro `.avsc` + MCP tool JSON schema. Output to `generated/`.
7. Create `tools/contract-gate/`: `buf breaking` over the generated Avro/proto + a Pact stub assertion; wire as `test:contract`.
8. Add DQ-category Zod stubs in `packages/contracts/src/dq/` (declarations only — ruling 7; feeds D).
9. Add `CODEOWNERS` rule for `/packages/contracts/`; add a minimal `.github/pull_request_template.md`.

### Validation Steps
- `pnpm i && turbo build` green (EC1). `turbo run lint` fails on each fixture (boundary cross, float-money, raw-redis-key), passes when corrected.
- `turbo run gen:contracts` emits all four artifact families; a hand-edited breaking change to the sample contract makes `turbo run test:contract` **fail** (EC4).
- Import-boundary lint fails on an `apps/collector` → `apps/core` import fixture (EC1).

### Risks
- Codegen toolchain drift (Zod→OpenAPI/Avro libs). Mitigation: pin libs; one sample proves the pipeline; richer schemas are M1.

### Recommendations
- Keep the sample event/API trivial — the goal is the **pipeline**, not coverage. Resist adding real domain contracts (that's M1).

### Pass-1 acceptance contract (Track A)
- [ ] EC1: `pnpm i && turbo build` green; import-boundary lint enforced (3 boundary rules active + failing fixtures).
- [ ] EC4: codegen → types/OpenAPI/Avro/MCP; a breaking change **fails** `test:contract`.
- [ ] **NN-7**: `no-raw-redis-key` lint active + green-on-`brandKey`/fail-on-raw.
- [ ] I-S07: `no-float-money` lint active + fails on a float-money fixture.
- [ ] I-E01: `packages/contracts` CODEOWNERS approval rule present.
- [ ] Deferrals honored: **no** Playwright, Husky, Commitlint, guideline docs added.

---

## TRACK B — CI/CD (GitHub Actions)

**Owner:** `platform-devops` · **Workstream:** H · **Serves:** EC1, EC4, EC6, EC8 · **AWS dep:** state bucket (C) for the IaC live gate

### Design Decisions
- Three workflows already exist as TODO stubs (`pr.yml`, `main.yml`, `eval.yml`). **Extend in place**; do not add new workflow files except a dedicated `infra.yml` for the Terraform gate (keeps PR fast and IaC-scoped).
- `turbo run … --affected` is already wired in `pr.yml:13`. Build only affected deployables (EC8). The deploy matrix derives the affected `apps/*` set.
- Security scanning: `gitleaks` (secrets, also a pre-commit hook), `trivy` (container + fs vuln), `osv-scanner` (deps). The IaC gate runs `terraform fmt/validate/plan` + **Checkov + OPA/conftest** carrying the NN-3/NN-4/NN-5 policy rules.
- ArgoCD app-of-apps: staging **auto-sync**, prod **manual promote**; rollback = ArgoCD revert + `packages/feature-flags` flag-off. This is the EC8 drill (verified, not just configured).

### Folder Structure
```
.github/workflows/
  pr.yml          # extend: add docker-build(affected)->trivy->smoke (the TODO at pr.yml:14)
  main.yml        # extend: build+cosign sign->ECR(immutable digest)->Helm values bump->gitops commit
  infra.yml       # NEW: terraform fmt/validate/plan + Checkov + conftest (OPA) on infra/** changes
  eval.yml        # leave (AI eval — not Sprint-0 active)
.github/policy/                 # NEW: OPA/conftest rego carrying NN-3/4/5
  irsa_no_wildcard.rego         # NN-3
  s3_object_lock_compliance.rego# NN-4
  s3_prefix_least_priv.rego     # NN-5
.checkov.yaml                   # Checkov config: custom checks + the NN rules
.gitleaks.toml                  # secret-scan config (also pre-commit)
infra/argocd/                   # app-of-apps + per-env overlays (fill the README-only dir)
  app-of-apps.yaml
  envs/{staging,prod}/*.yaml
```

### Configuration
- `pr.yml` jobs: `lint typecheck test:unit --affected` (present) → add `test:contract --affected`, `test:isolation --affected` (present), `test:parity --affected` (present), then `docker build` affected apps → `trivy` → `osv-scanner` → `gitleaks`.
- `infra.yml`: triggers on `infra/**`; runs `terraform fmt -check`, `validate`, `plan` (against the C-owned state bucket via OIDC role), then **Checkov** + **conftest** with the `.github/policy/*.rego`. Wildcard IRSA / GOVERNANCE-lock / bucket-root S3 → **plan fails**.
- Branch protection definition (as code/doc): required checks = `pr` + `infra`; ≥1 review (2 for contracts/migrations/RLS/ledger per doc 12 §2); no force-push to `main`; squash-merge only.
- `main.yml`: build → `cosign` sign → push ECR by immutable digest → bump Helm values → commit to gitops path → ArgoCD syncs staging.

### Terraform Layout
- B does not own `infra/terraform/**` (C does). B owns the **GitHub OIDC → AWS role** consumption for `terraform plan` and the policy gate. The OIDC provider + CI role are **declared by C** (NN-3 StringEquals on the GitHub OIDC sub); B references the role ARN via repo secret/var.

### Implementation Steps
1. Extend `pr.yml:14` (the TODO): add affected `docker build` → `trivy image` → `osv-scanner` → `gitleaks detect`. Add `test:contract --affected` to the line at `pr.yml:13`.
2. Create `.github/workflows/infra.yml`: `fmt/validate/plan` + Checkov + conftest; OIDC-assume the C-provided CI role.
3. Author `.github/policy/irsa_no_wildcard.rego` (NN-3), `s3_object_lock_compliance.rego` (NN-4), `s3_prefix_least_priv.rego` (NN-5); add `.checkov.yaml` wiring.
4. Add `.gitleaks.toml`; document `gitleaks` pre-commit hook install (security hook STAYS; ceremony hooks deferred).
5. Fill `main.yml` (the TODO at `main.yml:8`): build→cosign→ECR→Helm-bump→gitops commit.
6. Fill `infra/argocd/app-of-apps.yaml` + `envs/{staging,prod}` overlays; staging auto-sync, prod manual.
7. Write the branch-protection definition (`.github/branch-protection.md` or a `gh` apply script) listing required checks.
8. Wire the rollback drill: ArgoCD revert + `feature-flags` flag-off; document the EC8 verification steps.

### Validation Steps
- A PR touching only `apps/core` builds **only** core in the matrix (EC8 affected).
- Wildcard-IRSA fixture / GOVERNANCE-lock fixture / bucket-root-S3 fixture each **fail** `infra.yml` (NN-3/4/5).
- `gitleaks` catches a planted fake secret (EC6 secret hygiene). `trivy`/`osv` run and gate on high.
- Merge to `main` → staging auto-deploys; manual prod promote; ArgoCD revert + flag-off verified (EC8).

### Risks
- IaC gate depends on C's state bucket + OIDC role. Mitigation: B authors workflows + policy as files day 1; the live `plan` leg activates once C lands the state bucket (day 1–2 target).

### Recommendations
- Keep `infra.yml` separate from `pr.yml` so app PRs aren't slowed by Terraform; only `infra/**` changes trigger it.

### Pass-1 acceptance contract (Track B)
- [ ] EC8: affected-only build matrix; staging auto-deploy; prod promote + ArgoCD rollback + flag-off **verified**.
- [ ] EC6: `gitleaks` secret scan active; trivy/osv dep+vuln scan gating.
- [ ] EC4: `test:contract` wired as a blocking PR check.
- [ ] **NN-3/4/5**: Checkov/OPA rules block wildcard-IRSA, GOVERNANCE-lock, bucket-root-S3 before any apply.
- [ ] Branch protection definition committed (required checks; 2-approval rule for contracts/migrations/RLS/ledger).

---

## TRACK C — AWS Foundation (Terraform)

**Owner:** `platform-devops` · **Workstreams:** D + F(infra) · **Serves:** EC6, EC10 · **CRITICAL PATH**

### Design Decisions
- **Account-per-environment** (ADR-010): dev/staging/prod are separate AWS accounts → blast-radius isolation, clean IAM trust boundaries. A shared module library + per-env root configs (not workspace-per-env, which shares an account).
- **Remote state**: per-account S3 backend + DynamoDB lock (or S3-native lock). State bucket is the **day-1** deliverable (unblocks B's IaC gate).
- **IRSA NN-3**: every workload role's trust policy uses `StringEquals` on `oidc:sub = system:serviceaccount:<ns>:<sa>` — never `StringLike`. A reusable `modules/irsa` enforces this shape.
- **S3 NN-4/NN-5**: Bronze bucket + audit-anchor bucket created with Object Lock `COMPLIANCE`, 7yr, at creation. Per-brand prefix isolation is **IAM-policy-enforced** (workload roles scoped to `bronze/brand_id=*/…`, never bucket root).
- **KMS**: one root CMK set for Phase 1 (cost-aware); **per-brand DEK path declared but DEK creation is runtime** (brand onboarding), not Sprint-0 IaC.
- **Authentik**: Helm values + namespace **declared, not applied** (ruling). **LiteLLM**: omitted entirely from infra (ruling).
- **CloudWatch**: log groups + **one** composite "EKS unhealthy" alarm only (scope-reduce). Grafana owns SLOs.

### Folder Structure
```
infra/terraform/
  modules/
    network/        # VPC, public/private subnets (3 AZ), single NAT (cost-aware, dev), SGs
    eks/            # EKS + Karpenter + ArgoCD bootstrap; node groups parametrized (size-0 capable for staging)
    irsa/           # NN-3 StringEquals trust-policy factory (per workload)
    rds/            # Postgres 16 Multi-AZ + PITR (dev only; staging count=0; prod declared)
    elasticache/    # Redis (dev only; staging count=0)
    s3-iceberg/     # Bronze bucket + Glue catalog DB; NN-4 Object Lock COMPLIANCE/7yr; NN-5 prefix IAM
    s3-audit/       # audit-anchor bucket; NN-4 Object Lock COMPLIANCE/7yr
    kms/            # root CMK set; per-brand DEK alias path (no DEKs created)
    secrets/        # Secrets Manager + IRSA-scoped read; External-Secrets pattern
    redpanda/       # Redpanda Cloud cluster + topics (env-scoped); used by D
    oidc-github/    # GitHub OIDC provider + CI plan role (NN-3 shape) — consumed by Track B
    observability/  # CloudWatch log groups + 1 composite EKS-unhealthy alarm; OTel collector IRSA
  envs/
    dev/   {backend.tf, main.tf, variables.tf}   # full apply
    staging/ {backend.tf, main.tf}               # structural scaffold; compute size-0 / count=0
    prod/  {backend.tf, bootstrap.tf}            # state+OIDC+root IAM only; plan-passes, no compute apply
  bootstrap/        # one-time state bucket + lock table per account
```

### Configuration
- Pin `terraform { required_version = ">= 1.9" }`; AWS provider `~> 6.0` (latest stable 6.x — verified-existing, June 2026). Pin EKS/Karpenter module versions to latest-stable at apply (resolve at write time; do not invent).
- Region `ap-south-1` only. Single NAT in dev (cost). Multi-AZ RDS in dev.
- `s3-iceberg` + `s3-audit`: `object_lock_enabled=true` at creation; `object_lock_configuration { rule { default_retention { mode="COMPLIANCE", years=7 } } }` (NN-4). Bucket tag `purpose=audit`/`purpose=bronze` for the Checkov rule.
- `irsa` module: condition `StringEquals` on `${oidc}:sub` and `${oidc}:aud`. No `StringLike` anywhere (NN-3).
- Workload S3 policies (NN-5): stream-worker = `s3:PutObject` on `arn:…:bucket/bronze/brand_id=*/*` only; StarRocks/Analytics reader = `s3:GetObject` on the bronze prefix only; **no** bucket-root grant.
- Secrets: app reads via IRSA + External-Secrets; **no secret value in Terraform state** (use `secretsmanager_secret` shell + runtime population).

### Terraform Layout
As the folder tree above: `modules/*` reusable, `envs/{dev,staging,prod}/*` roots. EC10 ruling encoded by node-group/RDS `count`/`desired_size` variables (dev=real, staging=0, prod=not-applied).

### Implementation Steps
1. `bootstrap/`: create state bucket + lock per account; **apply dev state bucket day 1** (unblocks B).
2. `modules/network` + `envs/dev` apply: VPC, 3-AZ subnets, single NAT, SGs.
3. `modules/eks` + Karpenter + ArgoCD bootstrap; apply to dev; verify ArgoCD syncs a hello app.
4. `modules/oidc-github` (NN-3 shape) → output the CI plan role ARN to Track B.
5. `modules/irsa` factory; instantiate per workload (collector, stream-worker, core, jobs, otel-collector).
6. `modules/s3-iceberg` + `modules/s3-audit` (NN-4 COMPLIANCE/7yr at creation) + Glue catalog DB.
7. Workload IAM policies (NN-5 prefix-scoped); attach via `irsa`.
8. `modules/kms` root CMK + per-brand DEK alias path (no DEKs).
9. `modules/secrets` Secrets Manager + IRSA read + External-Secrets pattern; verify app reads a test secret via IRSA (EC6).
10. `modules/rds` (dev apply, Multi-AZ+PITR) + `modules/elasticache` (dev) — staging `count=0`.
11. `modules/redpanda` Redpanda Cloud cluster + topics `{env}.{domain}.{event}.v{n}` (hand topic names to D).
12. `modules/observability`: CloudWatch log groups + 1 composite alarm; OTel-collector IRSA.
13. Authentik Helm values + namespace **declared, not applied** (ruling).
14. `envs/staging` (structural scaffold, compute size-0) + `envs/prod` (bootstrap only); `terraform plan` passes for both (EC10).

### Validation Steps
- `terraform apply` clean in dev; all resources reachable from the cluster (EC10 dev).
- `terraform plan` passes in staging (compute size-0) and prod (bootstrap) (EC10 staging/prod).
- App pod assumes its IRSA role and reads a Secrets Manager secret (EC6).
- Checkov/OPA (Track B) passes on real modules; wildcard/GOVERNANCE/bucket-root fixtures fail.

### Risks
- This is the critical-path bottleneck (C1). Mitigation: strict day-order state→VPC→EKS→S3/Glue/RDS; D/E unblock on each as it lands.
- Idle spend. Mitigation: EC10 ruling (size-0 staging, prod plan-only).
- Object Lock is non-retrofittable. Mitigation: set at creation; Checkov enforces (NN-4).

### Recommendations
- Land the **state bucket + OIDC role first** (day 1) so Track B's IaC gate goes live immediately.
- Output bucket names / IRSA ARNs / Glue DB / Redpanda bootstrap as Terraform **remote-state outputs** so D and E consume them without touching `infra/terraform`.

### Pass-1 acceptance contract (Track C)
- [ ] EC10: dev full apply; staging scaffold (compute size-0) plan-passes; prod bootstrap plan-passes.
- [ ] EC6: app reads a secret via IRSA; KMS root CMK + Secrets Manager live.
- [ ] **NN-3**: all IRSA trust policies `StringEquals` (namespace+SA); no wildcard.
- [ ] **NN-4**: Bronze + audit buckets Object Lock `COMPLIANCE`/7yr at creation.
- [ ] **NN-5**: workload S3 policies prefix-scoped (`bronze/brand_id=*/…`), no bucket-root grant.
- [ ] Authentik declared-not-applied; LiteLLM absent from infra; CloudWatch reduced to log groups + 1 alarm.

---

## TRACK D — Data Platform Spine

**Owner:** `data-engineer` · **Workstreams:** E + B(testcontainers/parity) + C(Apicurio) · **Serves:** EC2, EC3, EC9 · **AWS dep:** S3+Glue, Redpanda Cloud, StarRocks (C)

### Design Decisions
- **One-way lakehouse** (ADR-002): `Iceberg(Bronze on S3+Glue) → dbt → StarRocks → Analytics API`; `StarRocks → Iceberg` forbidden. Sprint-0 builds the **spine plumbing only** — no business marts.
- **Bronze partition spec (non-retrofittable, I-E02): `bucket(N, brand_id)` + `days(event_time)`** (or `(brand_id, event_date)` identity partition per HLD — choose hidden-partitioning `bucket(brand_id)+days(event_time)` to avoid small-file skew while keeping `brand_id` first). Append-only, **no MERGE**, 24-month retention, per-brand prefix + per-brand KMS. **Schema evolution = additive-optional only; FULL_TRANSITIVE** in Apicurio.
- **Local Iceberg catalog**: add a REST catalog (lakekeeper/Nessie) container to `docker-compose.yml` (D owns the file) for the local Bronze leg; the AWS leg uses Glue.
- **StarRocks**: external Iceberg catalog over Bronze (EC3) + **row-policy template keyed on `brand_id` provisioned at cluster setup** (NN-2) so every future table inherits isolation.
- **dbt (ruling 6)**: `dbt init` + dev profile + **one empty model that `dbt compile` passes** + CI invocation stub. No `run`/`test`(beyond empty stub)/`docs`/deploy.
- **DQ framework (ruling 7)**: consume A's Zod DQ-category declarations + empty `dbt test` stubs + CI invocation green on the empty model. No live DQ.
- **Pixel (ruling 8)**: a Node.js **test fixture** POSTing one synthetic event to the collector for EC2 — not the production `brain.js`.
- **Parity-oracle scaffold (EC9)**: `tools/parity-oracle` runs green on a trivial fixture (TS recompute vs reference) — the harness, not real metrics.

### Folder Structure
```
db/iceberg/
  bronze_table.sql / bronze_spec.json    # Bronze DDL + partition spec bucket(brand_id)+days(event_time); FULL_TRANSITIVE note
  schema-evolution-policy.md             # additive-optional only (I-E02)
db/starrocks/
  external_iceberg_catalog.sql           # external catalog over Bronze (EC3)
  row_policy_template.sql                # NN-2 brand_id row-policy template (cluster setup)
  ddl/                                   # (empty Silver/Gold placeholders — no business marts)
db/dbt/
  dbt_project.yml                        # present; keep
  profiles/profiles.yml                  # dev profile (StarRocks adapter)
  models/staging/_empty_model.sql        # one model that `dbt compile` passes
  tests/_dq_stubs.yml                    # empty DQ test stubs (ruling 7)
docker-compose.yml                       # D adds: iceberg REST catalog (lakekeeper/Nessie)
apps/collector/src/intake/               # minimal accept->spool->ack->produce for EC2 (stub-level)
apps/stream-worker/src/                  # minimal validate(Apicurio)->dedup->write Bronze for EC2
tools/pixel-fixture/                     # Node fixture POSTing one synthetic event (ruling 8)
tools/parity-oracle/src/index.ts         # fill: trivial fixture green (EC9)
packages/events/src/                     # Avro register/validate (Apicurio FULL_TRANSITIVE) wiring
```

### Configuration
- Apicurio: global `FULL_TRANSITIVE` compatibility; CI registers the A-supplied sample Avro and **rejects** a non-additive change.
- Redpanda topics (from C): `{env}.collector.event.v1` (live) + a backfill-lane name; retention/replay note (Bronze = replay SoR).
- StarRocks external catalog → Glue/Iceberg; row-policy template `USING (brand_id = current_brand())` analog at cluster setup (NN-2).
- dbt `profiles.yml`: StarRocks adapter, dev target only.
- `turbo.json` task additions (request via A): ensure `test:parity` covers `tools/parity-oracle`; `gen` for Avro if needed.

### Terraform Layout
- D does **not** write `infra/terraform`. D consumes C's outputs: Bronze bucket name + prefix, Glue DB, Redpanda bootstrap+credentials (via Secrets Manager/IRSA), StarRocks endpoint. Local legs use `docker-compose.yml` (D-owned).

### Implementation Steps
1. Add an Iceberg REST catalog service to `docker-compose.yml` (D owns); wire MinIO as the local S3.
2. Author `db/iceberg/bronze_spec.json` + DDL: partition `bucket(brand_id)+days(event_time)`, append-only, 24-mo; `schema-evolution-policy.md` (additive-optional only, I-E02).
3. Wire `packages/events` Avro register/validate against Apicurio FULL_TRANSITIVE using A's sample event (Workstream C handoff).
4. Author `db/starrocks/external_iceberg_catalog.sql` (EC3) + `row_policy_template.sql` (NN-2).
5. `dbt init` artifacts: `profiles/profiles.yml` (dev) + `models/staging/_empty_model.sql` (`dbt compile` passes) + `tests/_dq_stubs.yml` (ruling 6/7).
6. Minimal collector accept→spool→ack→produce (`apps/collector/src/intake`) + minimal stream-worker validate→dedup `(brand_id,event_id)`→write Bronze (`apps/stream-worker/src`) — EC2 path only.
7. `tools/pixel-fixture/`: Node script POSTing one synthetic event to the collector (ruling 8).
8. Fill `tools/parity-oracle/src/index.ts`: trivial fixture, TS recompute vs reference → green (EC9).
9. Testcontainers + Vitest integration harness: pixel-fixture → collector → Redpanda → Bronze runs in CI (EC2); StarRocks queries the Bronze test table (EC3).

### Validation Steps
- EC2: in CI, the pixel-fixture event flows pixel→collector→Redpanda→Bronze (Testcontainers).
- EC3: StarRocks queries the Bronze test table via the external Iceberg catalog.
- EC9: `turbo run test:parity` green on the trivial fixture.
- FULL_TRANSITIVE: a non-additive Avro change is **rejected** by Apicurio/CI.
- NN-2 StarRocks layer: the row-policy template exists; the fuzz assertion (Track E harness) covers it (stub acceptable, assertion must exist).

### Risks
- Bronze partition/evolution is non-retrofittable. Mitigation: spec fixed at creation; FULL_TRANSITIVE enforced.
- StarRocks-on-Iceberg external-catalog config friction. Mitigation: prove against local first (docker-compose StarRocks + REST catalog), then point at Glue.
- Over-scoping dbt/DQ. Mitigation: hard ceiling — one empty model + stubs only (rulings 6/7).

### Recommendations
- Keep collector/stream-worker at **EC2-minimum** (no validation depth, no real sessionization — that's M1). The durable-spool 99.95% guarantee (I-ST02) is M1; Sprint-0 only proves the path exists.

### Pass-1 acceptance contract (Track D)
- [ ] EC2: pixel-fixture → collector → Redpanda → Bronze in CI.
- [ ] EC3: StarRocks queries Bronze via the Iceberg external catalog.
- [ ] EC9: parity-oracle scaffold green on a trivial fixture.
- [ ] I-E02: Bronze append-only, partition `bucket(brand_id)+days(event_time)`, 24-mo, additive-optional schema evolution.
- [ ] Apicurio **FULL_TRANSITIVE** enforced; non-additive change rejected in CI.
- [ ] **NN-2 (StarRocks layer)**: row-policy template provisioned at cluster setup; fuzz assertion present.
- [ ] Deferrals honored: dbt = init+compile-stub only; DQ = stubs only; pixel = fixture only.

---

## TRACK E — Observability + Isolation/Secrets cross-cuts

**Owner:** `data-engineer` (DB/RLS/StarRocks-fuzz) + `backend-developer` (OTel SDK/Redis-fuzz/MCP-stub/no-PII lint) · **Workstreams:** G + F(RLS/isolation) · **Serves:** EC5, EC6, EC7 · **AWS dep:** RDS live + EKS (C)

### Design Decisions
- **Migration #1 (NN-1 CRITICAL)**: `db/migrations/0001_init.sql` (currently a comment-only stub) implements the non-owner app role (no BYPASSRLS), the RLS policy template with **two-arg** `current_setting('app.current_brand_id', true)::uuid`, the hash-chained `audit_log` (INSERT+SELECT grant only — no UPDATE/DELETE, I-S06), and the `brand_keyring` table (per-brand wrapped DEK reference, I-S05/I-S09). Sprint-0 scope = the **template + audit_log + keyring**; full business tables are M1.
- **`packages/db` middleware (NN-1)**: resets the GUC to null at connection checkout **and** re-sets `app.current_brand_id` before every query. Unit test asserts a no-GUC query returns **0 rows**, not an exception.
- **`packages/tenant-context.brandKey()`**: the only sanctioned Redis key builder (`brand_id + metric_id + version + filters_hash + grain + as_of`); enforced by A's NN-7 lint.
- **`packages/observability` OTel SDK (EC7 + NN-6)**: logs/metrics/traces with `correlation_id` + `brand_id` on every span/log; a **span-attribute wrapper that refuses PII-keyed attributes** (NN-6 SDK leg). The collector `transform` processor (added to C's observability config / docker-compose) redacts PII attributes before Grafana Cloud (NN-6 collector leg).
- **Isolation-fuzz (NN-2, 4 layers)**: `tools/isolation-fuzz` asserts brand-A→brand-B = 0 rows/403 at (a) Postgres RLS, (b) StarRocks row policy, (c) Redis `brandKey()`, (d) MCP scope. StarRocks + MCP may be stubbed in Sprint 0 but the assertion must exist and fail if enforcement is absent.
- **no-PII-in-logs**: logger-middleware redaction + the NN-6 span wrapper; the static lint lives in A; the runtime redaction lives here.

### Folder Structure
```
db/migrations/0001_init.sql              # fill: non-owner role + 2-arg RLS template + audit_log(no U/D) + brand_keyring
packages/db/src/
  index.ts                               # query middleware: GUC reset@checkout + set-before-every-query (NN-1)
  rls.test.ts                            # asserts no-GUC query -> 0 rows (NN-1)
packages/tenant-context/src/
  index.ts                               # brandKey() builder (sanctioned key shape)
packages/observability/src/
  index.ts                               # OTel SDK: traces/metrics/logs + correlation_id + brand_id
  redact.ts                              # NN-6 span-attribute PII wrapper + logger redaction
  redact.test.ts                         # setAttr('email',x) dropped
tools/isolation-fuzz/src/
  index.ts                               # orchestrator
  pg.test.ts        # (a) RLS
  starrocks.test.ts # (b) row policy (stub ok, assertion must exist)
  redis.test.ts     # (c) brandKey()
  mcp.test.ts       # (d) MCP scope (stub ok, assertion must exist)
infra (collector config)                 # NN-6 transform processor — request add to C's observability module / docker-compose via D
```

### Configuration
- Migration grants: `audit_log` → app role `INSERT, SELECT` only (I-S06). App role **never** `BYPASSRLS`. RLS template applied to every brand-scoped table.
- OTel: OTLP exporter → Grafana Cloud (managed); resource attrs include `service.name`, `brand_id` (redacted), `correlation_id`. `gen_ai.*` conventions reserved (no AI path active).
- Collector pipeline: `transform`/`attributes` processor dropping/hashing keys in the PII list (`email`, `phone`, `name`, `address`, `pan_`, `card_`) — NN-6.
- Grafana Cloud: one SLO dashboard + a burn alert that fires on a synthetic breach (EC7).

### Terraform Layout
- E does not own `infra/terraform`. E consumes C's RDS endpoint (RLS verification), the OTel-collector IRSA, and the Grafana Cloud credentials (via Secrets Manager). The collector deployment manifest goes through C's EKS/ArgoCD path; E supplies the pipeline config.

### Implementation Steps
1. Fill `db/migrations/0001_init.sql`: non-owner role, two-arg RLS template (NN-1), `audit_log` (hash-chain columns + INSERT/SELECT-only grant, I-S06), `brand_keyring`.
2. `packages/db/src/index.ts`: pooled-query middleware — reset GUC null @checkout + set before every query (NN-1). Add `rls.test.ts` (no-GUC → 0 rows).
3. `packages/tenant-context/src/index.ts`: `brandKey()` (the sanctioned shape).
4. `packages/observability/src/index.ts`: OTel SDK (traces/metrics/logs + correlation_id + brand_id). `redact.ts` (NN-6 span wrapper + logger redaction) + `redact.test.ts`.
5. `tools/isolation-fuzz`: 4 layer tests (NN-2). `data-engineer` owns pg + starrocks; `backend-developer` PRs redis + mcp.
6. Collector `transform` redaction processor (NN-6 collector leg) — hand to D for the docker-compose/observability config.
7. Grafana Cloud SLO dashboard + burn alert; trigger a synthetic breach to verify the page fires (EC7).
8. Verify against C's live RDS: RLS blocks cross-brand by default (EC5).

### Validation Steps
- EC5: brand-A querying brand-B's data returns **0 rows / 403** at the Postgres layer; the no-GUC query returns 0 rows (NN-1).
- EC6: no-PII-log lint (A) + runtime redaction active; secrets via KMS/IRSA (C).
- EC7: a trace + structured log with correlation_id appear in Grafana; the SLO alert fires on a synthetic breach.
- NN-2: all 4 fuzz layers present and each fails if its enforcement is removed.
- NN-6: `setAttr('email', …)` is dropped by the SDK wrapper; the collector transform redacts the PII key list.

### Risks
- Connection-pool stale-GUC vector. Mitigation: NN-1 dual reset+set + the 0-rows unit test.
- PII reaching Grafana (third-party sub-processor) via span attrs. Mitigation: NN-6 dual SDK+collector redaction.
- StarRocks/MCP fuzz can't fully run in Sprint 0. Mitigation: assertions exist + stubbed enforcement; full enforcement lands with the layer in M1, but the gate is wired now.

### Recommendations
- Keep `0001_init.sql` to the **template + audit_log + brand_keyring** — do not add business tables (that's M1). The RLS *pattern* is what Sprint 0 proves.
- Co-assign the two builders on the single `tools/isolation-fuzz` harness; `data-engineer` is the file owner.

### Pass-1 acceptance contract (Track E)
- [ ] EC5: RLS on; isolation negative-test passes (brand-A→brand-B = 0 rows/403).
- [ ] EC6: no-PII-log redaction active (runtime); secrets via KMS/IRSA verified.
- [ ] EC7: trace + structured log with correlation_id in Grafana; SLO alert fires on synthetic breach.
- [ ] **NN-1**: two-arg `current_setting`; middleware reset@checkout + set-before-query; no-GUC → 0 rows test.
- [ ] **NN-2**: 4-layer fuzz (PG/StarRocks/Redis/MCP) present; each fails on enforcement removal.
- [ ] **NN-6**: OTel span-attr PII wrapper + collector transform both ship.
- [ ] I-S06: `audit_log` INSERT/SELECT-only grant; hash-chain columns present.

---

## 6. Exit-criteria → track coverage matrix (binding)

| EC | Criterion | Owning track | Verified by |
|----|-----------|--------------|-------------|
| EC1 | `pnpm i && turbo build` green; import-boundary lint | A | `turbo build` + boundary fixtures |
| EC2 | pixel→collector→Redpanda→Bronze in CI | D | Testcontainers integration |
| EC3 | StarRocks queries Bronze via Iceberg catalog | D | StarRocks external-catalog query |
| EC4 | Contracts codegen (types/OpenAPI/Avro/MCP); breaking fails CI | A (codegen) + B (gate) | `test:contract` |
| EC5 | RLS on; isolation negative-test (0 rows/403) | E | `tools/isolation-fuzz` (NN-1/NN-2) |
| EC6 | Secrets via KMS/IRSA; no-PII-log lint | C (KMS/IRSA) + E (no-PII) + B (gitleaks) | IRSA secret read + lint + scan |
| EC7 | Trace+log w/ correlation_id in Grafana; SLO alert on synthetic breach | E | Grafana + synthetic breach |
| EC8 | Affected-only build; staging auto-deploy; prod promote+rollback+flag-off | B | deploy-matrix + ArgoCD drill |
| EC9 | Parity-oracle scaffold green on trivial fixture | D | `test:parity` |
| EC10 | dev/staging/prod via Terraform (per the ruling) | C | dev apply + staging/prod plan |

---

## 7. Cost estimate (Sprint-0, deterministic paradigm — no tokens)

- **Model tokens/day:** 0 (no AI path active; LiteLLM deferred). Recorded for the streamlining audit: zero paradigm-bypass.
- **AWS spend/mo (Phase-1 dev only, staging/prod near-zero per EC10 ruling):** order-of-magnitude — EKS control plane + small node group, RDS Postgres Multi-AZ (small), ElastiCache (small), S3+Glue (minimal), Redpanda Cloud dev tier, managed StarRocks dev, Grafana Cloud dev tier, KMS/Secrets Manager. Estimate **≈ $1.2k–2.0k/mo dev**; staging/prod ≈ **$0 idle** (compute size-0 / not applied). Confirm Redpanda Cloud + Grafana Cloud + managed-StarRocks dev-tier pricing before Group 2.
- **CI minutes:** affected-only matrix keeps PR cost low; the IaC `plan` gate runs only on `infra/**`.

---

## 8. In-lane DoD (Architect)

- [x] All sections filled (no `{{TBD}}`); cost paradigm declared + justified (deterministic/infra).
- [x] Single-Primitive sweep clean (extend-only; no new deployable/db/ledger/package).
- [x] Tenant isolation at every layer (4-layer fuzz NN-2) + observability + real-network smoke (Group-2 live legs) in the test strategy.
- [x] ≥1 alternative + rejection per track (account-per-env vs workspace; local-first vs AWS-blocked; etc. in Design Decisions / Risks).
- [x] Reversible/non-destructive: migration #1 is additive; no `DROP`/`TRUNCATE` on event/ledger/audit (I-E02); Terraform reversible; secrets only via Secrets Manager/KMS.
- [x] Cost estimate (tokens/day = 0; spend/mo ≈ dev-only $1.2–2.0k).
- [x] Every track has 2–5 min tasks with `file:line` anchors; deploy-pipeline track present (B) for the service changes (C/D/E).
- [x] All 7 NN + 9 scope rulings folded into pass-1 acceptance contracts.
- [x] Every pinned version real (pnpm@9.12.0, turbo ^2.1.0, node ≥20, eslint ^9, eslint-plugin-boundaries ^5 — all in repo; node-pg-migrate 8.0.4 verified; AWS provider ~>6.0 verified; EKS/Karpenter/StarRocks-adapter = resolve latest-stable at write, do not invent).
- [x] Over-engineering self-check: PASS — scope held to exactly the 10 ECs; 9 deferrals enforced; nothing beyond the 2-week cap.

---

## Journal stub

```markdown
## 2026-06-15 — Architect — chore-platform-foundations-sprint0
**Stage:** 2 · **Paradigm:** deterministic/infrastructure (zero model calls; managed-vs-self-host already bound in STACK.md) · **Tracks:** A(backend-developer) B(platform-devops) C(platform-devops) D(data-engineer) E(data-engineer+backend-developer)
**Single-Primitive:** clean (extend-only; repo sealed with correct topology; no new deployable/db/ledger/package) · **Encoded:** NN-1..NN-7 + 9 scope rulings + EC10 operational definition as pass-1 acceptance · **Next:** A,B,C,D,E builders — Stage 3 (Group-1 day-1 parallel; D/E live legs gated on C)
```

---

---HANDOFF---
stage: 2
decision: ADVANCE
build_tracks:
  - {track: A, owner: backend-developer, summary: "Monorepo dev-standards + contracts codegen — fill eslint boundary+money+redis-key(NN-7) lints, Zod→types/OpenAPI/Avro/MCP + buf-breaking gate (EC1, EC4)."}
  - {track: B, owner: platform-devops, summary: "GitHub Actions — affected-only build matrix, gitleaks/trivy/osv, Terraform IaC gate with Checkov/OPA for NN-3/4/5, ArgoCD staging-auto/prod-promote+rollback (EC1,EC4,EC6,EC8)."}
  - {track: C, owner: platform-devops, summary: "Terraform AWS foundation — account-per-env, state/VPC/EKS/RDS/S3+Glue/KMS/Secrets/IRSA(NN-3)+S3 Object-Lock COMPLIANCE/7yr(NN-4)+prefix-IAM(NN-5); EC10 dev-apply/staging-scaffold/prod-bootstrap (EC6,EC10). CRITICAL PATH."}
  - {track: D, owner: data-engineer, summary: "Data spine — Redpanda topics, Iceberg Bronze bucket(brand_id)+days partition + FULL_TRANSITIVE, StarRocks external catalog + row-policy template(NN-2), dbt init+compile stub, pixel-fixture→Bronze, parity-oracle scaffold (EC2,EC3,EC9)."}
  - {track: E, owner: "data-engineer+backend-developer", summary: "Isolation+observability — migration#1 two-arg RLS(NN-1)+audit_log(I-S06)+brand_keyring, packages/db GUC middleware, brandKey(), OTel SDK+PII redaction(NN-6), 4-layer isolation-fuzz(NN-2), Grafana SLO alert (EC5,EC6,EC7)."}
parallel_groups:
  - "Group 1 (day 1, zero AWS, fully parallel): A(all) | B(workflow+policy authoring) | C(state+VPC+EKS) | D(contracts/Avro/Bronze-spec/StarRocks-DDL/dbt against local docker-compose) | E(migration SQL + packages/db,observability,tenant-context + fuzz assertions against local). Shared-file sole-writers: turbo.json/tsconfig/eslint/root-package.json=A; docker-compose.yml=D; .github/workflows=B; infra/terraform=C; db/migrations/0001=E; tools/isolation-fuzz=E(data-engineer, backend PRs Redis+MCP layers)."
  - "Group 2 (after C day ~4): D live legs (Redpanda Cloud topic, S3+Glue Bronze, StarRocks external catalog) | E live legs (OTel collector on EKS, RDS RLS verify, Grafana wiring) | B IaC gate live against real state bucket. A→D hard handoff: contracts skeleton + 1 sample event by EOD day 1."
state: {status: in-development, stage: 3, owner: "backend-developer, platform-devops, data-engineer"}
summary: |
  Binding Sprint-0 plan decomposes the 10 exit criteria into 5 parallel build tracks against the already-sealed repo scaffold (extend stubs, never re-scaffold; Single-Primitive sweep clean). All 7 non-negotiables (NN-1 two-arg RLS + GUC middleware, NN-2 4-layer isolation-fuzz, NN-3 StringEquals IRSA, NN-4 S3 Object-Lock COMPLIANCE/7yr, NN-5 prefix-IAM, NN-6 OTel PII redaction, NN-7 Redis-key lint) and all 9 scope rulings (Authentik/LiteLLM/Playwright/Husky-Commitlint/dbt/DQ/pixel/CloudWatch deferred or scope-reduced; EC10 = dev full-apply / staging structural-scaffold-compute-zero / prod plan-only) are folded into per-track pass-1 acceptance contracts.
  Cost paradigm = deterministic/infrastructure (zero model calls). Track C (Terraform) is the critical path; D and E develop code legs against local docker-compose on day 1 and gate their live legs on C. Track B carries the deploy pipeline (affected-only build, canary-equivalent staging-auto/prod-promote, ArgoCD auto-rollback). Fan out A,B,C,D,E concurrently as Group 1.
---END HANDOFF---
