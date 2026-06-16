# 13 — Deploy Report

| Field | Value |
|---|---|
| **req_id** | `feat-members-team-management` |
| **Stage** | 8 — Platform/SRE |
| **Branch** | `feat/members-team-management` |
| **HEAD commit** | `fcbc221` |
| **Phase** | `1-dev-only` (no live cloud infra; no ArgoCD/ECS; no canary rollout) |
| **Deploy ordered** | 2026-06-16T22:00:00Z |
| **Status** | **shipped** |

---

## 1. Migration — `0014_member_lifecycle.sql`

**Verify command:**
```
docker exec brainv3-postgres-1 psql -U brain -d brain -c \
  "SELECT indexname FROM pg_indexes WHERE tablename='invite' AND indexname LIKE '%pending%';"
```

**Result (pre-apply check):**
```
            indexname
---------------------------------
 invite_pending_org_email_uniq
 invite_pending_brand_email_uniq
(2 rows)
```

**Disposition:** `verified-applied` — both partial unique indexes already present from prior migration run; no re-apply needed. Idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS`). Supporting index `invite_status_org_idx` present via same migration.

**Rollback handle (I-E02 — zero data impact):**
```sql
DROP INDEX IF EXISTS invite_pending_org_email_uniq;
DROP INDEX IF EXISTS invite_pending_brand_email_uniq;
DROP INDEX IF EXISTS invite_status_org_idx;
```
Pure index drops; no column/data removed. Safe at any time.

---

## 2. Build Gate (core → web order)

### @brain/core typecheck
```
pnpm --filter @brain/core typecheck
> tsc --noEmit
EXIT 0
```

### @brain/core build
```
pnpm --filter @brain/core build
> tsc -b
EXIT 0
```

### @brain/web typecheck
```
pnpm --filter @brain/web typecheck
> tsc --noEmit
EXIT 0
```

### @brain/web build (Next.js)
```
pnpm --filter @brain/web build
> next build
Compiled successfully in 3.2s
21/21 static pages generated
EXIT 0
```

Notable routes built:
- `/settings/members` — 8.83 kB (the primary new surface, members lifecycle UI)

**Build gate: PASS (core EXIT 0, web EXIT 0)**

---

## 3. Smoke

| Check | Result |
|---|---|
| `curl localhost:3001/health` | HTTP 200 — core is live |
| Committed wire-smoke proxy | WIRE-1 (suspend→401), WIRE-2 (brand_admin→403), WIRE-3 (pending-list org-scoped) — all passed at commit `fcbc221` (QA delta verified) |
| Committed e2e proxy | `members-lifecycle.spec.ts` 4/4 standalone (invite→accept→role→suspend→reactivate→remove + revoke-pending) |
| D-11 false-negative guard | Non-zero pending rows asserted post-invite in e2e |

**Smoke disposition:** core liveness ok; committed wire-smoke + e2e are the bake-window proxy (phase 1-dev-only; no long-lived server started for this deploy step). No regressions; 69/69 vitest pass (6 files including NC-1..6 + 3 wire-smoke tests).

---

## 4. PR / Push Status

**gh CLI:** unauthenticated — `gh auth status` → "You are not logged into any GitHub hosts."

**Remote:** `origin https://github.com/Rishabhporwal/Brain-V4.git`

**Manual PR URL (compare):**
```
https://github.com/Rishabhporwal/Brain-V4/compare/feat/members-team-management
```

**STACKING NOTE (critical before opening PR):** `feat/members-team-management` is stacked on `feat/shopify-sync-validation` (verified: `git merge-base --is-ancestor 43ea557 HEAD` → true, per architect §D-5 + final review §5). `feat/shopify-sync-validation` must be **pushed and merged to master** before opening this PR cleanly, or the PR base must be explicitly set to `feat/shopify-sync-validation`. Opening against master with shopify-sync-validation un-merged will include all of that branch's commits in the diff. Recommend: merge shopify-sync-validation first, then open this PR targeting master.

---

## 5. Rollback Recipe

**Migration rollback:**
```sql
DROP INDEX IF EXISTS invite_pending_org_email_uniq;
DROP INDEX IF EXISTS invite_pending_brand_email_uniq;
DROP INDEX IF EXISTS invite_status_org_idx;
```

**Core rollback:** re-deploy previous core image (commit prior to `a525035`). Old code is forward-compatible with the indexes (they don't break existing INSERTs unless a true duplicate-pending exists; the pre-flight RAISE catches that before indexes are created).

**Web rollback:** re-deploy previous web image. New members UI (suspend/reactivate/pending-invites) is simply absent; no degraded-data risk.

**Phase-1 dev-only rollback (branch):**
```bash
git checkout feat/members-team-management
git revert <commit-range>
# or: hard-reset the branch to pre-feat commit
```

No live infra state was mutated beyond the DB indexes (already idempotent).

---

## 6. Deferred / Real-Infra Promotion Notes

| Item | Detail |
|---|---|
| **ArgoCD/ECS canary** | Not applicable in phase 1-dev-only. On promotion: deploy core image first (migration already applied), then web image; canary bake window with p95 >2s/5min + error rate >1%/5min auto-rollback alarms per standard. |
| **Auto-rollback alarm** | Composite alarm on `suspendUser` 5xx + p99 — wire to ArgoCD rollback hook on promotion. |
| **SEC-V1 tech-debt** | NC-4/NC-5 assertion queries read `app_user`/`user_session` via superuser pool; tighten to `brain_app`. Not a runtime cross-org leak. Backlog. |
| **F-QA-4 tech-debt** | `audit_log` lacks `correlation_id` column (pre-existing schema); needs a future migration. Backlog. |
| **F-QA-5 tech-debt** | Full e2e suite rate-limiter exhaustion (>10 registers/hr/IP); test-user-pool CI work needed. Backlog. |
| **PR base** | Must push/merge `feat/shopify-sync-validation` before a clean PR. |
| **Pushed** | false — branch not pushed (gh unauth). Push manually: `git push origin feat/members-team-management` then open PR at URL above. |
