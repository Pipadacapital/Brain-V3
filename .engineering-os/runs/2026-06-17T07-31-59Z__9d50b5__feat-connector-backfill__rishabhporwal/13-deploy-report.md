# 13 — Deploy Report: feat-connector-backfill

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-backfill` |
| **Stage** | 8 (deploy) |
| **Status** | **shipped** |
| **Deployed by** | orchestrator (inline dev-grade bake — platform-devops agent died on the infra socket timeout in the prior slice; inline is reliable for these deterministic gates) |
| **Target** | dev environment — running servers web :3000, core :3001, stream-worker; docker infra untouched |
| **Stakeholder** | approved (Stage 7) |
| **ts** | 2026-06-17T12:35:00Z |

## Deploy bake — all gates GREEN

| Gate | Result | Evidence |
|------|--------|----------|
| Migration 0022 backfill_job | ✅ | `relforcerowsecurity=t`; brain_app grants = INSERT/SELECT/UPDATE (NO DELETE) |
| Migration 0023 enumeration fn | ✅ | `list_queued_backfill_jobs` `prosecdef=t`, `proconfig={search_path=public}` (hijack-pinned, mirrors 0019) |
| core /health | ✅ | HTTP 200 |
| backfill route protected | ✅ | POST /api/v1/connectors/:id/backfill unauth → 401 |
| @brain/core typecheck | ✅ | EXIT 0 |
| @brain/web typecheck | ✅ | EXIT 0 |
| stream-worker tests (worker/lane/ledger/payoff) | ✅ | **67/67 pass** (incl. T11 enumeration-fixed + T12 past-dated→realized) |
| core backfill trigger tests | ✅ | **11/11 pass** (202/403/409-reconnect/409-overlap, isolation under brain_app) |

## Notes

- **branch→master merge remains the Stakeholder's GitHub action** (gh CLI unauthenticated; the hook blocks direct master push).
- The **payoff is proven in code** (T12: a past-dated provisional → `revenue-finalization` → `finalization` ledger row = realized ₹2,500, idempotent, under brain_app).
- The worker is **no longer structurally inert** — the 0023 SECURITY DEFINER enumeration fn fixed the RLS-GUC trap (the 3rd occurrence of this pattern).

## Carried tech-debt (Stakeholder-accepted, tracked)

| ID | Sev | Title | Target |
|----|-----|-------|--------|
| SEC-BF-M2 | MED | Dual LedgerWriter (stream-worker vs core) — byte-identical ON CONFLICT today; extract shared `@brain/ledger-writer` | post-M1 |
| SEC-BF-L1 | LOW | Dual PgBackfillJobRepository (intentional I-E05 split, aligned) | post-M1 |
| DEV-TOKEN-REACH | — | Live Boddactive dev backfill needs the OAuth token reachable by the worker process (ADR-BF-11; in-core memory vs separate worker process) | dev validation follow-up |
| RULE-PROPOSAL | — | `/adopt-rule system-job-force-rls-enumeration` — 3rd occurrence; proposal written, awaits Stakeholder | pending |
| (carried) | — | SEC-CM-RES-01 (shared CMK), F-SEC-02, QA-3 | M2 |
