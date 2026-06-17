# Rule Proposal: System/cron jobs MUST enumerate tenants via a SECURITY DEFINER fn (never a bare brain_app SELECT on a FORCE-RLS table)

**Status:** PROPOSED (not adopted — human runs `/adopt-rule`)
**Proposed by:** Engineering Advisor (final-reviewer), Stage 6
**Proposed at:** 2026-06-17
**Trigger:** 3rd distinct occurrence of the same root cause (auto-candidate bar crossed).

## The rule

Any system/cron/worker job that must enumerate tenants (brands) across a table protected by `FORCE ROW LEVEL SECURITY` with a two-arg fail-closed policy MUST do so through a `SECURITY DEFINER` function (owner = migration superuser, `SET search_path = public` pinned, `GRANT EXECUTE TO brain_app`, returning ONLY dispatch/identity columns — no tenant data content) — **OR** a dedicated superuser-scoped pool. A bare `brain_app` SELECT on the FORCE-RLS table at enumeration time (when no `app.current_brand_id` GUC is yet known) returns 0 rows on every invocation (`current_setting('app.current_brand_id', TRUE)` → NULL → policy FALSE for every row), making the job **structurally inert in production** while passing dev (where the superuser `brain` masks RLS).

After enumerating, the job MUST `set_config('app.current_brand_id', brand_id, true)` BEFORE any brand-scoped read/write. The `brand_id` authority is the fn result — never an env var, never an external API response (MT-1).

Every such fix MUST carry a **non-inert negative control**: a test asserting that a `brain_app` direct SELECT on the FORCE-RLS table WITHOUT the GUC returns 0 rows (proves the fix isn't tautological), run under `brain_app` (NOT the dev superuser, which masks RLS).

## Why it recurs

The dev DB connects as superuser `brain`, which bypasses RLS — so the inert path passes every dev test silently. The defect only surfaces in prod (`brain_app`, NOSUPERUSER NOBYPASSRLS) where there is no live consumer to notice the no-op. This is the same root family as the documented MEMORY note `dev-db-superuser-masks-rls`.

## Occurrences (3 distinct runs)

1. `feat-identity-graph` — `apps/stream-worker/src/jobs/phone-guard-reeval.ts` (run c9a1a0; SR-01 / QA-04). Fixed via 0019 `list_active_brand_ids()`.
2. `feat-realized-revenue-ledger` — `apps/stream-worker/src/jobs/revenue-finalization.ts` (run 2c8eb2; F-SEC-01). Fixed via 0019 `list_active_brand_ids()`.
3. `feat-connector-backfill` — `apps/stream-worker/src/jobs/shopify-backfill/run.ts` poll loop (run 9d50b5; SEC-BF-H1 / QA-BF-B1). Fixed via 0023 `list_queued_backfill_jobs()`.

## Reference implementations

- `db/migrations/0019_active_brand_enumeration.sql` (`list_active_brand_ids`)
- `db/migrations/0023_backfill_job_enumeration.sql` (`list_queued_backfill_jobs`)

Both: SECURITY DEFINER, STABLE, `SET search_path = public`, migration-time assertions (prosecdef=true, search_path pinned, brain_app EXECUTE), dispatch-only return columns.

## Suggested enforcement

- Architect design-gate item for any new system/cron/worker job that reads a FORCE-RLS tenant table.
- Security/QA gate: a system-job enumeration path without a SECURITY DEFINER fn (or superuser pool) + a non-inert no-GUC negative control is a BOUNCE.

## Act

`/adopt-rule system-job-force-rls-enumeration` to codify into `durable-rules/INDEX.md` + `lessons-learned.md`. (Supersedes the 2nd-occurrence watch line previously logged in `pending-stakeholder-attention.md`.)
