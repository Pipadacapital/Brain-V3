# Final Review — feat-realized-revenue-ledger
**Stage:** 6 · **Reviewer:** Engineering Advisor (final-review, opus) · **Date:** 2026-06-16
**Run:** `.engineering-os/runs/2026-06-16T18-55-24Z__2c8eb2__feat-realized-revenue-ledger__rishabhporwal/`
**Branch:** `feat/realized-revenue-ledger` (STACKED on shipped identity; judged ONLY the ledger diff `git diff d4e046f~1..HEAD`)

## Recommendation: **APPROVE → Stakeholder gate**

**Residual (one line):** the `revenue-finalization` Argo job is a runtime no-op under `brain_app` FORCE-RLS brand-enumeration (F-SEC-01, HIGH) — fail-closed (no provisional ever finalizes; nothing leaks, nothing miscounts), recoverable by fix + replay; the ledger substrate itself (append-only, no-double-count, dual-date, no-float, isolation) is correct and proven live.

---

## 1. Requirement delivered — AC → evidence (all met)

| AC (from `01-requirement.md` DELIVER 1–7) | Evidence (independently re-verified where noted) |
|---|---|
| **1. ONE append-only ledger, event_type discriminator, 10 types, signed `amount_minor`, original row never edited** | `0018_*.sql:61-96` single table + CHECK over the exact 10 event_types; `amount_minor BIGINT` signed; append-only by GRANT (AC5). **RE-VERIFIED:** `brain_app` UPDATE/DELETE → `permission denied` (live, non-superuser). |
| **2. Money discipline — `amount_minor BIGINT` + `currency_code CHAR(3)` paired, no floats, math via `packages/money`** | Both `_minor` cols `bigint` (Assertion-3 + live `information_schema`); grep clean for NUMERIC/REAL/DOUBLE/FLOAT on money cols; `no-float-money` ESLint fires 4 warns on the bad fixture; only addition to `packages/money` is `roundToMinorBankers` (1 fn — no scope creep). |
| **3. Dual-date — `occurred_at` + `economic_effective_at` + `billing_posted_period`; closed periods immutable; late reversal restates current** | `0018_*.sql:83-86`; writer sets `billing_posted_period=to_char(occurred_at,'YYYY-MM')`. Test 3a: June fin (+75000, '2026-06') untouched after July RTO (−75000, '2026-07') — 2 separate rows/periods. M1 has no `billing_run` so all periods open (correct per plan D-2). |
| **4. COD horizon — provisional→finalization at brand-configurable horizon; job emits on horizon w/o RTO/cancel** | `brand.cod_recognition_horizon_days=25`, `prepaid=7` (live). Job `revenue-finalization.ts` RTO/cancel pre-check + finalization-exists guard. Test 9a–9c: 30d-past-no-RTO qualifies; with RTO does not; prepaid-7d vs COD-25d distinguished. **Caveat:** job no-ops at runtime — see F-SEC-01. |
| **5. Per-brand isolation — brand-scoped, RLS FORCE fail-closed, `brain_id` not PII, cross-brand=0 under `brain_app`** | ENABLE+FORCE RLS, two-arg `current_setting(...,TRUE)` (NN-1 assertion green). **RE-VERIFIED live:** brand-A GUC sees 0 brand-B rows; no GUC → 0 (fail-closed); `brain_id UUID NULL`, no PII columns. |
| **6. As-of realized GMV — named function = signed sum, closed-sum, replayable/rebuildable** | `realized_gmv_as_of(uuid,date)` STABLE SECURITY INVOKER, excludes `provisional_recognition`. **RE-VERIFIED live:** fn=100000 vs naive SUM=200000 (DIFFER → non-tautological, load-bearing); after refund → 0. Replay: 3× emit → 1 row, suppressed counter=2. |
| **7. Automated tests — closed-sum, clawback, dual-date, no-float lint, isolation, replay, currency, horizon** | 30/30 ledger tests, 132/132 full suite — **RE-RAN green (306ms)**. All 9 architecture §6 categories present, non-inert, non-tautological. 5 negative controls with captured RED output. |

**`ac_unmet: none.`** The money/isolation heart — append-only, no-double-count, dual-date, no-float, cross-brand=0 — is fully delivered and structurally enforced (by GRANT + trigger + named fn), not by convention.

---

## 2. Gates re-run (≥3 required; 5 re-run/independently re-verified)

