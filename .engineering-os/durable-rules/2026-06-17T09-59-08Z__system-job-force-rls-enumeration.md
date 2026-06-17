# Durable Rule — system-job-force-rls-enumeration

> An ADOPTED operating rule for the team. Read by every agent at session start.
> Mutation rule: append-only by date — a new rule can supersede an old one, but old rules are NEVER edited or deleted.

| Field | Value |
|---|---|
| **rule_id** | `system-job-force-rls-enumeration` |
| **adopted_at** | 2026-06-17T09:59:08Z |
| **adopted_by** | stakeholder (rishabhporwal) |
| **sourced_from_proposal** | `.engineering-os/rule-proposals/system-job-force-rls-enumeration.md` |
| **scope** | all-agents (architect design-gate; security + QA bounce criterion; data/backend builders) |
| **status** | active |

---

## Rule text

> Any system/cron/worker job that must enumerate tenants (brands) across a table protected by `FORCE ROW LEVEL SECURITY` with a two-arg fail-closed policy MUST do so through a `SECURITY DEFINER` function (owner = migration superuser, `SET search_path = public` pinned, `GRANT EXECUTE TO brain_app`, returning ONLY dispatch/identity columns — no tenant data content) — OR a dedicated superuser-scoped pool. A bare `brain_app` SELECT on the FORCE-RLS table at enumeration time (when no `app.current_brand_id` GUC is yet known) returns 0 rows on every invocation (`current_setting('app.current_brand_id', TRUE)` → NULL → policy FALSE for every row), making the job **structurally inert in production** while passing dev (where the superuser `brain` masks RLS).
>
> After enumerating, the job MUST `set_config('app.current_brand_id', brand_id, true)` BEFORE any brand-scoped read/write. The `brand_id` authority is the fn result — never an env var, never an external API response (MT-1).
>
> Every such fix MUST carry a **non-inert negative control**: a test asserting that a `brain_app` direct SELECT on the FORCE-RLS table WITHOUT the GUC returns 0 rows (proves the fix isn't tautological), run under `brain_app` (NOT the dev superuser, which masks RLS).

---

## How agents must apply this

- **Architect (Stage 2):** for any NEW system/cron/worker job that reads a FORCE-RLS tenant table, the plan MUST bind a SECURITY DEFINER enumeration fn (or a dedicated superuser pool) + the GUC-before-tenant-read ordering. Flag it as a design-gate item.
- **Data/Backend builders (Stage 3):** implement enumeration via the SECURITY DEFINER fn (mirror `db/migrations/0019_active_brand_enumeration.sql` / `0023_backfill_job_enumeration.sql`: SECURITY DEFINER, `STABLE`, `SET search_path = public` pinned, migration-time assertions for `prosecdef=true` + search_path + `brain_app` EXECUTE, dispatch-only return columns). `set_config('app.current_brand_id', …)` before any brand-scoped read. Ship a non-inert no-GUC negative-control test under `brain_app`.
- **Security + QA reviewers (Stage 4/5):** a system-job enumeration path that does a bare `brain_app` SELECT on a FORCE-RLS table (no SECURITY DEFINER fn / no superuser pool), OR that lacks a non-inert no-GUC negative control, is a **BOUNCE** (HIGH — the job is inert in prod, masked in dev).
- **All:** verify isolation under `SET ROLE brain_app` (NOSUPERUSER NOBYPASSRLS) — the dev superuser `brain` masks RLS and will pass an inert path silently. See memory `dev-db-superuser-masks-rls`.

---

## Exceptions (if any)

- A job that already runs WITHIN a brand's GUC context (the `app.current_brand_id` is set before the job's first tenant-table read — e.g. a request-scoped job, not a cross-tenant enumerator) does not need the SECURITY DEFINER fn — verifier: the code path provably sets the GUC before any FORCE-RLS read, and reads only the one brand's rows.

---

## Supersession history

- Supersedes the 2nd-occurrence watch line previously logged in `pending-stakeholder-attention.md` (the `feat-identity-graph` + `feat-realized-revenue-ledger` watch entry).

---

## Rule decay check

| Check | When |
|---|---|
| Has this rule fired (bounced something) in the last N children? | Reviewed at every Engineering Advisor Stage 1 dependency check |
| Has the rule become redundant with codified workflow (e.g. a lint/CI gate that fails an inert enumeration)? | Surfaced if same lesson appears in N consecutive retros — if a CI gate enforces it mechanically, propose supersession |
| Has the evidence (RLS posture / the dev-superuser masking) materially changed? | Surfaced when reviewing durable-rules against the current Canon |

Occurrences that produced this rule: `feat-identity-graph` (phone-guard-reeval), `feat-realized-revenue-ledger` (revenue-finalization), `feat-connector-backfill` (shopify-backfill/run.ts → SEC-BF-H1, fixed via 0023).
