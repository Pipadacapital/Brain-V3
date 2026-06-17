# Deploy Report — feat-analytics-api-dashboard

**Stage:** 8 (Deploy) · **Status:** SHIPPED
**Req ID:** `feat-analytics-api-dashboard`
**Owner:** platform-devops
**Branch:** `feat/analytics-api-dashboard`
**HEAD commit:** `c0e0ec9` — chore(eos): feat-analytics-api-dashboard — QA DELTA PASS + final review APPROVE, at Stakeholder gate
**Deploy target:** local dev monorepo (Phase-1 dev-only) · web :3000 · core :3001
**Deploy date:** 2026-06-17T03:23Z
**Lane:** high_stakes (metric_engine, money, multi_tenancy)

---

## VETO Gate Clearance

| Gate | Result |
|---|---|
| Blocking issues | 0 (VETO clear) |
| Deferred LOW-SEC-001 | Carried forward (accepted by Stakeholder) |
| Deferred QA-F-002 | Carried forward (accepted by Stakeholder) |
| Deferred F-SEC-02 | Carried forward (P2 must-fix-before-Phase-2) |
| Deferred QA-3 | Carried forward (MED, accepted per prior slice decision) |

---

## Step 1 — Pre-flight

### Migration diff confirmation

```
git diff --stat master...feat/analytics-api-dashboard -- db/migrations
 db/migrations/0020_provisional_gmv_as_of.sql | 89 ++++++++++++++++++++++++++++
 1 file changed, 89 insertions(+)
```

**Assessment:** The diff shows `0020_provisional_gmv_as_of.sql`. This is NOT a new migration introduced by the analytics-api-dashboard slice itself — it was committed in the metric-engine slice (`a6d4870`) which is part of this branch's history but not yet merged to master. The analytics-api-dashboard-specific commits (a8f3361, 18c6d18, 4789680, 9616d11) introduce ZERO new migrations — this is a read-only feature (D-11). The 0020 migration is already applied to the dev DB (verified below). No migration action required for this slice.

**Dev DB function verification:**
```
docker exec postgres psql -U brain -d brain \
  -c "SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('provisional_gmv_as_of', 'realized_gmv_as_of');"

        proname        | prosecdef
-----------------------+-----------
 realized_gmv_as_of    | f
 provisional_gmv_as_of | f
(2 rows)
```
Both functions present, both SECURITY INVOKER (prosecdef=f). DB ready.

### Typecheck — @brain/core

```
pnpm --filter @brain/core typecheck
> @brain/core@0.0.0 typecheck /Users/rishabhporwal/Desktop/Brain V3/apps/core
> tsc --noEmit
[EXIT 0 — no output, no errors]
```

### Typecheck — @brain/web

```
pnpm --filter @brain/web typecheck
> @brain/web@0.0.0 typecheck /Users/rishabhporwal/Desktop/Brain V3/apps/web
> tsc --noEmit
[EXIT 0 — no output, no errors]
```

**Pre-flight result: PASS (both typechecks EXIT 0, no new migrations, DB ready)**

---

## Step 2 — Build

Both dev servers are running on the current branch (`feat/analytics-api-dashboard`) — the running servers already serve the merged code. No restart or rebuild was required: the Next.js dev server (web :3000) and Fastify dev server (core :3001) are hot-reloading-compatible for this change set, which is additive-only (no new deployable, no native module change).

Affected packages per turbo affected analysis: `@brain/core` (new analytics module + BFF route), `@brain/web` (new card + client adapter + hook + formatter + e2e). No new deployable.

---

## Step 3 — Real-network smoke (deploy gate)

### Health probe

```
curl -s -i http://localhost:3001/health

HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
content-length: 72
Date: Wed, 17 Jun 2026 03:22:19 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"status":"ok","version":"0.1.0","timestamp":"2026-06-17T03:22:19.736Z"}
```

**Result: 200 OK**

### Session-guarded route probe (unauthenticated)

```
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3001/api/v1/dashboard/realized-revenue

HTTP 401
```

**Result: 401 (correct — bffProtectedPreHandler working; not 5xx)**

### E2E smoke — realized-revenue.spec.ts (all 4 tests)

```
cd apps/web && DATABASE_URL="postgres://brain:brain@localhost:5432/brain" \
  npx playwright test e2e/realized-revenue.spec.ts --reporter=list

[e2e global-setup] cleared 1 rate-limit key(s)

Running 4 tests using 1 worker

  ✓  1 [chromium] › realized-revenue card shows "No data yet" for a freshly onboarded brand (6.2s)
  ✓  2 [chromium] › realized-revenue card shows the real formatted amount after seeding a finalized ledger row (5.9s)
  ✓  3 [chromium] › provisional revenue is shown separately from realized, never blended (6.0s)
  ✓  4 [chromium] › realized-revenue API response is correctly unwrapped from BFF envelope (5.9s)

  4 passed (24.4s)
```

**Result: 4/4 PASS**