| Gate | Method | Result |
|---|---|---|
| Full ledger suite | `npx vitest run ...live.test.ts` | 30 passed (replicated QA's 30/30) |
| Append-only-by-GRANT | live `UPDATE`/`DELETE` as `brain_app` (non-superuser, `is_super=f`) | both `permission denied`; grants = SELECT,INSERT only |
| Closed-sum non-tautology | live: fn vs naive SUM on a provisional+finalization fixture | fn=100000, naive=200000 — **DIFFER** (function is load-bearing) |
| Closed-sum nets | live: +finalization, −refund | `realized_gmv_as_of=0` |
| Single-currency guard | live: INSERT AED into INR brand | trigger RAISEs `currency mismatch` |
| Isolation | confirmed `brand` + ledger both FORCE RLS; brand policies GUC-gated | no-GUC enumeration → 0 rows (this is also the F-SEC-01 root cause) |

Every QA PASS I attempted to replicate, replicated. No bounce-to-Stage-5 condition.

---

## 3. Both gates PASS legitimately (no bounce)

- **Security** (`security-review.verdict.json`): PASS, `blocking:0`. F-SEC-01 HIGH is non-blocking-by-disposition (ops, fail-closed). F-SEC-02 MED, F-SEC-03/04 LOW.
- **QA** (`qa-review.verdict.json`): PASS, `blocking:0`. 132/132. `negative_control[]` carries 5 probes with captured RED output; `validity_check_exit:0`; closed-sum non-tautological; append-only test makes a real UPDATE attempt. Negative-control validity confirmed on the tenancy/money paths — no bypass-green, no inert probe, no tautological parity. F-QA-01/02/03 all LOW non-blocking.

No verification I could not replicate. No green-under-bypass. No empty negative control on a money/tenancy/auth path.

---

## 4. Deferred dispositions

| ID | Sev | Disposition | Rationale |
|---|---|---|---|
| **F-SEC-01** | HIGH | **SHIP-AS-TECHDEBT for M1; P1 must-fix before prod scale** | The finalization job enumerates `brand` under `brain_app` with no GUC; `brand` has FORCE RLS → 0 brands → job no-ops every run. **Direction is FAIL-CLOSED:** no provisional ever finalizes, so realized GMV is *understated*, never overstated — no double-count, no leak, no false realization. Fully recoverable (fix enumeration + replay; ledger is rebuildable from Bronze in M1). M1 is synthetic/internal, low volume, and the metric engine that *reads* finalized GMV is the NEXT slice — so a no-op finalizer does not corrupt any downstream number that ships in M1. **Fix:** a `SECURITY DEFINER` brand-enumeration fn (job stays `brain_app`) or a dedicated superuser-scoped enumeration pool for cross-tenant system jobs. **Accept for M1? YES** — fail-closed + recoverable + no M1 consumer. The Stakeholder must accept this consciously (it is the deploy-gate question for this slice). |
| **F-SEC-02** | MED | SHIP-AS-TECHDEBT | `GetRealizedGmvAsOf` uses a raw `pg.Pool` and calls `set_config` before every query, so the executing path is safe (GUC always overwritten before use). Defense-in-depth gap: a future copy omitting `set_config` would use a stale GUC. Fix: wrap in BEGIN/COMMIT or use `@brain/db` reset-at-checkout. No live exposure. |
| **F-SEC-03** | LOW | SHIP-AS-TECHDEBT | Finalization job logs `order_id`+`amount` per row. `order_id` is a merchant ref (not direct PII per the model), but plaintext financial amounts to the obs spine may be regulated. Scope logging to `brand_id`+count, or add a redaction annotation. (Moot while the job no-ops; tie the fix to the F-SEC-01 fix.) |
| **F-SEC-04 / F-QA-01** | LOW | SHIP-AS-TECHDEBT | Dead `toSatisfy(() => true)` at test:759; adjacent assertions on `minor`/`adjustment_minor` are load-bearing. Cosmetic. Clean up next slice. |
| **F-QA-02** | LOW | NOT A GAP | `no-float-money` is `warn` on `fixtures/` by design (eslint.config.mjs:120); production paths get `error` (line 112). Correct. |
| **F-QA-03** | LOW | SHIP-AS-TECHDEBT; **add Stryker before next ledger slice** | No mutation testing. The `testing-tdd` DoD wants 80%+ mutation score on money paths. The golden fixtures are strong (closed-sum, naive-SUM-must-differ, banker's-rounding deltas, finalization+refund=0) and would kill most arithmetic/relational mutants — adequate for THIS slice, but mutation testing should be wired before the metric engine reads this ledger. Non-blocking. |

**No deferred item is a CRITICAL, an unmet money/isolation AC, a fabricated proof, or a green-under-bypass.** None blocks the gate.

### The F-SEC-01 call — explicit
"The finalization job no-ops (no provisional ever finalizes) until fixed" is **acceptable for M1.** It is fail-closed (understate, never overstate), recoverable (fix + replay; rebuildable), and has no M1 consumer (the metric engine is the next slice). The ledger *substrate* — the thing this slice exists to deliver — is correct and proven. Shipping the correct, immutable, no-double-count substrate now and fixing the system-job enumeration as a P1 is the right M1 trade. The Stakeholder owns the conscious accept.

### Rule-proposal recommendation — YES (recurring pattern, 2nd occurrence)
Root cause: **a cross-tenant system/Argo job enumerates `brand` (FORCE RLS) under `brain_app` with no GUC → 0 rows → silent no-op.** This is the SAME pattern as identity's `phone-guard-reeval.ts` (prior run `c9a1a0`, finding SR-01/QA-04, P1-before-prod) — now its **2nd distinct occurrence** (`revenue-finalization.ts`). It is NOT yet codified in `lessons-learned.md` or `durable-rules/`. Per the auto-candidate rule the hard auto-write threshold is ≥3 distinct runs (this is the 2nd), so I do **not** adopt a rule myself; I **recommend** the Stakeholder file one ("cross-tenant system jobs MUST enumerate tenants via a SECURITY DEFINER function or a dedicated superuser-scoped pool — never a bare `brain_app` SELECT on a FORCE-RLS tenant table"). Added to `pending-stakeholder-attention.md`; human runs `/adopt-rule`. If it recurs a 3rd time it crosses the auto-candidate threshold and should be written without asking.

---

## 5. Scope / canon / over-engineering audit — CLEAN

- **No new deployable / ADR / stack / store / queue / Argo-job type.** Diff = ledger-only, additive, 18 files (+2360/−2). No `STACK.md`/ADR/`.yaml`/Dockerfile/`package.json` touched. Wires the existing `measurement` module + `packages/money` + an existing Argo-job type, exactly as the hard rule required.
- **Migration `0018` additive** (I-E02); down = DROP (rebuildable from Bronze in M1). Next free int after 0017.
- **doc-08 §7.1 `billing_posted_period date` → `CHAR(7)`:** an operational *tightening* (a period is a month, not an instant), not a Canon contradiction — doc-08 is descriptive of the rule, not the storage type. Bound by CTO D-2, recorded in the plan §D-2/§9(5). **Acceptable — not a Canon amendment.** Confirmed.
- **Non-goals honored:** no `billing_run`, no `fx_rate` (`fx_rate_id` always NULL), no metric engine / parity oracle / billing meter / attribution ledger / CM2 / FX. Correct.
- **Over-engineering self-check:** every column traces to doc-08 §7.1 + the D-mandated adds (`rounding_adjustment_minor`, horizon/currency brand cols). ONE ledger, ONE money lib (+1 minimal helper), ONE RLS pattern, ONE named fn, ONE trigger. No speculative abstraction. No WHAT-comments. PASS.
- **Improvement over plan (correct):** the dedup index uses `timezone('UTC', occurred_at)::date` (IMMUTABLE) rather than the plan's `occurred_at::date` (STABLE — would have failed a unique-index expression). Sound fix, not drift.

## 6. Hard-rule deviation check — NONE

No dependency violation, no Single-Primitive violation (one ledger, extend-only sweep clean), no compliance gap (no-DELETE-grant control satisfied; no PII), no un-sanctioned paradigm escalation (tier-0 deterministic throughout, zero model calls — correct for a money substrate), no un-codified gate-skip. Nothing requires Stakeholder-only escalation beyond the F-SEC-01 conscious-accept + the recommended rule-proposal, both surfaced.

---

## 7. Verdict

**PASS · APPROVE → Stakeholder gate (Stage 7).** The four load-bearing walls (append-only-by-GRANT, no-double-count named fn, dual-date immutability, no-float BIGINT) plus tenant isolation are independently re-verified live and correct. The single material residual (F-SEC-01) is fail-closed, recoverable, has no M1 consumer, and is the recurring system-job pattern that warrants a Stakeholder rule-proposal. No REJECT condition (no CRITICAL, no fabricated proof, no unmet money/isolation AC).

### Mechanical commit (explicit product-code paths — NO `git add -A`)
> Slices already committed per-slice (`d4e046f`, `2fbdb55`, `62e3e6b`, `fa8afdd`); nothing uncommitted in product code. No additional product-code commit required. The run-artifact commit (this review + verdict) is the only outstanding write:
```
git add \
  .engineering-os/runs/2026-06-16T18-55-24Z__2c8eb2__feat-realized-revenue-ledger__rishabhporwal/11-final-review.md \
  .engineering-os/runs/2026-06-16T18-55-24Z__2c8eb2__feat-realized-revenue-ledger__rishabhporwal/final-review.verdict.json \
  .engineering-os/pending-stakeholder-attention.md \
  .engineering-os/memory/agents/cto-advisor.journal.md \
  .engineering-os/live.log
git commit -m "review(eos): Stage-6 final review PASS/APPROVE — feat-realized-revenue-ledger (F-SEC-01 P1 deferred)"
```
The deploy (affected-only `core`+`stream-worker` + finalization job manifest, ArgoCD sync, NO canary) is the Stakeholder's gate, not mine.
