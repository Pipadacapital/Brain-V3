# Requirement: Tier-1 Track A — Tenancy runtime (make FORCE-RLS actually enforce)

| Field | Value |
|-------|-------|
| **req_id** | `feat-tenancy-runtime-brain-app` |
| **Title** | Run the app as a non-superuser `brain_app` AND wrap the per-request brand GUC in a transaction so FORCE ROW LEVEL SECURITY is actually enforced at runtime — landed as ONE change with a negative-control proof under `brain_app`; + the StarRocks analytics-password prod fail-closed guard |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18 |
| **Lane** | high_stakes (multi-tenancy isolation — the #1 audit P0; a regression = cross-tenant data breach) |
| **Source** | Engineering Audit `docs/audit/98-final-risk-register.md` R-01, R-02, R-14, R-16 (Tier-1 Track A in `99-final-remediation-plan.md`). |

## Why (the audit finding — verbatim risk)
Tenant isolation is **designed but inert at runtime**. Two coupled facts:
- **R-01:** the app connects as the table-owning superuser (`.env` `postgres://brain:brain`; `docker-compose.yml` `POSTGRES_USER: brain`; Terraform provisions only `brainadmin`; `brain_app` has ZERO hits in `infra/`). Postgres does NOT enforce RLS — even `FORCE ROW LEVEL SECURITY` — against a table owner/superuser, so all ~30 fail-closed policies are **no-ops at runtime**.
- **R-02:** the one place that would set the per-request brand context is broken — `packages/db/src/index.ts` issues `SET LOCAL app.current_brand_id` as one `rawClient.query()` and the business query as a SEPARATE `rawClient.query()` with **no `BEGIN`** (see `index.ts:96,122` buildSetLocal + the exec path ~:201-209). Under autocommit, `SET LOCAL` dies with its own statement → the GUC is gone before the business query runs. The CORRECT pattern already exists at `packages/metric-engine/src/deps.ts:46-50` (`withBrandTxn`: `BEGIN → set_config(...,true) → fn → COMMIT`) and was never backported to `@brain/db`.
- **Coupling (critical):** fixing R-01 alone (run as `brain_app`) WITHOUT R-02 turns every brand-scoped read fail-closed to **0 rows** → login (`auth.service.ts` returns EMPTY_CONTEXT) → total functional outage. **R-01 and R-02 MUST land in one change.**
- **R-16:** `apps/core/src/main.ts:191` defaults `STARROCKS_ANALYTICS_PASSWORD` to the repo-public dev credential `brain_analytics_dev` with no `isProduction` guard (contrast the KMS hard-fail at `main.ts:531`).

## Deliverables (one coherent change; A1+A2 atomic)
1. **A1 — Provision `brain_app` (LOGIN NOSUPERUSER NOBYPASSRLS) everywhere the app connects:**
   - A migration/bootstrap that CREATEs `brain_app` and GRANTs it exactly the privileges the app needs on every app-touched table/sequence/function (SELECT/INSERT/UPDATE per existing append-only vs mutable rules; NO superuser; NO BYPASSRLS; NO table ownership). Owner stays the migration role; `brain_app` is a grantee subject to FORCE RLS.
   - Switch every NON-superuser app DSN to `brain_app`: dev `.env`/compose app DSN(s), the Terraform app DSN/secret (the RDS app user), and any worker DSN that does brand-scoped reads. The MIGRATION runner stays the owner/superuser (migrations need DDL); only the RUNTIME app connections become `brain_app`.
2. **A2 — Wrap GUC-set + business query in a transaction inside `@brain/db`:** make the `@brain/db` query path that applies a `QueryContext` run `BEGIN → SET LOCAL/set_config(brand+workspace, local=true) → <query> → COMMIT` (rollback on error), so the GUC is live for the business statement. Backport the proven `withBrandTxn` shape from `metric-engine/deps.ts`; do NOT leave a `SET LOCAL` stranded outside a txn. Preserve the existing GUC names (`app.current_brand_id`, `app.current_workspace_id`) and the no-context path.
3. **A3 — PROVE it under real `brain_app` with a negative control (the gate):** a live test that opens `createPool().connect()` AS `brain_app` (assert `current_user='brain_app'`, `is_superuser=false`, `rolbypassrls=false` FIRST — else the test is inert) and shows: (a) WITH the brand GUC set in-txn → the brand's own rows are returned (the app still works — proves A2 didn't break reads); (b) cross-brand GUC → 0 rows; (c) NO GUC → 0 rows (fail-closed); (d) a write to another brand → blocked. This is the keystone non-inert proof; a green test under superuser is NOT a pass.
4. **A4 — StarRocks analytics password prod fail-closed guard:** in `main.ts`, when `isProduction`, REQUIRE `STARROCKS_ANALYTICS_PASSWORD` (throw at startup if unset) instead of defaulting to `brain_analytics_dev` — mirror the KMS hard-fail at `main.ts:531`. Dev keeps the convenient default.

## Constraints
- **A1 + A2 ship together** (one PR). A1 without A2 = login outage; verify the FULL app path (login → a brand-scoped read returns data) works under `brain_app`, not only the isolation negatives.
- **No data-shape / behavior change** for a correctly-scoped request — the same rows come back; only the *enforcement* becomes real. The metric-engine `withBrandTxn` path already works under FORCE RLS; align `@brain/db` to it (don't fork a third pattern).
- Migrations remain owner/superuser-run (DDL); ONLY runtime app connections become `brain_app`. The dev DB already has the data; create `brain_app` + grants idempotently and verify existing reads still return rows.
- The isolation test MUST assert `is_superuser=false` + `current_user='brain_app'` BEFORE the isolation assertions (the audit's R-14: a green test under superuser is "literally true, operationally false").
- Money/PII/ledger semantics unchanged. Per-brand isolation is the whole point — verify NON-INERT.
- Keep dev working: after the change, `pnpm dev` (app as `brain_app`) must still serve the dashboard with data for a logged-in brand (the running stack will be switched at merge).

## Non-goals (other Tier-1 tracks / follow-on)
- Track B (Dockerfiles/deploy), Track C (observability/back-pressure/dedup-ordering), Track D (attribution wiring), Track E (Canon reconcile) — separate Tier-1 PRs.
- StarRocks engine ROW POLICY (enterprise) — the app-seam + this `brain_app` OLTP enforcement is the M1 isolation; documented prod graduation.
- Connection pooler / PgBouncer (Tier-2 R-34).

## Build tracks (the architect will bind)
@data-engineer (the `brain_app` role + GRANTs migration/bootstrap + the Terraform/compose/.env DSN switch + the brain_app-proven isolation+reads-still-work live test — assert is_superuser=false first) ∥ @backend-developer (the `@brain/db` transaction-wrap of the GUC+query backporting `withBrandTxn`; the StarRocks isProduction fail-closed guard; ensure login + a representative BFF brand-scoped read return data under `brain_app`). Verify: app runs as `brain_app` (is_superuser=false) AND brand-scoped reads STILL return the brand's rows (A2 works) AND cross-brand/no-GUC → 0 rows (non-inert) AND A1+A2 are atomic (no login outage) AND StarRocks prod-guard throws when unset; tsc/build green; existing isolation/parity suites still pass under `brain_app`.