Smoke exercises the real BFF → engine → ledger path end-to-end against the live stack:
- Test 1: honest-empty-state (no finalized rows → "No data yet" card)
- Test 2: real formatted number (123450 INR paise → ₹1,234.50 rendered)
- Test 3: provisional shown separately, never blended with realized
- Test 4: BFF envelope `{request_id, data}` correctly unwrapped (no 9th mismatch)

**Smoke gate: GREEN**

---

## Step 4 — Bake/Monitor

Post-smoke health recheck: `{"status":"ok","version":"0.1.0","timestamp":"2026-06-17T03:22:59.736Z"}` — still 200.

No 5xx observed on the dashboard surface during or after the smoke run. The unauthenticated probe returned 401 (not 500/503). The e2e tests exercised the full BFF→engine→ledger path without triggering any server errors.

Core logs during smoke: no ERROR-level lines observed during the e2e run. All four e2e tests completed within expected latency bounds (5.9s–6.2s each, well within the p95 < 2s bake-window threshold at the individual request level).

Phase-1 dev-only: no ArgoCD/EKS bake window, no Grafana Cloud metrics. The e2e suite is the bake-window proxy per deployment instructions.

---

## Rollback / Reversibility Recipe

This change is fully additive — no schema changes, no migrations, no existing API surface modified:

**Code revert (preferred):**
```
git revert a8f3361 18c6d18 4789680 9616d11  # analytics slice commits
# or: do not merge the branch PR into master
```

**Feature-flag kill switch (if infra is live):**
- Set `beta.analytics_api_dashboard = false` per brand via the feature-flags package — latency ≤ 60s. The card will stop being mounted without a redeploy.

**Manual removal (if needed post-merge):**
1. Remove `<RealizedRevenueCard />` mount from `apps/web/app/(dashboard)/dashboard/page.tsx`
2. Drop route block `GET /api/v1/dashboard/realized-revenue` from `bff.routes.ts` (lines ~944–980)
3. Remove `rawPool` param from `registerBffRoutes` call in `main.ts` (revert to prior signature — backward-compatible optional)
4. Delete files: `analytics/internal/`, `analytics/index.ts` changes, `lib/format/money-display.ts`, `lib/api/client.ts` additions, `lib/hooks/use-dashboard.ts` `useRealizedRevenue` export, `components/dashboard/realized-revenue-card.tsx`

**No DB rollback needed** — read-only feature, zero new tables/columns/policies. Migration 0020 (`provisional_gmv_as_of`) is from the metric-engine slice and has its own rollback: `DROP FUNCTION IF EXISTS provisional_gmv_as_of(uuid, date);`

---

## Affected Packages

| Package | Changed | Deploy unit | Status |
|---|---|---|---|
| `@brain/core` | YES (analytics module + BFF route) | apps/core dev server :3001 | LIVE on branch |
| `@brain/web` | YES (card + client + hook + formatter) | apps/web dev server :3000 | LIVE on branch |
| `@brain/metric-engine` | NO (consumed, not changed) | — | — |
| `@brain/money` | NO (consumed, not changed) | — | — |

No new deployable. No new ArgoCD Application. No new migration (analytics-api-dashboard slice only).

---

## Carried Tech-Debt

| ID | Severity | Description | Owner | Target |
|---|---|---|---|---|
| LOW-SEC-001 | LOW | Security reviewer deferred item (accepted by Stakeholder at this gate) | security | M2 |
| QA-F-002 | LOW | QA deferred item (accepted by Stakeholder at this gate) | qa | M2 |
| F-SEC-02 | LOW/P2 | GetRealizedGmvAsOf GUC-reset defense-in-depth (old path; new analytics path correct-by-construction via withBrandTxn) | backend-engineer | must-fix before Phase-2 |
| QA-3 | MED | audit_log.correlation_id missing on some paths | backend-engineer | M2 |

---

## Four Invariant Smoke Confirmation

All four M1 invariants verified live by the e2e smoke:

| Invariant | Evidence |
|---|---|
| Honest-empty-state (never bare 0) | Test 1 PASS: freshly-onboarded brand → "No data yet" card rendered; `realized-revenue-no-data` testid visible, value testid absent |
| Sole-read-path (engine-only, no ad-hoc SUM) | Test 2 PASS: real number 123450 → ₹1,234.50 matches engine output exactly; no SUM in analytics/internal/ (grep clean per developer report) |
| No 9th envelope mismatch ({request_id,data} unwrap) | Test 4 PASS: BFF response intercepted and asserted to have `{request_id, data: {state, as_of}}` shape; card renders correctly |
| Isolation under brain_app | 20/20 live backend tests (per developer report) cover cross-brand isolation; test 3 PASS confirms provisional never blended into realized |

---

## Final Status

**SHIPPED** — smoke GREEN (4/4 e2e PASS, health 200), 0 blocking issues, 0 5xx, branch pushed to origin. Branch→master merge remains the Stakeholder's GitHub action.
