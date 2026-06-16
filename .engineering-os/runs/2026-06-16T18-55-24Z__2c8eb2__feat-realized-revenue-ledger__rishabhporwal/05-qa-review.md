# QA Review — feat-realized-revenue-ledger
**Stage:** 5 · **Mode:** FULL · **Verdict:** PASS · **Date:** 2026-06-16
**Reviewer:** QA Engineer (qa-engineer)
**Run:** `.engineering-os/runs/2026-06-16T18-55-24Z__2c8eb2__feat-realized-revenue-ledger__rishabhporwal/`
**Branch:** `feat/realized-revenue-ledger` · **Scope:** ledger diff only (`git diff d4e046f~1..HEAD`)

---

## Summary

All 30 ledger tests PASS on a live Postgres database. All 9 required test categories from architecture §6 are present, non-inert, and non-tautological (on the load-bearing assertions). The full prior-passing suite (132 tests) is green — no regressions. Typechecks exit 0 for all three packages. Migration 0018 is confirmed applied with all structural invariants proven in the live DB. 0 blocking findings.

---

## Typechecks (PASS)

| Command | Exit |
|---|---|
| `pnpm --filter @brain/money typecheck` | EXIT:0 |
| `pnpm --filter @brain/core typecheck` | EXIT:0 |
| `pnpm --filter @brain/stream-worker typecheck` | EXIT:0 |

---

## Migration 0018 — Live DB Verification (PASS)

Verified directly against `postgres://brain:brain@localhost:5432/brain`:

| Check | Result |
|---|---|
| `realized_revenue_ledger` table exists | YES |
| `amount_minor` type | bigint |
| `rounding_adjustment_minor` type | bigint |
| Dedup UNIQUE index | `(brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))` |
| Partial as-of index | `(brand_id, economic_effective_at) WHERE event_type <> 'provisional_recognition'` |
| RLS policy | `USING (brand_id = current_setting('app.current_brand_id', true)::uuid)` — two-arg form confirmed |
| brain_app grants | INSERT, SELECT ONLY — no UPDATE, no DELETE |
| Currency trigger | `trg_ledger_currency BEFORE INSERT → ledger_currency_matches_brand()` |
| `realized_gmv_as_of` function | `COALESCE(SUM(amount_minor),0)::BIGINT WHERE event_type <> 'provisional_recognition'` |
| `brand.cod_recognition_horizon_days` | INT DEFAULT 25 |
| `brand.prepaid_recognition_horizon_days` | INT DEFAULT 7 |
| `brand.currency_code` | CHAR(3) DEFAULT 'INR' |

---

## Test Suite Run (PASS — 132/132)

```
pnpm --filter @brain/core exec npx vitest run --reporter=verbose

 Test Files  12 passed (12)
       Tests  132 passed (132)
    Start at  23:38:15
    Duration  442ms
VITEST_EXIT:0
```

All 30 ledger tests within the full 132-test suite. No regressions in prior-passing tests.

---

## Closed-Sum / No-Double-Count (NON-TAUTOLOGICAL — PROVEN)

- After `provisional_recognition(+100000n)`: `realized_gmv_as_of` = **0n** (provisional excluded)
- After `finalization(+100000n)`: `realized_gmv_as_of` = **100000n** (correct realized GMV)
- Naive `SUM(amount_minor)` (includes provisional) = **200000n** — WRONG (double-count)
- `realized != naiveSum` asserted explicitly — proves the named function is load-bearing (D-3)
- After `refund(-100000n)`: `realized_gmv_as_of` = **0n** — signed closed-sum netted to zero

The golden fixture uses independently-derived expected values (100000n from the spec, 0n from the mathematical certainty finalization+refund=0). **Not tautological.**

---

## Append-Only by GRANT (NEGATIVE CONTROL — CAPTURED)

| Operation | Connection | Result |
|---|---|---|
| UPDATE realized_revenue_ledger ... | brain_app | `permission denied for table realized_revenue_ledger` |
| DELETE FROM realized_revenue_ledger ... | brain_app | `permission denied for table realized_revenue_ledger` |

This is structural immutability — not convention. The grant table confirms brain_app: INSERT, SELECT only.

---

## Dual-Date Immutability (PROVEN)

- June finalization (`occurred_at=2026-06-01`): `billing_posted_period='2026-06'`, `amount_minor=+75000n`
- July RTO reversal (`occurred_at=2026-07-05`): `billing_posted_period='2026-07'`, `amount_minor=-75000n`
- June rows queried after July reversal: **1 row unchanged at +75000n**
- July row: **1 new row at -75000n in period 2026-07**
- No edit to June rows — append-only dual-date confirmed

---

## No-Float Money (PASS)

- DB: both `_minor` columns are `bigint` — confirmed via `information_schema.columns`
- Migration SQL: grep for NUMERIC/FLOAT/REAL/DOUBLE on `_minor` lines returns 0 hits
- Recognition engine source scan: no `parseFloat` or `* 1.0` on money identifiers
- ESLint `no-float-money`: fires 4 warnings on `tools/eslint-rules/fixtures/bad-float-money.ts` (severity='warn' for fixtures/ by design per eslint.config.mjs:120; production source gets 'error' at line 112)

