# 05 Security Review — feat-metric-engine-parity

## FULL Review (prior verdict: BOUNCE)

Prior verdict issued 2026-06-17T01:30:00Z. SEC-001 HIGH blocked merge. SEC-002 MED and SEC-004 LOW open.

---

## DELTA Re-review — 2026-06-17T01:45:00Z

**Mode:** DELTA
**Scope:** SEC-001 HIGH · SEC-002 MED · SEC-004 LOW · QA-F2/ISO-2 strengthening
**Commits under review:** 08dcc2f, 7d92fb8, 7a55c10

### Gate checks

**1. YAML validity**
`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/pr.yml'))"` — EXIT 0, output: YAML_VALID: OK.

**2. SEC-001 — postgres service + brain_app NOBYPASSRLS + migrations before test:parity**

`.github/workflows/pr.yml:16-29` — `services: postgres: image: postgres:16` with health-cmd `pg_isready -U brain -d brain`, health-interval 5s, health-retries 10. Job env at lines 31-32: `DATABASE_URL: postgres://brain:brain@localhost:5432/brain`, `BRAIN_APP_DATABASE_URL: postgres://brain_app:brain_app@localhost:5432/brain`. Both vars present.

`.github/workflows/pr.yml:43-61` — "Provision brain_app login role and apply migrations" step creates brain_app with `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` (line 53). BYPASSRLS is explicitly absent. The ELSE branch (`ALTER ROLE brain_app LOGIN PASSWORD 'brain_app'`) does not add BYPASSRLS. Migration 0001's NOSUPERUSER/NOBYPASSRLS assertion is preserved. `pnpm migrate:up` runs at line 61 BEFORE the `test:parity` step at line 69.

ECONNREFUSED: eliminated. The CI gate now runs live-DB in GitHub Actions.

**SEC-001: RESOLVED**

**3. SEC-004 — turbo.json globalPassThroughEnv**

`turbo.json:4` — `globalPassThroughEnv` array confirmed to contain `DATABASE_URL` and `BRAIN_APP_DATABASE_URL` (python3 json parse: both True). Turbo passes both into the `test:parity` task.

**SEC-004: RESOLVED**

**4. QA-F2 / ISO-2 — active RLS block (not absence-of-data)**

`tools/parity-oracle/src/parity.test.ts:532-563` — ISO-2 now seeds Brand A with two finalized rows totalling 100000n INR, AND seeds Brand B with 30000n AED. The engine is then called as Brand B (GUC = BRAND_PARITY_B). Result: Brand B sees 0n INR (RLS actively blocked Brand A's 100000n INR — the rows exist, they are blocked) and 30000n AED (own rows visible — non-degenerate assertion). Symmetric check: engine as Brand A sees 100000n INR and 0n AED. This test FAILS if RLS is removed.

**QA-F2/ISO-2: RESOLVED (active block, not absence-of-data)**

**5. SEC-002 — describe-level afterEach guards**

`tools/parity-oracle/src/parity.test.ts`:
- describe D (Isolation): `afterEach` at line 519-521
- describe E (Per-currency): `afterEach` at line 604-606
- describe F (Provisional no-blend): `afterEach` at line 632-634

Each calls `clearLedgerRows(BRAND_PARITY_A, BRAND_PARITY_B)`. Cleanup runs even on test failure.

**SEC-002: RESOLVED**

**6. Parity suite — tolerance still 0, no new weakening**

Two back-to-back runs:
- Run 1: 16/16 PASS, EXIT 0
- Run 2: 16/16 PASS, EXIT 0

All fixtures confirmed:
- F1 clean_finalized: engine=INR:50000n ref=INR:50000n delta=0
- F2 full_rto_to_zero: engine=INR:0n ref=INR:0n delta=0
- F3 partial_refund: engine=INR:35000n ref=INR:35000n delta=0
- F4 provisional_plus_finalized: realized=INR:50000n prov=INR:20000n (no blend)
- F5 two_brand_two_currency: BrandA=INR:50000n BrandB=AED:30000n (no cross-brand)
- RED PROOF: 50001n engine vs 50000n ref → FAIL delta=1 > tolerance=0 (gate is real)
- ISO-2: 0n INR visible under Brand B GUC despite 100000n seeded under Brand A

No new findings introduced. Tolerance remains 0. Non-tautological oracle unchanged.

**Parity gate: GREEN, re-runnable, deterministic**

**7. Verification validity**

- ISO-2 is not bypass-green: it seeds real rows for Brand A and asserts Brand B cannot see them. If RLS were dropped, the assertion `expect(inrUnderBrandB).toBe(0n)` would fail because 100000n INR would be visible. The test has a live negative control (Brand B's own AED rows are visible at 30000n), ruling out an absent-data false pass.
- afterEach guards run unconditionally per describe block — cleanup is not contingent on test body completion.
- Both runs are live-DB (not mocked): `beforeAll` verifies `superPool` and `appPool` connect with `SELECT 1` before any test body executes.

---

## DELTA Verdict

**PASS — all prior BOUNCE findings resolved. No new findings. Blocking findings: 0.**

```
[SECURITY] DELTA Re-review: feat-metric-engine-parity
Scope: SEC-001 HIGH (resolved), SEC-002 MED (resolved), SEC-004 LOW (resolved), QA-F2/ISO-2 (resolved)
Verdict: PASS   Accepted by: Security Reviewer on 2026-06-17
```
