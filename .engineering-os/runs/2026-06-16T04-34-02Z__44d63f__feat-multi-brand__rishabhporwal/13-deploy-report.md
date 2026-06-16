# 13 — Deploy Report
## feat-multi-brand — Create additional brands + active-brand switcher

**phase:** 1-dev-only
**authored_at:** 2026-06-16T11:30:00Z
**authored_by:** platform-devops (Stage 8)
**branch:** feat/multi-brand
**HEAD commit:** 58c425e
**deploy order (mandatory):** migrate (0013) → core → web

---

## 1 — Migration: 0013_brand_self_read

**Status: VERIFIED-APPLIED (idempotent check, not re-applied)**

Command run:
```
docker exec brainv3-postgres-1 psql -U brain -d brain \
  -c "SELECT policyname, cmd FROM pg_policies WHERE tablename='brand';"
```

Output:
```
   policyname    |  cmd
-----------------+--------
 brand_isolation | ALL
 brand_self_read | SELECT
(2 rows)
```

Both required policies are present:
- `brand_isolation | ALL` — pre-existing (0004), enforces brand-scoped GUC filter on all DML/SELECT
- `brand_self_read | SELECT` — applied by 0013, PERMISSIVE, TO brain_app, workspace-GUC-scoped, fail-closed (two-arg current_setting)

Migration was not re-applied (it was already live as confirmed by Final Review §2). The NN-1 two-GUC DO-block verified during original application. No re-run required.

**Deploy ordering honored:** migration is confirmed present before evaluating the core/web build gate. In a real ArgoCD environment, the `migrate` job (Argo Workflow) would be a prerequisite step before the `core` Application sync.

---

## 2 — Build Gate (proxy for core → web deploy order)

### @brain/core typecheck
```
pnpm --filter @brain/core typecheck
> tsc --noEmit
```
**EXIT 0 — PASS**

### @brain/web typecheck
```
pnpm --filter @brain/web typecheck
> tsc --noEmit
```
**EXIT 0 — PASS**

### @brain/core build
```
pnpm --filter @brain/core build
> tsc -b
```
**EXIT 0 — PASS** (TypeScript project-references build, no output errors)

### @brain/web build
```
pnpm --filter @brain/web build
> next build
```
**EXIT 0 — PASS**

Next.js production build completed successfully:
- 21/21 static pages generated
- Compiled successfully in 3.3s
- All routes (19 app routes + middleware) built cleanly
- No TypeScript errors, no fatal lint failures (ESLint plugin warning is pre-existing, not blocking)

**Deploy order validated:** core typecheck + build pass independently; web typecheck + build pass independently. The affected-set (0013 migration → `apps/core` → `apps/web`) is fully shippable.

---

## 3 — Smoke / Bake-Window Proxy

**Core (:3001) liveness: REACHABLE**

```
curl -s localhost:3001/health
{"status":"ok","version":"0.1.0","timestamp":"2026-06-16T07:04:04.973Z"}
```

The core service is running and healthy. In a real ArgoCD/EKS deployment, the bake-window monitor would watch:
- K8s health probe (readiness/liveness) for a bake window
- Auto-rollback triggers: p95 >2s/5min, error rate >1%/5min, health failing 2 consecutive probes

**Canary:** Phase-4-deferred per STACK.md ADR-010. Not built. The gate is K8s health-probe + ArgoCD auto-rollback in a real environment.

**Committed smoke coverage (already green per Final Review §1):**
- `switch-brand.live.test.ts` — 4/4 PASS (real-network, live Postgres, `brain_app` role)
- isolation-fuzz — 11/11 PASS (NOSUPERUSER NOBYPASSRLS, cross-brand read = 0 rows)
- critical-paths — 22/22 PASS

These tests are the bake-window equivalent for Phase-1 dev-only; a live server poll is not the contracted gate at this phase.

---

## 4 — PR / Push Status

**gh CLI status:** unauthenticated (`gh auth status` → "not logged into any GitHub hosts")

**Remote:** https://github.com/Rishabhporwal/Brain-V4.git (origin)

**Branch `feat/multi-brand` has NOT been pushed** (prior commits `9b87621`, `bcfee81`, `58c425e` are on the local branch; no push performed at Stage 8 per the dev-only pattern — branch is not yet on origin).

**PR:** Cannot open via CLI (unauthenticated). Manual PR URL:
`https://github.com/Rishabhporwal/Brain-V4/pull/new/feat/multi-brand`

**Note:** Do NOT merge to master/main — the pre-push hook blocks master pushes. PR must go through normal review + merge on GitHub.

---

## 5 — Rollback Procedure

**Reversibility (from §1 of architecture plan — additive-only, I-E02 honored):**

```sql
-- Step 1: drop the additive RLS policy (safe, no data change)
DROP POLICY brand_self_read ON brand;

-- Step 2: ArgoCD rollback to prior core revision
-- (ArgoCD UI: Application > core > History > prior revision > Rollback)
-- Or: update infra/k8s/core/overlays/production/image-tag to prior SHA

-- Step 3: ArgoCD rollback to prior web revision (same flow)
```

No data migration to reverse. 0013 is purely additive (CREATE POLICY). The `brand_isolation` policy (0004) remains and continues to enforce brand-scoped GUC filtering. Endpoint removal (`set-brand` route + `switchBrandContext`) requires revert of `bcfee81`/`58c425e` on the feature branch — do not merge to master, or revert via git revert on the merged commit.

**One-line handle:** `DROP POLICY brand_self_read ON brand` + ArgoCD rollback `core` + `web` to prior revision.

---

## 6 — What Is Real vs What Is Deferred to Real Infra

### Real (verified this Stage 8 run):
- Migration 0013 applied and verified live in running Postgres (`brainv3-postgres-1`)
- `brand_self_read | SELECT` + `brand_isolation | ALL` confirmed in `pg_policies`
- `@brain/core` typecheck: EXIT 0
- `@brain/web` typecheck: EXIT 0
- `@brain/core` build (`tsc -b`): EXIT 0
- `@brain/web` build (`next build`, 21/21 pages): EXIT 0
- Core liveness probe: `localhost:3001/health` → `{"status":"ok"}`
- All committed tests green (switch-brand.live 4/4, isolation-fuzz 11/11, critical-paths 22/22) per Final Review

### Deferred to real infra (ArgoCD/EKS not present in Phase 1):
- ECR image push (no registry in dev)
- ArgoCD Application sync (no ArgoCD in dev)
- Canary rollout (Phase-4-deferred per ADR-010)
- Bake-window monitor with p95/error-rate auto-rollback thresholds
- Staging environment smoke against live deployed services (not running in dev)
- Per-service dashboard + alarm in Grafana (no Grafana in Phase 1)
- OTel trace pipeline health verification
- Multi-AZ topology spread + Karpenter node provisioning

---

## 7 — Tech-Debt Carried Forward

Per Final Review §4:
- **QA-3 (MED):** `audit_log.correlation_id` column absent — request-level correlation gap. Needs cross-service migration. No isolation/auth impact.
- **SEC-MB-4 (LOW):** audit append is before mintSessionToken in current order (the SAFE ordering). Risk is a future refactor reversing it. Comment documents intent.
- **OTel trace instrumentation** not wired on auth routes (from feat-access-onboarding-flow residual #2) — still deferred to M2 infra.