---

## Single-Currency Guard (PASS)

- INSERT with `currency_code='AED'` into brand with `currency_code='INR'` → trigger EXCEPTION: `currency mismatch: ledger row currency=AED but brand aaaaa018-... currency=INR. All ledger rows for a brand must share its currency_code.`
- INSERT with `currency_code='INR'` → succeeds
- Structural enforcement (BEFORE INSERT trigger), not app-only convention

---

## Isolation Negative Controls under brain_app (NON-INERT — PROVEN)

All tests run under `brain_app` (NOSUPERUSER NOBYPASSRLS — confirmed: `is_superuser=false`).

| Test | Result |
|---|---|
| `current_user = 'brain_app'` | YES |
| `is_superuser = false` | YES |
| No GUC → row count | 0 (or uuid cast error — fail-closed behavior) |
| brand-A GUC, query brand-B rows | COUNT=0 (RLS blocked) |

Dev superuser `brain` bypasses RLS — all isolation tests run under app role. Confirmed.

---

## Replay Idempotency (PASS)

Same Bronze event emitted 3×:
- Insert 1: `true` (row written)
- Insert 2: `false` (dedup conflict, ON CONFLICT DO NOTHING)
- Insert 3: `false` (dedup conflict)
- DB row count: **1**
- `ledger_replay_suppressed_total[BRAND_A:provisional_recognition]` = **2**

---

## Banker's Rounding (PASS — 10 golden fixtures)

| Input | Expected minor | Result |
|---|---|---|
| 0.5 (50/100) | 0 | 0n |
| 1.5 (150/100) | 2 | 2n, adj=-50n |
| 2.5 (250/100) | 2 | 2n |
| 3.5 (350/100) | 4 | 4n |
| 4.5 (450/100) | 4 | 4n |
| 1.4 | 1 | 1n |
| 1.6 | 2 | 2n |
| 2.0 (exact) | 2 | 2n |
| -0.5 | 0 | 0n |
| -1.5 | -2 | -2n |

`adjustment_minor` = -50n for 1.5→2 (non-zero, confirms no silent truncation)

---

## Horizon Finalization Logic (PASS)

| Scenario | Result |
|---|---|
| COD provisional 30d past, no RTO | QUALIFIES (appears in finalization query) |
| COD provisional 30d past, WITH rto_reversal | DOES NOT qualify (RTO pre-check) |
| Provisional 10d past prepaid horizon (7d) | QUALIFIES under 7d |
| Same provisional 10d past COD horizon (25d) | DOES NOT qualify under 25d |

---

## Verification Validity Gate (PASS)

Anti-pattern scan: `validity_check.py --paths apps/core/src/modules/measurement/tests/ EXIT:0` — no BYPASSRLS, no superuser DSNs in test code, no tautological assertions in load-bearing paths.

Negative controls documented (5 negative controls with captured RED output — see `qa-review.verdict.json#negative_control`).

---

## Findings

| ID | Severity | Blocking | Description |
|---|---|---|---|
| F-QA-01 | LOW | NO | Dead assertion `toSatisfy(() => true)` on line 759 — always passes. Adjacent real assertions on `minor` and `adjustment_minor` are load-bearing. Clean up but does not block. |
| F-QA-02 | LOW | NO | `no-float-money` ESLint severity is 'warn' on fixtures/ path — intentional per eslint.config.mjs:120. Production source gets 'error'. Not a gap. |
| F-QA-03 | LOW | NO | No mutation testing (Stryker) configured. Strong golden fixtures mitigate on critical paths. Add before next ledger slice. |

**Blocking findings: 0**

---

## Metric Parity

N/A for this slice. The metric engine / parity oracle that reads `realized_gmv_as_of` is the intelligence-engineer track in the NEXT slice (see architecture §tracks). The named function is the clean read seam. No cross-runtime parity to check in this slice by design.

---

## Real-Network Smoke

No HTTP endpoints for the ledger exist in this slice (data-plane substrate only). Live Postgres integration tests against real DB at `localhost:5432` serve as the real-datastore integration gate. HTTP smoke is required at deploy time when core exposes ledger endpoints.

---

## Operational Readiness

- Replay-suppression metric (`ledger_replay_suppressed_total`) wired as in-process counter — production would emit to the observability spine.
- Finalization job (`revenue-finalization.ts`) connects as `brain_app`, sets GUC per brand, uses ON CONFLICT DO NOTHING (idempotent, Argo re-run safe).
- D-5 reconciliation tolerance (±2–3% by W4) remains a Data Engineer Sprint-0 freeze — non-blocking for this slice per architecture §D-5.

---

## Journal

```
## 2026-06-16T18:12:00Z — QA Engineer — feat-realized-revenue-ledger
Stage: 5 · Mode: FULL · Verdict: PASS
Smoke: live Postgres (localhost:5432) — real-datastore integration; 132/132 tests EXIT:0
Parity: N/A (metric engine = next slice)
Validity: negative-controls confirmed (5 probes with captured RED output)
Next: Security Reviewer (Stage 6)
```
