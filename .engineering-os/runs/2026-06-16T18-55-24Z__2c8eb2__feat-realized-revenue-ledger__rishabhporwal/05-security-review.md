# Security Review — feat-realized-revenue-ledger
**Stage:** 4 · **Mode:** FULL · **Verdict:** PASS · **Date:** 2026-06-16
**Reviewer:** Security Reviewer
**Run:** `.engineering-os/runs/2026-06-16T18-55-24Z__2c8eb2__feat-realized-revenue-ledger__rishabhporwal/`
**Branch:** `feat/realized-revenue-ledger` · **Scope:** ledger diff only (5 ledger commits)
**Skills loaded:** security-baseline, compliance-engine

---

## DELTA Re-review — 2026-06-17T00:30:00Z
**Mode:** DELTA · **Commit:** 353bfd6 · **Migration:** 0019_active_brand_enumeration.sql
**Reviewer:** Security Reviewer · **Verdict:** PASS (blocking:0)
**Delta scope:** F-SEC-01 fix verification + regression spot-check on changed lines

### F-SEC-01 — RESOLVED

**Fix:** Migration 0019 creates `list_active_brand_ids()` as a SECURITY DEFINER function (owner: superuser `brain`, `SET search_path = public`). `revenue-finalization.ts` now calls `SELECT FROM list_active_brand_ids()` instead of a bare `SELECT id FROM brand`.

**Verification (live Docker exec against brainv3-postgres-1):**

1. **SECURITY DEFINER + pinned search_path confirmed:**
   `pg_proc` query: `prosecdef=t`, `proconfig={search_path=public}` — hijack-safe.

2. **Column list — no PII, no tenant data:**
   Function body (pg_proc.prosrc): `SELECT id, cod_recognition_horizon_days, prepaid_recognition_horizon_days, currency_code FROM brand WHERE status = 'active'`. Columns NOT exposed: `organization_id`, `display_name`, `domain`, `identity_salt_ciphertext`, `region_code`, `timezone`.

3. **Enumeration under brain_app: 173 (was 0):**
   `psql -U brain_app -d brain -c "SELECT count(*) FROM list_active_brand_ids();"` → `173`. F-SEC-01 is definitively fixed.

4. **FORCE RLS negative control intact:**
   `psql -U brain_app -d brain -c "SELECT count(*) FROM brand WHERE status='active';"` → `0`. brain_app still cannot enumerate brands directly.

5. **brain_app EXECUTE confirmed:**
   `has_function_privilege('brain_app', 'list_active_brand_ids()', 'EXECUTE')` → `t`. GRANT applied in migration.

6. **Append-only-by-grant unregressed (0018 spot-check):**
   `information_schema.role_table_grants` for `realized_revenue_ledger` / `brain_app`: `INSERT`, `SELECT` only — no `UPDATE`, no `DELETE`. Untouched by 0019.

7. **0018 untouched:** `git show 353bfd6 -- db/migrations/0018_realized_revenue_ledger.sql` → empty diff.

8. **New finding check:** The SECURITY DEFINER function does not widen the data surface — it exposes only 4 operational config columns. The function owner is `brain` (superuser); the caller (brain_app) cannot escalate privileges through it beyond reading the 4-column active-brand list. No new CRITICAL, HIGH, MED finding introduced.

9. **Test verification:**
   - Test 10 sub-test 1 (`list_active_brand_ids() returns >0 under brain_app`): real probe on `appPool` (brain_app credentials), asserts `rows.length > 0` AND that bare `SELECT FROM brand` still returns 0 or uuid-cast error (non-inert negative control). Cannot be bypass-green.
   - Test 10 sub-test 2 (`finalization job core logic`): runs enumeration + per-brand INSERT loop via brain_app pool; asserts `totalFinalized === 2`, Brand F1 finalization row present, Brand F2 overdue finalization row present, RTO-protected order has 0 finalization rows. Load-bearing assertions with real DB state.

**F-SEC-01 status: RESOLVED. Verdict: PASS. Blocking findings: 0.**

F-SEC-02 (MED), F-SEC-03 (LOW), F-SEC-04 (LOW) remain OPEN/deferred/non-blocking — unchanged from prior review.
