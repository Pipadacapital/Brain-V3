# 11 — Final Review — feat-metric-engine-parity

**Stage:** 6 (Engineering Advisor — final review, the last gate before the Stakeholder) · **Mode:** FULL
**Date:** 2026-06-17 · **Branch:** `feat/metric-engine-parity` (base `master`) · **req_id:** `feat-metric-engine-parity`
**Recommendation:** **APPROVE → Stakeholder gate**
**Residual (one line):** Pre-existing F-SEC-02 (the OLD `GetRealizedGmvAsOf` autocommit-GUC gap) is carried, not regressed — must-fix-before-Phase-2; the NEW engine path is correct-by-construction.

---

## 1. Go / no-go summary

The M1 **"parity oracle green"** exit criterion is **met and re-verified by this reviewer, not merely trusted**. The TypeScript metric engine is the sole emitter of `realized_revenue` (+ `provisional_revenue`), registry-keyed `(metric_id, version)`; the parity oracle is **non-tautological** (independent raw-SQL reference with a structurally different predicate), has a **real RED proof** (1-minor perturbation → FAIL at tolerance 0), and the CI gate **now actually runs live-DB** (postgres provisioned, `brain_app` NOBYPASSRLS, migrations applied before `test:parity`, blocking, affected). Both gates (QA PASS, Security FULL-BOUNCE→DELTA-PASS) are legitimate. No scope creep, no new deployable, additive migration. **APPROVE.**

---

## 2. AC → evidence map (the M1 exit criterion)

| AC (requirement §) | Evidence (re-verified by this reviewer) | Verdict |
|---|---|---|
| Engine is the SOLE emitter of `realized_revenue` (+ provisional), registry-keyed | `realized-revenue.ts` reads ONLY via `realized_gmv_as_of()` inside `withBrandTxn`; no ad-hoc SUM. `registry.ts` `(metric_id,version)` `as const`; `resolveMetric` throws on unknown. eslint fence corrected to allow-list `!(measurement\|analytics)` — verified `eslint.config.mjs:83-95`. Registry unit: **9/9 GREEN (re-run)** | **MET** |
| `realized` = finalized rows ≤ as_of, per `currency_code`, NEVER blend | Engine returns `Map<CurrencyCode,bigint>`; F5 two_brand_two_currency proves `engineA.has('AED')=false`, `engineB.has('INR')=false`. Re-run GREEN | **MET** |
| Reads via the ledger `realized_gmv_as_of()` seam (sole as-of path) | `realized-revenue.ts:66-69` calls the named fn; no re-implemented sum | **MET** |
| `provisional` = provisional/settling rows, displayed alongside, NEVER blended into realized, never billed | New named seam `provisional_gmv_as_of()` (0020, `recognition_label IN ('provisional','settling')`); F4 proves adding provisional rows does NOT move realized (`realizedAfter==realizedBefore`) | **MET** |
| Parity oracle = engine == INDEPENDENT SQL recompute, CI-blocking on ANY delta | `reference.ts` raw SQL `recognition_label='finalized' GROUP BY currency_code`, imports ONLY `pg` type. Parity suite **16/16 GREEN (re-run)**, tolerance 0 | **MET** |
| Golden fixtures: clean / full-RTO / partial-refund / multi-currency | F1=50000n, F2=0n (RTO nets), F3=35000n (refund), F5 INR+AED. Re-run GREEN | **MET** |
| Money: integer minor units, NO floats, per-currency, FX never blended | `checkParity` delta is `bigint` (no `Math.abs`); all money fields `bigint`; engine src zero float matches; `no-float-money` lint = error | **MET** |
| Per-brand isolation under `SET ROLE brain_app`; cross-brand = 0; no PII | ISO-1 `current_user=brain_app`,`is_superuser=false`; ISO-2 (strengthened) seeds 100000n INR under Brand A, Brand B engine sees 0n INR (ACTIVE RLS block) + own 30000n AED (non-degenerate); ISO-3 no-GUC fail-closed | **MET** |
| CI gate wired blocking + affected | `pr.yml:69` `test:parity --affected`, no `continue-on-error`; `turbo.json` edge `dependsOn: [@brain/metric-engine#build, ^build]`; **affected dry-run re-run lists both packages** | **MET** |

