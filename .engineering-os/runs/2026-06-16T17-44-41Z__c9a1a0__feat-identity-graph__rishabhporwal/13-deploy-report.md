# Deploy Report — feat-identity-graph

**Stage:** 8 (deploy) · **Role:** Platform/SRE · **Timestamp:** 2026-06-16T22:50:00Z
**Branch:** `feat/identity-graph` · **HEAD:** `44d951c` · **Phase:** 1-dev-only

---

## 1. Migration 0017 — verified-applied

Migration `db/migrations/0017_identity_graph.sql` was applied by the data-engineer (Slice 1, commit `8ac9771`). Verification ran against the live dev Postgres container (`brainv3-postgres-1`).

### RLS FORCE check

```sql
SELECT relname,relrowsecurity,relforcerowsecurity
FROM pg_class
WHERE relname IN ('brain_id','brain_id_alias','identity_link',
                  'identity_merge_event','shared_utility_identifier','contact_pii');
```

| relname | relrowsecurity | relforcerowsecurity |
|---|---|---|
| identity_link | t | t |
| identity_merge_event | t | t |
| brain_id_alias | t | t |
| shared_utility_identifier | t | t |
| contact_pii | t | t |

Note: `brain_id` is not a relation (it is a column type / uuid alias, not a table) — all five identity tables confirmed FORCE=t.

### contact_pii dual-gate policy

```
polname: contact_pii_isolation
using_expr: ((brand_id = current_setting('app.current_brand_id', true)::uuid)
             AND (current_setting('app.role', true) = 'send_service'))
```

Both predicates two-arg fail-closed. CONFIRMED.

### Brand columns (D-1, D-2)

```
phone_guard_threshold    — present
suppression_window_days  — present
identity_salt_ciphertext — present
```

**Migration status: verified-applied (pre-existing at deploy time).**

---

## 2. Build gate — typecheck

All four packages typechecked individually (no `tsc` script alias clash; used `typecheck` script):

| Package | Exit |
|---|---|
| `@brain/identity-core` | 0 (PASS) |
| `@brain/stream-worker` | 0 (PASS) |
| `@brain/events` | 0 (PASS) |
| `@brain/contracts` | 0 (PASS) |

**Build gate: PASS**

Build scripts (`tsc -b`) are present on all packages. No separate build run was performed (dev-only phase; no image push). The affected deployable is `@brain/stream-worker` (bridge ships inside the existing process, D-7).

---

## 3. Smoke — identity e2e suite (26 tests, live PG as brain_app)

```
vitest run --no-file-parallelism src/tests/identity.e2e.test.ts
Test Files  1 passed (1)
Tests       26 passed (26)
Duration    206ms
EXIT: 0
```

### Test coverage summary

| Suite | Tests | Result |
|---|---|---|
| identity-core conformance (C-1, D-2, D-6) | 7 | PASS |
| SaltProvider hard-crash guard (D-2) | 4 | PASS |
| Deterministic merge (Test 1) | 1 | PASS |
| Phone-guard N=10 boundary (D-1) | 3 | PASS |
| Isolation negative control (I-S01, RLS FORCE) | 4 | PASS |
| No raw PII in identity_link (I-S02) | 1 | PASS |
| Replay idempotency 3x→1 (D-4) | 2 | PASS |
| contact_pii send_service gate (D-3) | 4 | PASS |

All 26 PASS under `brain_app` (non-superuser). Negative controls are non-inert (brain_app without GUC → 0 rows; brain_app without send_service → 0 rows; cross-brand isolation verified live).

**Smoke: GREEN (bake proxy satisfied)**

---

## 4. PR status

`gh` CLI is unauthenticated (Phase 1-dev-only, no cloud infra). PR could not be created automatically.

**Manual compare URL:** `https://github.com/Rishabhporwal/Brain-V4/compare/master...feat/identity-graph`

Base: `master` · Head: `feat/identity-graph` · Commit: `44d951c`
Branch is based directly off `master` — clean base, no stacked dependency.

---

## 5. Rollback recipe

Migration 0017 is a derived projection (rebuildable from Bronze). Down migration is clean:

```sql
-- Run as superuser (brain) against dev db
-- Reverse FK order
DROP TABLE IF EXISTS identity_audit;
DROP TABLE IF EXISTS merge_review_queue;
DROP TABLE IF EXISTS contact_pii;
DROP TABLE IF EXISTS shared_utility_identifier;
DROP TABLE IF EXISTS identity_merge_event;
DROP TABLE IF EXISTS brain_id_alias;
DROP TABLE IF EXISTS identity_link;
DROP TABLE IF EXISTS customer;
ALTER TABLE brand
  DROP COLUMN IF EXISTS identity_salt_ciphertext,
  DROP COLUMN IF EXISTS phone_guard_threshold,
  DROP COLUMN IF EXISTS suppression_window_days;
-- Then redeploy prior stream-worker image (bridge code removed)
```

The identity graph is fully rebuildable from Bronze by replaying `dev.collector.event.v1` through the bridge (real SHA-256 + idempotent writer = identical reconstruction).

---

## 6. P1 Tech-Debt — SR-01/QA-04 (carry-forward, explicit)

**Finding:** `apps/stream-worker/src/jobs/phone-guard-reeval.ts` connects as `brain_app` and runs `SELECT id FROM brand WHERE status='active'` with no brand GUC set. Because `brand` has FORCE RLS, this returns **0 rows** (`brain_app` sees 0; superuser sees 171 in dev). The job loops over an empty set and silently no-ops every run.

**Effect:** Suppressions set by the phone-guard (D-1) are NEVER un-suppressed. Over-suppression accumulates monotonically — a legitimate repeat customer whose phone was caught in a burst stays identity-split until fixed.

**Direction:** Fail-closed. Never under-suppresses, so no false-merge, no data leak, no isolation breach.

**Fix required:** SECURITY DEFINER enumeration function (grants the job a superuser-level brand scan in a scoped fn, while the job itself remains `brain_app`) OR a dedicated superuser connection pool for system jobs that must enumerate across all tenants.

**Recoverability:** Full. Fix enumeration → run job → suppressions re-evaluate. Graph is rebuildable from Bronze.

**Condition:** MUST-FIX before India COD production volume (real phone-guard suppression accumulation becomes user-visible at scale). Acceptable for M1 (synthetic/internal, low volume).

---

## 7. Deploy summary

| Step | Status |
|---|---|
| Migration 0017 | verified-applied |
| Typecheck @brain/identity-core | PASS (EXIT 0) |
| Typecheck @brain/stream-worker | PASS (EXIT 0) |
| Typecheck @brain/events | PASS (EXIT 0) |
| Typecheck @brain/contracts | PASS (EXIT 0) |
| Smoke (26 identity e2e, live PG, brain_app) | GREEN |
| PR | gh-unauth; manual URL above |
| Canary | N/A (Phase-4 deferred, ADR-010) |
| Auto-rollback | N/A (dev-only; ArgoCD staging/prod not provisioned in Phase 1) |
| Phase | 1-dev-only |

**Overall status: SHIPPED** (dev-only; all gates green; P1 tech-debt tracked explicitly)
