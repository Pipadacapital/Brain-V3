# 05 — Security Review: feat-connector-backfill
## Stage 4 | Mode: FULL | Verdict: BOUNCE

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-backfill` |
| **Stage** | 4 — Security + Compliance |
| **Mode** | FULL |
| **Verdict** | **BOUNCE** |
| **Blocking findings** | 1 HIGH (SEC-BF-H1) |
| **Non-blocking findings** | 2 MED (SEC-BF-M1, SEC-BF-M2) / 1 LOW (SEC-BF-L1) |
| **Scanners** | secret-grep CLEAN · DDL scan CLEAN · SAST manual CLEAN · no new deps/IaC |
| **Reviewed at** | 2026-06-17T14:00:00Z |

---

## BOUNCE REASON

**SEC-BF-H1 (HIGH — OPEN): Worker job-enumeration queries bypass RLS GUC — worker is non-functional in prod.**

`findQueuedJob()` and `loadConnectorInstance()` in `apps/stream-worker/src/jobs/shopify-backfill/run.ts` (lines 219, 228, 247) call `pool.query()` on a `brain_app`-credential pool **without first setting `app.current_brand_id`** via `set_config`. The `backfill_job` table has `FORCE ROW LEVEL SECURITY` with the two-arg fail-closed policy (`current_setting('app.current_brand_id', TRUE)::uuid`). Under `brain_app` without a GUC, the two-arg form returns NULL, the policy evaluates FALSE for every row, and 0 rows are returned structurally. This means:

- `findQueuedJob()` always returns `null` → worker exits with "no queued jobs found" on every invocation.
- `loadConnectorInstance()` always returns `null` → even if a job were found, it would immediately fail with `CONNECTOR_NOT_FOUND`.

The same applies to `connector_instance` (FORCE RLS, brain_app, two-arg fail-closed in 0006).

**Isolation posture:** The RLS is fail-CLOSED (not fail-open). There is no data leak or cross-tenant read — this is not a confidentiality failure. It is, however, a structural breakage: the worker cannot perform its core function, and the backfill pipeline is completely non-functional as shipped. A HIGH functional-security defect because it means 100% of the security and compliance properties of the backfill (PII hashing, ledger writes, audit trail for backfill) never execute in production.

**The misleading comment at run.ts:211** reads "Uses the superuser pool for enumeration" — this is incorrect. The pool at line 81 uses `BRAIN_APP_DATABASE_URL` (brain_app credentials, NOBYPASSRLS). This comment likely masked the bug during development.

**Fix required:** Add `set_config` GUC calls before the unguarded `pool.query` calls in `findQueuedJob` and `loadConnectorInstance`. Both functions receive `brandId` or can obtain it via the job context. For `findQueuedJob`, since no brand GUC is known at enumeration time (we're looking for any queued job), the correct fix is to use a separate privileged enumeration query (e.g. a `SECURITY DEFINER` function for job enumeration, analogous to `list_active_brand_ids()` in 0019), or to move the pool from `brain_app` to superuser for the enumeration step only (and then scope all subsequent reads/writes under `brain_app` + brand GUC). The simplest M1 fix is a `SECURITY DEFINER` function that enumerates queued job IDs and their `brand_id` without RLS (the function itself is brand-agnostic enumeration, not tenant data), registered in a migration, called from the worker.

---

## Full Findings

### SEC-BF-H1 — HIGH (OPEN — BLOCKING)
**Worker job-enumeration bypasses RLS GUC — worker non-functional in prod**

- File: `apps/stream-worker/src/jobs/shopify-backfill/run.ts:219,228,247`
- The `findQueuedJob` (lines 219, 228) and `loadConnectorInstance` (line 247) calls execute against the brain_app pool without `set_config('app.current_brand_id', ...)`. Under FORCE RLS with the two-arg fail-closed policy, no GUC = 0 rows always.
- Security posture: fail-closed (no leak). Functional posture: 100% failure — no backfill job ever executes.
- Fix: provide a SECURITY DEFINER enumeration function in a migration for job-queue enumeration, or use a superuser connection for enumeration only with all writes/reads going through brain_app + GUC. See remediation detail above.

### SEC-BF-M1 — MEDIUM (OPEN)
**Inaccurate comment "superuser pool" at run.ts:211 masks the GUC gap**

- File: `apps/stream-worker/src/jobs/shopify-backfill/run.ts:211`
- The docstring says "Uses the superuser pool for enumeration" but the pool is `brain_app` (BRAIN_APP_DATABASE_URL). This comment caused the GUC gap to go undetected. Fix: correct the comment when fixing SEC-BF-H1.
- Severity: MEDIUM (documentation drift that conceals a HIGH bug; low standalone risk but causally linked to H1).

### SEC-BF-M2 — MEDIUM (OPEN)
**Duplicate LedgerWriter in stream-worker may drift from core's PgLedgerRepository**

- File: `apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts`
- The current ON CONFLICT key matches exactly: `(brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))`. GUC is set before every INSERT. Schema columns match. Immediately acceptable.
- Risk: two independent implementations of the same ledger invariant with no shared import. If PgLedgerRepository in core changes its dedup key, column set, or money handling in the future, LedgerWriter will silently diverge. The append-only ledger makes a drift scenario hard to detect and hard to recover from.
- Fix: track this as tech-debt. Post-M1, extract a shared `@brain/ledger-writer` package and remove the duplicate. For this slice: add a comment in both files pointing to the other implementation and a CI lint rule that asserts the ON CONFLICT key strings are identical across both files.

### SEC-BF-L1 — LOW (OPEN)
**Two PgBackfillJobRepository implementations (stream-worker + core) share identical schema but no shared source**

- Files: `apps/stream-worker/src/infrastructure/pg/BackfillJobRepository.ts` and `apps/core/src/modules/connector/backfill/infrastructure/PgBackfillJobRepository.ts`
- Both have identical BackfillJobRow interface and GUC-first pattern. The split is intentional (I-E05: no cross-app imports). Risk: the two drift in column definitions or GUC handling.
- Fix: same resolution as SEC-BF-M2 (post-M1 shared package). Low urgency — the core repo is trigger-only (insertQueued + checkActiveJob), the worker repo is full lifecycle. Interface divergence would surface at typecheck time.

---

## Verification Lines (non-bounced gates)

### PII-HASHING — PASS
- `order-mapper.ts:99-128`: raw `customer.email` and `customer.phone` are consumed for hashing only (`hashIdentifier` via `@brain/identity-core`) and discarded within scope. Raw values NEVER assigned to the `properties` object.
- `order-mapper.ts:131-147`: the emitted `properties` carries ONLY `hashed_customer_email`, `hashed_customer_phone`, `storefront_customer_id` (numeric platform ID, not PII).
- `OrderBackfillPropertiesSchema`: no `email`, `phone`, `name`, `address` field. Only `hashed_*` fields. Confirmed.
- `ShopifyBackfillOrder` interface (`shopify-paged-client.ts:19-38`): `customer` field limited to `{id?, email?, phone?}` — no `billing_address`, `shipping_address`, `name` are fetched.
- `shopify-paged-client.ts:111-115`: `fields=` parameter in the Shopify API call includes `customer` but NOT `billing_address` or `shipping_address`. Raw address is not fetched at all.
- **VERDICT: I-S02 PASS. No raw PII reaches the event payload, Bronze row, or logs.**

### TOKEN SECRECY — PASS
- `worker-secrets.ts`: token is never logged. Log line at run.ts:154 logs only the job_id and status label.
- `shopify-paged-client.ts:15-61`: token is held as a private constructor field. Never passed to `console.*`.
- `main.ts:751-760 (core)`: the 409 RECONNECT_REQUIRED response contains only the error code + message. No secret value, no secret_ref ARN, no token in the body.
- `main.ts:779-790 (core)`: audit payload contains `job_id` and `connector_instance_id` only. No `secret_ref`, no token.
- `PgBackfillJobRepository` (both variants): no secret column in BackfillJobRow. Test T6 confirms.
- **VERDICT: I-S09 PASS.**

### WEB REWRITE CSRF — PASS
- `next.config.js:14-18`: the `/api/v1/:path*` rewrite is a Next.js server-side proxy. The browser sends the request to Next.js, which forwards it to `CORE_API_URL`. The session cookie and CSRF token travel from the browser to Next.js and then to core (credentials: 'include' in client.ts:742).
- `main.ts:191-236 (core)`: the global `onRequest` hook fires for ALL requests including those proxied via the Next.js rewrite. It checks: (a) session cookie exists → cookie-to-Bearer bridge applies; (b) POST is state-changing → CSRF double-submit enforced. The `csrfExempt` list does NOT include `/api/v1/connectors/:id/backfill`.
- `client.ts:733,740`: `triggerBackfill()` calls `ensureCsrfToken()` and sends `x-csrf-token` header. The proxy passes all headers through transparently.
- **VERDICT: The `/api/v1/:path*` rewrite does NOT bypass CSRF. The server-side CSRF hook fires globally. The client sends the CSRF token. PASS.**

### AUTHZ (D-15) — PASS
- `main.ts:729-731 (core)`: backfill scope registered with `sessionPreHandler` + `requireRole('brand_admin')` preHandlers. These run before the route handler.
- `sessionPreHandler`: validates the session JWT (not bypassed by the proxy — JWT is in the Authorization header translated from the cookie).
- Test T2 (B3): `meetsMinimumRole('manager', 'brand_admin') === false` confirmed non-inert (a separate test path). Test T8b: 403 is the actual server response.
- **VERDICT: D-15 PASS. Manager→403 is server-enforced, not UI-cosmetic only.**

### ISOLATION (ONE INVARIANT) — PASS (with H1 caveat)
- `0022_backfill_job.sql:65-74`: FORCE RLS, two-arg fail-closed, brain_app GRANT SELECT+INSERT+UPDATE NO DELETE. NN-1 assertion carried forward.
- RLS policy form: `USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)` — two-arg form confirmed.
- Tests T4 (A4), T8b (B3): cross-brand isolation verified under brain_app NOBYPASSRLS with non-inert negative control (count===0 under wrong GUC).
- Note: The H1 finding means the worker never successfully executes writes, so the isolation proof is moot in practice until H1 is fixed. Isolation structure is sound.
- **VERDICT: RLS structure PASS. Worker execution: blocked by H1.**

### LEDGER DUPLICATION (DRIFT/INTEGRITY RISK) — ACCEPTABLE (MED tracked as SEC-BF-M2)
- `LedgerWriter.ts:121` ON CONFLICT key: `(brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))` — exact match to `PgLedgerRepository.ts:84`.
- `LedgerWriter.ts:77-84`: GUC set via `set_config` before every INSERT — RLS enforced.
- `LedgerWriter.ts:44-52`: dedup `ledger_event_id` = `sha256(brand_id\0order_id\0event_type\0sourcePk\0v1)` — same algorithm as `revenue-finalization.ts computeLedgerEventId`.
- `LedgerWriter.ts:130,131`: `occurred_at` written as-is (D-6), not NOW(). Economic_effective_at = occurred_at (correct for historical backfill).
- No re-implementation of recognition logic, horizon calculation, or finalization — those remain in core's RecognizeOrder + the existing revenue-finalization job.
- **VERDICT: Money integrity and idempotency PASS for this slice. Future drift risk tracked as SEC-BF-M2 (MEDIUM).**

### MONEY ARITHMETIC (D-13) — PASS
- `money-utils.ts:22-45`: `decimalStringToMinor` uses BigInt arithmetic exclusively. Regex `^\d+(\.\d{1,2})?$` asserts ≤2 decimals. No `parseFloat`, no `Math.round`. I-S07 compliant.
- Test T5 (A4): 7 assertions including `99999.99` no-float-error and rejection of >2 decimals.
- **VERDICT: I-S07 PASS.**

### EVENT_ID DETERMINISM (D-5) — PASS
- `uuid-utils.ts:32-56`: `uuidV5FromOrderBackfill(brandId, shopifyOrderId)` = sha256(`${brandId}:${shopifyOrderId}:order.backfill.v1`) → first 16 bytes → version nibble 0x5 + RFC-4122 variant bits → hyphenated UUID. Pure function of (brand_id, order_id). Stable across re-runs.
- `brand_id` is ALWAYS from `connector_instance.brand_id` (run.ts:359 comments confirm MT-1). Shopify order ID is globally unique numeric. Cross-brand collision structurally impossible (brand_id in hash input).
- Test T2 (A4): 4 determinism assertions.
- **VERDICT: D-5 PASS. Replay-safe Bronze dedup confirmed.**

### DPDP COMPLIANCE — PASS
- Customer name, billing_address, shipping_address: not in the Shopify API `fields=` parameter and not in `ShopifyBackfillOrder` interface. Never fetched.
- Customer email/phone: fetched, hashed, and discarded at the mapper boundary before Kafka produce.
- No raw PII in events, Bronze payload, logs, or ledger rows.
- Purpose limitation: analytics measurement, within COMPLIANCE.md §1 declared purpose. Backfill = historical analytics, not outreach. No new consent surface required.
- **VERDICT: DPDP minimization PASS. Purpose-limitation PASS.**

---

## Scanners

**Mode:** FULL (first review of this surface)

- **Secret grep:** Clean on all new files. No plaintext tokens, OAuth secrets, or API keys in the staged diff. `SHOPIFY_ACCESS_TOKEN` env var is read-at-runtime only (dev env, not in source).
- **SAST (manual):** No hardcoded secrets, no `eval`, no `innerHTML`, no SQL concatenation. All DB queries parameterized.
- **DDL scan (0022):** FORCE RLS confirmed, two-arg fail-closed confirmed, NN-1 assertion present, NO DELETE grant confirmed. 0006 untouched.
- **PII schema-lint (manual):** `OrderBackfillPropertiesSchema` contains no `email`, `phone`, `name`, `address` typed fields. Only `hashed_*` fields and non-PII order metadata.
- **Money-lint (manual):** No `parseFloat` or float money in new code. `decimalStringToMinor` uses BigInt exclusively.
- **Full scanner suite (Trivy/Grype/Semgrep/gitleaks/Checkov):** Not run — no new dependencies, no new IaC, no new container images in this diff. The existing suite covers baseline. Note for CI: the new `worker-secrets.ts` path uses a `require()` in production for the AWS SDK — Semgrep should verify this doesn't introduce a new dep not in `package.json` (this is the `AwsSecretsManager` that already ships with the stream-worker).

---

## Verification Validity

- Tests T4 (A4), T8a/T8b (B3): all isolation assertions confirm `current_user = 'brain_app'` and `!== 'brain'`. Non-inert negative controls (count===0 under wrong GUC). Not bypass-green.
- Tests T2 (B3): `meetsMinimumRole('manager', 'brand_admin') === false` — non-inert authz negative control.
- The H1 finding means the worker's own `findQueuedJob` was NOT meaningfully tested under brain_app + FORCE RLS (T9 uses `insertQueued` via the repo, not the `pool.query` in `run.ts`). The `findQueuedJob` function in `run.ts` was not directly tested for GUC enforcement.

---

## bounce_target

**Track A (@data-engineer):** Fix `findQueuedJob` and `loadConnectorInstance` in `apps/stream-worker/src/jobs/shopify-backfill/run.ts` to use a SECURITY DEFINER enumeration function or a separate privileged pool for job-queue enumeration. All subsequent writes/reads must continue under brain_app + GUC. A4 tests must be updated to directly test the `findQueuedJob` code path under the fixed implementation.

---

## DELTA Re-review — 2026-06-17T15:30:00Z | Mode: DELTA | Verdict: PASS

**Delta scope:** SEC-BF-H1 (HIGH) + SEC-BF-M1 (MED) — commits 2f244d2 + d35cedb. Full-review PASSed surfaces not re-reviewed.

### SEC-BF-H1 — HIGH → RESOLVED

**Migration 0023 (`db/migrations/0023_backfill_job_enumeration.sql`):**

- `SECURITY DEFINER` confirmed on `list_queued_backfill_jobs()` at file:line 62.
- `SET search_path = public` pinned at file:line 64 — hijack prevention confirmed, mirrors 0019 precedent exactly.
- Returns ONLY `(id uuid, brand_id uuid, connector_instance_id uuid)` — no `cursor_value`, no progress fields, no PII, no tenant data content. Minimal controlled bypass: acceptable.
- `GRANT EXECUTE ON FUNCTION list_queued_backfill_jobs() TO brain_app` at file:line 76.
- Three migration-time assertions (DO $$ blocks at lines 79–146): (1) `prosecdef = true`, (2) `proconfig LIKE '%search_path=public%'`, (3) `has_function_privilege('brain_app', 'list_queued_backfill_jobs()', 'EXECUTE')`. Any failure raises EXCEPTION and aborts the migration.
- Function is additive (CREATE OR REPLACE). 0022 untouched.

**`apps/stream-worker/src/jobs/shopify-backfill/run.ts` — findQueuedJob() (lines 226–253):**

- Calls `SELECT id, brand_id, connector_instance_id FROM list_queued_backfill_jobs() [WHERE connector_instance_id = $1] LIMIT 1`. No GUC required — SECURITY DEFINER fn bypasses FORCE RLS for this enumeration step only. Correct.
- `brand_id` authority comes from fn result. `MT-1` maintained: never from env or Shopify.

**`apps/stream-worker/src/jobs/shopify-backfill/run.ts` — loadConnectorInstance() (lines 255–278):**

- `pool.connect()` → `client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId])` at line 265 — GUC set BEFORE the `connector_instance JOIN brand` query at line 266.
- GUC-before-tenant-read ordering confirmed. No brand-scoped read occurs prior to GUC being set.
- `brand_id` passed in is the fn result (not env or Shopify). Correct.

**T11 verification validity:**

- Negative control (line 759–778): `brain_app` direct `SELECT count(*) FROM backfill_job WHERE status='queued'` without GUC → asserts `count = 0`. Non-inert: would fail if GUC happened to be set or if RLS were not enforced. `current_user = 'brain_app'` asserted (not superuser — F-4 trap prevention).
- Positive assertion (line 780–791): `findQueuedJob(appPool, seededCiId)` returns `{jobId, brandId, ciId}` matching the seeded row. Non-inert: would fail if fn were not present or if EXECUTE grant were missing.
- Both assertions run under the real `brain_app` security context via `appPool` (BRAIN_APP_DATABASE_URL, NOBYPASSRLS). Not bypass-green.

**Minimal-bypass check:** `list_queued_backfill_jobs()` is not a general RLS bypass. It returns only job dispatch identifiers (3 UUID columns), structured identically to `list_active_brand_ids()` in 0019 which returns only brand UUIDs. No order rows, customer data, ledger rows, or other tenant content is exposed. The worker uses the `brand_id` from the fn result to set the GUC and then operates under full RLS for all subsequent reads and writes. This is an acceptable, minimal, precedented bypass pattern.

### SEC-BF-M1 — MEDIUM → RESOLVED

Comment at `run.ts:~212` now reads: "SEC-BF-H1 FIX (0023): Uses the brain_app pool + the SECURITY DEFINER fn list_queued_backfill_jobs() for enumeration." Complete explanation of the controlled bypass rationale is present. The misleading "superuser pool" text is gone. The `loadConnectorInstance()` docstring at line 260 also accurately explains the GUC-first requirement and the MT-1 brand_id authority rule.

### Deferred — Still Tracked

- **SEC-BF-M2** (LedgerWriter drift): open, deferred to post-M1 shared package extraction. Currently aligned.
- **SEC-BF-L1** (dual PgBackfillJobRepository): open, deferred. Intentional split (I-E05). Currently aligned.

### Regression Check on Changed Lines

Commits 2f244d2 and d35cedb: no new endpoints, no new MCP tools, no new migrations beyond 0023, no new secrets or IaC. `upsertConnectorCursor()` (line 489) already present and correctly sets GUC before INSERT — unchanged from prior FULL review. No regression introduced.

**Verdict: PASS. Blocking count: 0. Reconcile with QA Engineer.**