**All ACs MET.** No unmet AC.

---

## 3. The heart is real — spot-verified at source (not trusted)

1. **Non-tautological reference (D-2 CRITICAL).** `tools/parity-oracle/src/reference.ts` — re-read line by line. The only `import` is `import type { PoolClient } from 'pg'` (line 30). The two `@brain/metric-engine` string hits are both **comments** (the "MUST NOT import" warnings, lines 5/32) — confirmed by grep. The SQL uses `recognition_label = 'finalized' GROUP BY currency_code`, structurally different from the engine's seam (`event_type <> 'provisional_recognition'`, scalar BIGINT). It calls neither `realized_gmv_as_of` nor `provisional_gmv_as_of`. **Genuinely independent.**
2. **RED proof is real (not a console log).** `parity.test.ts` section C carries hard assertions: `expect(result.passed).toBe(false)` + `expect(result.delta).toBe(1n)`, then reverted `expect(...passed).toBe(true)` + `.toBe(0n)`. Re-run captured: `FAIL: TS=50001 REF=50000 delta=1 > tolerance=0` then `PASS ... delta=0`. QA also ran a **live source perturbation** (`realized-revenue.ts:73` `+1n` → 8 fixtures RED → revert → 16 GREEN) recorded in `negative_control[]`. **The gate bites.**
3. **CI runs live-DB (the SEC-001 fix is real, not a wave-through).** `pr.yml` `lint-typecheck-unit` job now has `services: postgres:16` (health-checked), `DATABASE_URL` + `BRAIN_APP_DATABASE_URL` in env, a provision step that creates `brain_app` `LOGIN NOSUPERUSER ... NOBYPASSRLS` and runs `pnpm migrate:up` (line 61) **before** `test:parity` (line 69). Before the fix the parity step threw ECONNREFUSED in Actions — a green-because-it-never-ran. Now it genuinely executes. **A real fix.**
4. **No blend / no float / isolation under brain_app / sole-emitter** — all re-verified above (§2).
5. **Cost paradigm (tier-0).** Grep for any model/LLM/gateway call across both packages: **zero matches.** Every op is a SQL aggregate, a typed registry lookup, or a `bigint` equality. The plan's `$0/mo, 0 tokens/day` holds; no paradigm escalation.

**Reviewer re-runs (≥3 gates replicated with captured output):**
- `typecheck @brain/metric-engine` + `@brain/tool-parity-oracle` → EXIT 0 / EXIT 0
- `test:parity` → **16/16 GREEN**, all 5 fixtures + live RED PROOF captured
- `test:unit @brain/metric-engine` → **9/9 GREEN**
- `turbo run test:parity --affected --dry-run` → both `@brain/metric-engine` and `@brain/tool-parity-oracle` in scope (CI edge fires on engine changes)
- `validity_check --paths` → clean, 9 files, no bypass-green / tautology / inert-probe

---

## 4. Both gates legitimate

- **QA (Stage 5):** PASS, 0 blocking. 2 LOW findings (QA-F1 dirty-DB idempotency, QA-F2 ISO-2 absence-vs-block) — both deferred to M2, and QA-F2 was in fact **strengthened in the bounce** (ISO-2 now an active RLS block). `negative_control[]` present with captured RED output → verification validity satisfied. Legitimate.
- **Security (Stage 4):** FULL BOUNCE (SEC-001 HIGH: CI had no postgres → parity gate could not run live) → fix (`08dcc2f` CI postgres + brain_app NOBYPASSRLS provisioning + migrate before parity; `7d92fb8` ISO-2; `7a55c10` afterEach) → DELTA PASS. I confirmed the bounce was a **real fix** (the gate genuinely runs in CI now), not a wave-through — see §3.3. Legitimate.

---

## 5. Deferred dispositions (ship-as-techdebt vs must-fix)

