# Platform/SRE — Journal

> Append-only. See /Users/rishabhporwal/.claude/plugins/cache/engineering-os/engineering-os/2.3.1/docs/role-empowerment-model.md for entry shape.

## 2026-06-15T07:19:27Z — system — bootstrap
**Action:** Journal initialized by /eos-init on 2026-06-15T07:19:27Z.

## 2026-06-15T19:19:40Z — system — Stakeholder approval received (feat-m1-app-foundation)
**Action:** Stakeholder approved M1 Application Foundation at the Stage-7 gate. Status → approved, stage → 8, owner → platform-devops. Stage-6 PASS/GO; Security r3 + QA r3 PASS (independently re-run on live Postgres). 0 open CRITICAL/HIGH/MEDIUM. Canon-4 roles (Viewer→manager) + app-native auth confirmed. Deploy VETO gate next, then Stage 8 commit on a feature branch (never master) folding in dev-config fixes.

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

## 2026-06-15T19:30:00Z — Platform/SRE — feat-m1-app-foundation
**Stage:** 8 · **Affected:** apps/core, apps/web, db/migrations, packages/{audit,contracts,db,pixel-sdk}, tools/isolation-fuzz · **Canary:** N/A (Phase-1 dev-only) · **Monitor:** N/A (Phase-1 dev-only)
**Staging smoke:** N/A (no live infra in Phase 1) · **Next:** PR review + Stakeholder merge decision

