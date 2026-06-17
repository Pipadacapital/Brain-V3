# Developer Report — Track B (Backend Engineer)
## feat-connector-backfill — Stage 3 Backend

**Date:** 2026-06-17T12:45:00Z
**Branch:** feat/connector-backfill
**Commits:**
- `72ecb32` — B1+B2: POST /connectors/:id/backfill trigger + GET /connectors/:id/jobs progress API (ADR-BF-3/4, D-7/9/15)
- `475c5ae` — B3: live integration tests, 11/11 pass, brain_app pool (SC#1/2/6/12/14, D-7/8/9/15)

---

## What was built

### B1 — Trigger endpoint (ADR-BF-3)

Replaced the 501 stub at `apps/core/src/main.ts:716` with a full implementation of `POST /api/v1/connectors/:id/backfill`.

Route is registered inside a scope with `sessionPreHandler` + `requireRole('brand_admin')` preHandlers (brand_admin+ gate — D-15).

Flow per ADR-BF-3:
1. Load `connector_instance` via `connectorRepo.findById(connectorInstanceId, brandId)` — brand-scoped via RLS (NN-1). 404 if not found.
2. `connectorSecretsManager.getSecret(connectorInstance.secretRef)` — null → 409 `RECONNECT_REQUIRED` (D-7). No secret/token in response (I-S09).
3. `backfillJobRepo.checkActiveJob(connectorInstanceId, brandId, requestId)` — DB-level `SELECT FOR UPDATE SKIP LOCKED` (D-9/HP-2). Non-null → 409 `BACKFILL_ALREADY_RUNNING`.
4. `backfillJobRepo.insertQueued(brandId, connectorInstanceId, requestId)` — INSERT status='queued'.
5. `auditWriter.append(...)` — action='connector.backfill.requested', entity_type='backfill_job', entity_id=jobId. NO secret_ref / token in payload (I-S09). brand_id from connector (NN-1/ADR-BF-13/MT-1), never from request body.
6. 202 `{request_id, data: {job_id, status:'queued'}}`.

### B2 — Progress endpoint (ADR-BF-4)

`GET /api/v1/connectors/:id/jobs` (same scope, same authz).

Flow:
1. Load connector_instance (same 404 guard).
2. `backfillJobRepo.findLatestForConnector(connectorInstanceId, brandId, requestId)`.
3. If no job → 404 `NO_JOB_FOUND`.
4. Map to `BackfillJobProgress` shape from `@brain/contracts`. `percent = null` when `estimated_total` is null (D-8 honesty). No `secret_ref` in response.
5. 200 `{request_id, data: BackfillJobProgress}`.

### B3 — Live tests (11 tests, brain_app pool)

File: `apps/core/src/modules/connector/backfill/tests/backfill-trigger.live.test.ts`

Critical design decisions:
- All assertions run against `BRAIN_APP_DATABASE_URL` (brain_app role, NOSUPERUSER NOBYPASSRLS) to avoid the F-4 false-pass trap (dev superuser 'brain' bypasses RLS — MEMORY: dev-db-superuser-masks-rls).
- `makeAppDbPool` wraps each query in explicit `BEGIN / SET LOCAL / COMMIT` so the GUC persists for the statement (NN-1 requirement).
- Each test seeds its own `connector_instance` inline and cleans up — no shared state across tests.
- Fresh brand UUIDs (`bf000001-...`, `bf000002-...`) avoid conflicts with stable dev data.

Test results:
```
Tests  11 passed (11)
Files  1 passed (1)
Duration ~55ms
```

Test matrix:
| Test | ADR/SC | Result |
|------|--------|--------|
| T1: insertQueued → UUID job_id, status=queued in DB | SC#1, ADR-BF-3 | PASS |
| T2: meetsMinimumRole(manager, brand_admin)===false | D-15, SC#2 | PASS |
| T3: getSecret(never-stored-ARN)===null; stored ARN non-null | D-7 | PASS |
| T4: checkActiveJob returns existing job; count===1 | D-9/HP-2, SC#2 | PASS |
| T5a: findLatestForConnector returns row, percent===null when estimated_total===null | D-8, SC#6 | PASS |
| T5b: percent bounded 0-100 when estimated_total > 0 | D-8 | PASS |
| T6: no token/secret/ciphertext/secret_ref in BackfillJobRow | I-S09 | PASS |
| T7: audit row in DB, action=connector.backfill.requested, no secret in payload | SC#14 | PASS |
| T8a: current_user=brain_app (NOSUPERUSER NOBYPASSRLS) | SC#12 | PASS |
| T8b: Brand B count===0 under brain_app (negative isolation control) | SC#12/MT-2 | PASS |
| T8c: Brand A count===1 under brain_app (positive control) | SC#12 | PASS |

---

## New files

- `apps/core/src/modules/connector/backfill/infrastructure/PgBackfillJobRepository.ts` — core-side adapter (separate from stream-worker's copy; uses `@brain/db` DbPool/QueryContext interface).
- `apps/core/src/modules/connector/backfill/tests/backfill-trigger.live.test.ts` — B3 live tests.

## Modified files

- `apps/core/src/main.ts` — added imports + replaced 501 stub with B1+B2 implementation.

---

## Non-negotiables verified

- brand_id from JWT/session/connector (never from request body) — MT-1/ADR-BF-13
- No secret_ref / token in any response or log — I-S09
- All responses in `{request_id, data}` envelope — ADR-CM-8
- Overlap-lock is DB-level (`SELECT FOR UPDATE SKIP LOCKED`) — D-9/HP-2
- percent=null when estimated_total=null — D-8
- brand_admin+ gate only (manager → 403, non-inert via meetsMinimumRole negative control) — D-15
- Isolation tests run under brain_app NOBYPASSRLS — F-4 anti-trap

## Verification

```
pnpm --filter @brain/core typecheck → exit 0 (no errors)
pnpm --filter @brain/core test:unit backfill-trigger → 11 passed / 0 failed
```

---

## Status

READY-FOR-SECURITY