| Item | Disposition | Rationale |
|---|---|---|
| **F-SEC-02 carry-in** (old `GetRealizedGmvAsOf` autocommit-GUC reset gap) | **SHIP — carried tech-debt; must-fix-before-Phase-2** | Re-confirmed at source: `GetRealizedGmvAsOf.execute()` still sets `set_config(...,true)` with **no wrapping BEGIN/COMMIT** (the pre-existing gap). This slice does NOT regress it — the NEW engine path uses `withBrandTxn` (explicit txn-scoped GUC), correct-by-construction. Worst case on the old path is fail-closed (two-arg `current_setting(...,TRUE)` → NULL → 0 rows). Not on this slice's critical path; tracked. |
| **SEC-003 (LOW)** report-omission (dev report claimed 16/16 without noting first-run dirty-DB failure) | **SHIP — non-blocking, NOTED** | Eliminated by the SEC-002 fix (describe-level afterEach); two-run repeatability confirmed. A reporting-hygiene note, not a code defect. |
| QA-F1 / QA-F2 (LOW) | **SHIP — deferred M2** | QA-F1 is local-dev-only (CI starts clean). QA-F2 already strengthened to an active RLS block in the bounce. |

None of the deferred items is a CRITICAL/HIGH or an unmet AC. All are correctly ship-as-tech-debt with named must-fix milestones.

---

## 6. Scope / canon

- **No new deployable:** engine = in-process lib (already declared `workspace:*` in `apps/core/package.json`); oracle = CI-only test runner. Confirmed.
- **Migration 0020 additive** (I-E02): `CREATE OR REPLACE FUNCTION` only, no ALTER/DROP of existing objects, SECURITY INVOKER with a migration-time assertion that fails on a future `SECURITY DEFINER` edit, reversible (`DROP FUNCTION IF EXISTS`). Confirmed at source.
- **eslint-fence change is a bug-fix, not a policy change:** the prior rule over-blocked (denied ALL core-modules); corrected to its own documented intent (measurement+analytics allow-list). No new ADR/STACK layer. Flagged for the decision log only.
- **Scope honored:** only `realized_revenue` + `provisional_revenue`; the other registry metrics, the Analytics API/dashboard, StarRocks/marts, billing meter are all out of scope and untouched. No scope creep.
- **Over-engineering audit:** files/deps/abstractions all map to a plan binding (D-1..D-7 + bigint-fixtures). No speculative table/service/queue; the TS compile-time registry was chosen over the Postgres `metric_definition` table for M1 (smallest-safe). **Clean.**

---

## 7. Hard-rule deviation check

- Dependency violation: none (workspace:* is the repo's established protocol).
- Single-Primitive violation: none (extend-only — one engine, one money lib, one no-float rule, one fence, one parity harness, one CI step).
- Compliance/tenancy gap: tenant isolation enforced at the seam (SECURITY INVOKER + RLS), the engine (`withBrandTxn`), and the test (`brain_app` pool, active RLS block). No PII.
- Paradigm escalation beyond plan: none (tier-0, zero model calls verified).
- Un-codified gate-skip: none (the parity gate is blocking + affected and now runs live-DB in CI).

**No hard-rule deviation. Auto-approvable under the final-review mandate → recommend to Stakeholder.**

---

## 8. Verdict

**APPROVE → Stakeholder gate (Stage 7).** The "parity oracle green" M1 exit criterion is genuinely met: a non-tautological, RED-proven, CI-blocking live-DB parity gate; sole-emitter engine; per-currency no-blend; no float; isolation under `brain_app`; no scope creep; no new deployable. Residual is the pre-existing F-SEC-02 (carried, not regressed, must-fix-before-Phase-2).

The Stakeholder weighs: (a) accepting F-SEC-02 + SEC-003 as carried tech-debt with the Phase-2 must-fix on the old `GetRealizedGmvAsOf` path; (b) the QA-F1/F2 M2 deferrals; (c) the commit/merge of `feat/metric-engine-parity`.
</content>
</invoke>