**Ship summary:**
- Branch: `feat/m1-app-foundation` — created off `fix/web-bff-proxy-api-prefix` (carries BFF /api-prefix fix dc3fd47)
- Commit: `55e4d68` — 181 files, 24000 insertions; full M1 vertical slice
- Pushed to `origin` (https://github.com/Rishabhporwal/Brain-V4.git): YES
- PR: NOT opened via CLI (gh unauthenticated); manual URL: https://github.com/Rishabhporwal/Brain-V4/pull/new/feat/m1-app-foundation
- Phase-1 dev-only: no prod infra, no canary/bake/rollback, no staging smoke against live systems
- Reversibility: `git revert 55e4d68` on feature branch, or simply do not merge PR

**Dev-config folded in:** turbo globalPassThroughEnv, `next dev -p 3000`, docker-compose MinIO healthcheck, BFF /api-prefix rewrite

**11 LOW residuals carried forward** (0 CRITICAL/HIGH/MEDIUM):
1. Rate-limit on auth endpoints — backend-engineer — M2
2. Email enumeration timing jitter — backend-engineer — M2
3. Shopify webhook replay window — backend-engineer — M2
4. OAuthStateNonce DB expiry — backend-engineer — M2
5. InProcessOAuthStateStore not HA — platform-devops — M2 infra
6. SES sandbox → production — backend-engineer — pre-launch
7. Pixel SDK CSP nonce injection — frontend-engineer — M2
8. Dashboard polling hardcoded — frontend-engineer — M2
9. RBAC gap on BFF routes — backend-engineer — M2
10. Missing invite-accept integration test — qa — M2
11. MinIO BYOC trigger evaluation — platform-devops — M2 infra review

## 2026-06-16T04:06:44Z — system — Stakeholder approval received (feat-access-onboarding-flow)
**Action:** Approved at Stage-7 gate. Final PASS/GO; Security+QA PASS (2 bounce rounds). 11/11 ACs MET, 0 CRITICAL/HIGH. Status → approved, stage → 8, owner → platform-devops. Deploy VETO gate next, then Stage 8 commit on feature branch + PR.

## 2026-06-16T05:00:00Z — Platform/SRE — feat-access-onboarding-flow
**Stage:** 8 · **Affected:** apps/core, apps/web, db/migrations (0010-0012), packages/contracts · **Canary:** N/A (Phase-1 dev-only) · **Monitor:** N/A (Phase-1 dev-only)
**Staging smoke:** N/A (no live infra in Phase 1) · **Next:** PR review + Stakeholder merge decision

**Ship summary:**
- Branch: `feat/access-onboarding-flow`
- Commit: `44fba58` — 72 files, +7870 / -297; full Access & Onboarding vertical slice
- Pushed to `origin` (https://github.com/Rishabhporwal/Brain-V4.git): YES
- PR: NOT opened via CLI (gh unauthenticated); manual URL: https://github.com/Rishabhporwal/Brain-V4/pull/new/feat/access-onboarding-flow
- Phase-1 dev-only: no prod infra, no canary/bake/rollback, no staging smoke against live systems
- Reversibility: `git revert 44fba58` on feature branch, or close PR without merging

**Gates:** Security PASS · QA PASS · Final Review PASS/GO · Stakeholder APPROVED · Deploy VETO EXIT 0 · 11/11 ACs MET · 0 open CRITICAL/HIGH · 2 bounce rounds

**4 LOW residuals carried forward (0 CRITICAL/HIGH/MEDIUM):**
1. COMMIT_WAIT CSRF hardening deferred — backend-engineer — M2
2. OTel trace instrumentation not wired on auth routes — platform-devops — M2 infra
3. Integration-selection downstream connectors not implemented — backend-engineer — next sprint
4. E2E smoke happy-path only; invite-expiry + replay-attack flows unit-only — qa — M2

**Migration deploy order (when infra exists):** migrate (0010→0011→0012) → core → web

## 2026-06-16T11:00:00Z — Stakeholder — feat-multi-brand
**Action:** Stakeholder approval received. status -> approved, stage 8. Deploy order: migrate(0013) -> core -> web. QA-3 + SEC-MB-4 accepted as tracked tech-debt.

## 2026-06-16T11:30:00Z — Platform/SRE — feat-multi-brand
**Stage:** 8 · **Affected:** db/migrations/0013, apps/core, apps/web · **Canary:** N/A (Phase-1 dev-only; Phase-4-deferred per ADR-010) · **Monitor:** N/A (Phase-1 dev-only)
**Staging smoke:** Core liveness verified (localhost:3001/health ok); committed switch-brand.live 4/4 + isolation-fuzz 11/11 + critical-paths 22/22 are the bake-window proxy · **Next:** PR review + Stakeholder merge decision

**Ship summary:**
- Branch: `feat/multi-brand` (HEAD `58c425e`)
- Commits: `9b87621` (Track B frontend) + `bcfee81` (BOUNCE r1 fixes) + `58c425e` (backend spine: 0013 + switchBrandContext + bff route + brand-summary)
- Pushed to origin: NOT YET (branch is local; PR to be opened manually — gh CLI unauthenticated)
- PR: NOT opened via CLI; manual URL: https://github.com/Rishabhporwal/Brain-V4/pull/new/feat/multi-brand
- Phase-1 dev-only: no prod infra, no canary/bake monitor, no ArgoCD/EKS

**Migrate-first ordering honored:** 0013 (`brand_self_read | SELECT` + `brand_isolation | ALL`) verified live in `brainv3-postgres-1` pg_policies before evaluating build gate. No re-apply needed (already applied). In real infra: Argo Workflow `migrate` job is prerequisite to ArgoCD `core` Application sync.

**Build gate results:**
- @brain/core typecheck: EXIT 0
- @brain/web typecheck: EXIT 0
- @brain/core build (tsc -b): EXIT 0
- @brain/web build (next build, 21/21 pages): EXIT 0

**Rollback handle:** `DROP POLICY brand_self_read ON brand` (additive, safe) + ArgoCD rollback `core` + `web` to prior revision. No data migration to reverse (I-E02 honored, 0013 is CREATE POLICY only).

**Tech-debt carried:** QA-3 (audit_log.correlation_id, MED), SEC-MB-4 (audit-before-mint order comment, LOW), OTel trace instrumentation on auth routes (M2).

## 2026-06-16T14:45:00Z — Stakeholder — feat-members-team-management
**Action:** Approval received. status->approved, stage 8. Deploy: migrate(0014)->core->web.

## 2026-06-16T16:40:00Z — Stakeholder — feat-data-plane-ingest-spine
**Action:** Approval received. status->approved, stage 8.

## 2026-06-16T18:10:00Z — Stakeholder — feat-identity-graph
**Action:** Approval received. status->approved, stage 8.

## 2026-06-17T01:00:00Z — Stakeholder — feat-realized-revenue-ledger
**Action:** Approval received. status->approved, stage 8.

## 2026-06-17T00:32:00Z — Platform/SRE — feat-realized-revenue-ledger
**Stage:** 8 · **Affected:** db/migrations/0018+0019, apps/core (measurement module), apps/stream-worker (revenue-finalization job), packages/money (roundToMinorBankers) · **Canary:** N/A (Phase-1 dev-only; ADR-010 Phase-4 deferral) · **Monitor:** N/A (Phase-1 dev-only)
**Staging smoke:** 32/32 ledger live tests green under brain_app (non-superuser; 134/134 core suite) · **Next:** PR merge (manual — gh unauthenticated) after identity-graph merges; F-SEC-02/03 fix before Phase-2

**Ship summary:**
- Branch: `feat/realized-revenue-ledger` (stacked on `feat/identity-graph`)
- HEAD commit: `353bfd6` — fix(F-SEC-01): SECURITY DEFINER list_active_brand_ids() + wire finalization job
- Pushed to origin: NOT YET (branch local; gh CLI unauthenticated)
- PR: NOT opened via CLI; manual compare URL: https://github.com/Rishabhporwal/Brain-V4/compare/feat/identity-graph...feat/realized-revenue-ledger
- Merge order: data-plane-ingest-spine → identity-graph → realized-revenue-ledger (do not merge out of order)
- Phase-1 dev-only: no prod infra, no canary/bake/rollback, no ArgoCD/EKS
- 1 bounce: F-SEC-01 HIGH (finalization job no-ops; fixed via 0019 + 353bfd6)

**Migration verify (0018 + 0019):**
- realized_revenue_ledger: relrowsecurity=t, relforcerowsecurity=t
- realized_gmv_as_of: prosecdef=f (SECURITY INVOKER — correct)
- list_active_brand_ids: prosecdef=t, proconfig={search_path=public} — search-path hijack prevention confirmed
- brain_app grants: SELECT + INSERT only (NO UPDATE/DELETE) — append-only by GRANT confirmed
- All 3 migration assertions green (NN-1 two-arg, append-only-grant, no-float-SQL)

**Build gate:**
- @brain/money: typecheck PASS, build PASS
- @brain/core: typecheck PASS, build PASS (fresh)
- @brain/stream-worker: typecheck PASS, build PASS (fresh)
- @brain/contracts: typecheck PASS, build PASS

**Smoke (bake proxy):**
- 32/32 ledger live tests PASS (81ms) under non-superuser brain_app
- 134/134 full core suite PASS
- Pre-existing stream-worker bronze.e2e.test.ts Redis failure (ioredis offline-queue / Kafka init path) — not a regression from this branch

**Rollback:** `DROP TABLE IF EXISTS realized_revenue_ledger` + 3 functions + 3 brand columns. Rebuildable from Bronze (M1 synthetic/internal, no external consumer yet).

**Tech-debt carry-forward:**
- F-SEC-02 (GetRealizedGmvAsOf GUC-reset defense-in-depth) — before Phase-2
- F-SEC-03 (finalization job financial logging scope) — before prod scale
- F-QA-03 (Stryker mutation testing) — before next ledger slice
- Adopt-rule: cross-tenant system jobs MUST use list_active_brand_ids() (2nd occurrence — Stakeholder /adopt-rule pending)
- phone-guard-reeval: identity slice should adopt list_active_brand_ids() for enumeration
- billing_run + fx_rate: explicit non-goals, Phase-2+

## 2026-06-17T02:15:00Z — Stakeholder — feat-metric-engine-parity
**Action:** Approval received. status->approved, stage 8.

## 2026-06-17T02:20:00Z — Platform/SRE — feat-metric-engine-parity
**Stage:** 8 · **Affected:** @brain/metric-engine, @brain/tool-parity-oracle (in-process library + CI runner — no new deployable) · **Canary:** N/A (library change; ships as part of core next image) · **Monitor:** parity gate is the observability surface (CI-blocking)

**Migration 0020 verified:** `provisional_gmv_as_of` present, `prosecdef=f` (SECURITY INVOKER). Applied by builder in Slice 2. Idempotent `CREATE OR REPLACE`. Down = `DROP FUNCTION IF EXISTS provisional_gmv_as_of(uuid, date)`.

**Build gate:** typecheck @brain/metric-engine PASS, @brain/tool-parity-oracle PASS, @brain/core PASS, @brain/money PASS. 16 tasks EXIT 0.

**Parity gate: GREEN 16/16** (tolerance 0, `bigint`-exact, live Postgres). RED proof confirmed: 1-minor-unit perturbation → `FAIL: TS=50001 REF=50000 delta=1 > tolerance=0`. M1 'parity oracle green' exit criterion MET.

**CI smoke:** pr.yml verified — `services: postgres:16` (SEC-001 fix real), `BRAIN_APP_DATABASE_URL` wired, `brain_app NOBYPASSRLS` provisioned, `pnpm migrate:up` before `test:parity --affected` (blocking, no continue-on-error). Turbo dep edge: `test:parity dependsOn @brain/metric-engine#build` — confirmed engine changes trigger oracle in affected set.

**PR:** gh CLI unauthenticated. Manual compare URL: https://github.com/Rishabhporwal/Brain-V4/compare/master...feat/metric-engine-parity (clean off master, not stacked). Branch not pushed yet (phase-1 dev-only).

**Rollback:** `DROP FUNCTION IF EXISTS provisional_gmv_as_of(uuid, date);` + revert core image to prior SHA.

**Tech-debt carry-forward:** F-SEC-02 P2 must-fix-before-Phase-2 (old GetRealizedGmvAsOf GUC-reset; new engine path correct-by-construction); QA-F1/QA-F2 LOW deferred M2; /adopt-rule list_active_brand_ids cross-tenant system jobs (2nd occurrence).

**Next:** monitor branch; when merging to master apply 0020 migration to prod DB first; Phase-2 requires F-SEC-02 fix on GetRealizedGmvAsOf.

## 2026-06-17T07:40:00Z — Platform/SRE — feat-analytics-api-dashboard
**Action:** Stakeholder approval received (approve + deploy now). Advancing to Stage 8 deploy.

## 2026-06-17T03:30:00Z — Platform/SRE — feat-analytics-api-dashboard
**Stage:** 8 · **Affected:** @brain/core (analytics module + BFF route), @brain/web (realized-revenue card + client + hook + formatter) · **Canary:** N/A (Phase-1 dev-only; ADR-010 Phase-4 deferral) · **Monitor:** e2e smoke proxy (4/4 PASS)
**Staging smoke:** health 200; e2e 4/4 PASS (24.4s); unauthenticated probe 401; no 5xx observed · **Next:** PR merge (manual — gh unauthenticated); M1 complete

**Ship summary:**
- Branch: `feat/analytics-api-dashboard` (HEAD `c0e0ec9`)
- Key analytics-api-dashboard commits: `a8f3361` (client+hook+formatter), `18c6d18` (card+mount), `4789680` (e2e), `9616d11` (live tests)
- Pushed to origin: YES (per branch push history)
- PR: NOT opened via CLI (gh unauthenticated); manual URL: https://github.com/Rishabhporwal/Brain-V4/compare/master...feat/analytics-api-dashboard
- Phase-1 dev-only: no prod infra, no canary/bake/rollback, no ArgoCD/EKS

**Migration status:** analytics-api-dashboard slice adds ZERO new migrations (read-only feature, D-11 confirmed). Migration 0020 (`provisional_gmv_as_of`) is present in branch from prior metric-engine slice — already applied to dev DB (`prosecdef=f`, SECURITY INVOKER confirmed via docker postgres).

**Build gate:**
- @brain/core typecheck: EXIT 0
- @brain/web typecheck: EXIT 0
- No restart/rebuild needed — dev servers hot-reload the branch code

**Smoke (bake proxy):**
- `GET /health` → 200 OK: `{"status":"ok","version":"0.1.0","timestamp":"2026-06-17T03:22:19.736Z"}`
- `GET /api/v1/dashboard/realized-revenue` (unauthenticated) → 401 (not 5xx)
- Playwright e2e `realized-revenue.spec.ts`: 4/4 PASS in 24.4s
  - Test 1: no-data state — freshly-onboarded brand → "No data yet" card PASS (6.2s)
  - Test 2: real-number — 123450 INR → ₹1,234.50 rendered PASS (5.9s)
  - Test 3: provisional separate, never blended PASS (6.0s)
  - Test 4: BFF envelope `{request_id,data}` unwrap correct PASS (5.9s)
- No 5xx on dashboard surface during smoke window

**Four M1 invariants confirmed live:**
1. Honest-empty-state: no finalized rows → state='no_data', never bare 0 (Test 1)
2. Sole-read-path: engine-only numbers, no ad-hoc SUM (Test 2 + grep clean per dev report)
3. No 9th envelope mismatch: `{request_id,data}` unwrapped correctly (Test 4)
4. Isolation under brain_app: 20/20 backend live tests in dev report; provisional never blended (Test 3)

**Rollback:**
- Code: `git revert a8f3361 18c6d18 4789680 9616d11` or close PR without merging
- No DB rollback needed (read-only feature, no schema changes)
- Feature flag: `beta.analytics_api_dashboard=false` per brand (≤60s) if infra live

**Tech-debt carry-forward:** LOW-SEC-001 (deferred), QA-F-002 (deferred), F-SEC-02 (before Phase-2), QA-3 (MED, M2)

**M1 STATUS: COMPLETE.** Reconciling realized-revenue number on screen with honest-empty-state signal. The M1 vertical spine (Bronze → identity → ledger → metric engine → Analytics API → dashboard) is fully realized.

## 2026-06-17T11:20:00Z — Platform/SRE — feat-connector-marketplace
**Action:** Stage 8 deploy bake SHIPPED. 6/6 marketplace e2e, typechecks clean, 0021 columns present, NN-2 clean, live Boddactive smoke connected/Healthy. Agent died on infra socket timeout mid-bake; completed inline by orchestrator (same gates). Branch→master merge done by Stakeholder (PR #29).
