# PASS 9 — Journey & Attribution Audit

**Auditor:** Independent principal reviewer (AI/ML Engineer lane)
**Scope:** `packages/metric-engine` attribution modules (attribution-models, attribution-credit, attribution-clawback, attribution-confidence, attribution-reconciliation, journey-mix) · `attribution_credit_ledger` (migration 0032) · `connector_journey_stitch_map` (0031) · `apps/core/.../attribution/internal/credit-writer.ts` · the parity-oracle test · the silver.touchpoint read seam.
**Binding spec:** `.engineering-os/runs/2026-06-18T13-03-15Z__fc52d1__feat-attribution-ledger__rishabhporwal/05-architecture.md` (the attribution-ledger architecture plan, §1–§6) + `METRICS.md` rows `attribution_credit`, `attribution_reconciliation_rate`, `attribution_confidence`.

The deterministic credit/clawback math (scaled-integer weights, largest-remainder apportionment, sign-preserving reversal) is genuinely well-built and mostly correct — full-RTO mirror nets to zero exactly, weights sum to 1.0e8 for every model/N I tested, and the per-order closed-sum holds. The serious problems are at the **edges and the wiring**: the entire write-side is dead code, clawback has no over-reversal guard, the reconciliation metric is untested, and cross-device journeys are silently dropped by the stitch map's cardinality.

---

## CRITICAL

### C1 — The attribution credit write-side is dead code: nothing ever populates `attribution_credit_ledger`
**Severity:** Critical | **Category:** Wiring / dead code / data-integrity
**Evidence:**
- `apps/core/src/modules/attribution/internal/credit-writer.ts:101` `writeCredit(...)` is the ONLY path that computes + appends CREDIT rows. Grep for callers: `grep -rn "writeCredit" apps packages --include="*.ts"` returns **zero** hits outside the writer file itself and its own live test.
- The reversal/clawback fan-out hook `createAttributionReversalHook` (credit-writer.ts:295) and `OrderEventConsumer.handleReversal` (`apps/core/src/modules/measurement/internal/interfaces/consumers/OrderEventConsumer.ts:79`) are likewise **never invoked** in any composition root: `grep -rn "handleReversal\|createAttributionReversalHook\|new OrderEventConsumer" apps --include="*.ts"` (excluding tests + the defining files) returns nothing. `OrderEventConsumer` is constructed nowhere in production wiring; the stream-worker `LedgerWriter.ts:4` explicitly notes "The OrderEventConsumer in apps/core is not importable from stream-worker."
**Impact (production):** `attribution_credit_ledger` is **empty in production**. Every downstream read — `attributed_gmv_as_of`, `channel_contribution_as_of`, `computeAttributionReconciliationRate`, the by-channel UI, `attribution_confidence` — returns 0 / `unattributed = realized` / `reconciliationRatePct = 0.00`. The product ships an "attribution engine" that attributes nothing. Because the residual is `realized − attributed`, 100% of GMV silently lands in "unattributed," which reads as honest no-data rather than a broken pipeline.
**Root Cause:** Phase-5 ledger + math + writer were built and unit/live-tested in isolation, but the credit-emission trigger (on order finalization, resolve `brain_anon_id` via the stitch map → call `writeCredit`) was never connected, and the reversal hook was never injected into a running consumer.
**Recommended Fix:** Wire a credit-emission path on order recognition/finalization that resolves the order's `stitched_anon_id` from `connector_journey_stitch_map` and the realized basis from `realized_revenue_ledger`, then calls `writeCredit`. Inject `createAttributionReversalHook` into the live order-event consumer. Add an integration test asserting a recognized order produces ledger rows.
**Priority:** P0 | **Tenant Impact:** All tenants — every brand's attribution is empty. | **Detection:** No alert exists. Would surface as a support ticket ("attribution shows 0 / everything unattributed") or only if someone queries `SELECT count(*) FROM attribution_credit_ledger`.

### C2 — Clawback has no over-reversal guard: cumulative reversals can drive attributed revenue negative
**Severity:** Critical | **Category:** Money correctness / ledger invariant
**Evidence:** `packages/metric-engine/src/attribution-clawback.ts:132-186` — `computeAttributionClawback` apportions `reversalBasisMinor` over the saved weights with no check that the (cumulative) clawback magnitude ≤ the saved credited revenue. The idempotency key is the **reversal event id** (`computeClawbackCreditId`, clawback.ts:102), so two *distinct* reversal events each carrying `reversalBasisMinor = −realized` both apply. Reproduced (executed):
```
credit (realized 10001):           4001, 2000, 4000
double full-clawback (−10001 ×2):  net = −4001, −2000, −4000   ← negative attributed contribution
over-clawback (credit 100000, basis −150000): net = −20000, −10000, −20000
```
Nothing in `apportionMinor` (attribution-models.ts:178) or the writer clamps this. `channel_contribution_as_of` (0032:211) then `SUM`s a negative net per channel; `attributed_gmv_as_of` (0032:189) returns a value below 0, and `reconciliationRatePct` (attribution-reconciliation.ts:141) computes a *negative* rate via `ratePct`, which the integer-bps formatter renders with a malformed `-X.0Y` string (the `absFrac` padding only handles the fractional sign, not the whole-part sign cleanly).
**Impact (production):** A double-reversed order (RTO + chargeback on the same order, a connector re-emitting a full reversal under a new `ledger_event_id`, or a partial refund issued after a full RTO) makes a channel's attributed contribution negative. The closed-sum oracle (`Σ contribution + unattributed = realized`) still balances arithmetically, but the *economic* meaning is corrupt: a channel shows negative attributed revenue, `unattributed` exceeds `realized`, and the reconciliation rate goes negative — feeding the Decision Engine's "attribution confidence warning" / "unattributed growth ↑" detector (`09_Brain_Decision_Engine_Architecture.md:186`) with garbage.
**Root Cause:** The clawback trusts the caller-supplied `reversalBasisMinor` absolutely (comment clawback.ts:74 even documents it as "NEGATIVE" with no bound). There is no per-order running-sum invariant `Σ(credit + all clawbacks) ≥ 0`.
**Recommended Fix:** Before appending a clawback, read the current net per touch (`SUM(credited_revenue_minor) WHERE order_id+touch_seq`) and clamp `reversalBasisMinor` so cumulative clawback never exceeds the saved credit; reject (or clamp + log) an over-reversal. Add a DB CHECK or a periodic invariant job asserting `attributed_gmv_as_of ≥ 0` per (brand, model, channel).
**Priority:** P0 | **Tenant Impact:** Single-tenant per occurrence, but any brand with duplicate/over reversals. | **Detection:** No guard; surfaces as a negative `reconciliationRatePct` in the UI or a Decision-Engine false alarm.

---

## HIGH

### H1 — Cross-device journeys are silently dropped: stitch map is one-anon-per-order
**Severity:** High | **Category:** Attribution leakage / cross-device break
**Evidence:** `db/migrations/0031_connector_journey_stitch_map.sql:43` `PRIMARY KEY (brand_id, order_id)` with a single `stitched_anon_id TEXT NOT NULL` column. An order can therefore map to **exactly one** anon journey. The credit writer (`credit-writer.ts:102` `readTouches(brandId, brainAnonId)`) and the timeline `orderId` path (`journey-mix.ts:349-356`) both resolve touches only for that single anon. A buyer who browsed on mobile (anon-A) and converted on desktop (anon-B), or cleared cookies mid-journey, contributes touches under only one anon; the other device's touches are invisible to crediting.
**Impact (production):** First-touch / position-based credit systematically over-weights the converting device and under-credits upper-funnel channels seen on the other device. Paid-social/discovery channels (typically first-touch on mobile) lose credit; the order may even credit a `direct`/`last-touch` desktop session, dragging `attribution_confidence` down to `partial`/`weak` for journeys that were actually well-instrumented. This is a material accuracy gap for a product positioned as decision-grade attribution.
**Root Cause:** The deterministic-only stitch (`stitched_anon_id` read back from order `note_attributes`, D-5) captures one anon per order by construction; there is no anon-merge / identity-graph fan-in into the touch read.
**Recommended Fix:** Either (a) resolve the full anon set for an order via the identity graph (`brain_id` → all linked `brain_anon_id`s) and union their touches before crediting, or (b) explicitly document the single-device limitation and surface it in `attribution_confidence` (a multi-device-suspected journey should not grade `strong`). At minimum, add a `journey-mix` timeline path that reflects multi-anon resolution.
**Priority:** P1 | **Tenant Impact:** All multi-device brands (most D2C). | **Detection:** Invisible — no signal distinguishes "single device" from "lost the other device."

### H2 — `computeAttributionReconciliationRate` (the headline metric) has zero unit tests; the period-level oracle leg is DB-gated only
**Severity:** High | **Category:** Test coverage / metric correctness
**Evidence:** `grep -rln "computeAttributionReconciliationRate" --include="*.test.ts"` returns **nothing**. The function in `attribution-reconciliation.ts:78` does non-trivial windowing arithmetic — `attributed = attributed_gmv_as_of(to) − attributed_gmv_as_of(from−1)` (lines 108-117) and a separately-windowed `channel_contribution_as_of(from, to)` (lines 120-124) — with no pure test that the two windows agree, that `unattributedMinor = realized − attributed` is rendered, or that `ratePct` handles the negative-attributed case (see C2). The parity-oracle CI test (`attribution-parity-oracle.test.ts`) only exercises hand-rolled per-order sums (Leg 1); Leg 2 (engine-vs-independent-SQL) lives only in the **DB-gated** live test (`attribution-credit-writer.live.test.ts:214`), so it does **not** run as an unconditional CI gate despite the spec calling the parity oracle "CI-BLOCKING" (05-architecture §5, line 144).
**Impact (production):** The reconciliation rate + residual — the numbers a brand sees and the Decision Engine acts on — can regress (window off-by-one at month boundary, negative-rate formatting, residual sign) with a green CI. The "closed-sum parity oracle is CI-blocking" guarantee is partly vapor: in a no-DB CI run, only the pure per-order leg blocks.
**Root Cause:** Leg 2 was implemented as a live test (needs Postgres + RLS) rather than a pure recompute over an in-memory fixture; the reconciliation function was shipped without a unit harness.
**Recommended Fix:** Add a pure unit test for `computeAttributionReconciliationRate` over a mocked `withBrandTxn` (windowing, residual, negative-attributed). Make a pure period-level parity assertion CI-blocking (sum the per-order engine outputs and assert `Σ channel + unattributed = realized` without a DB).
**Priority:** P1 | **Tenant Impact:** All tenants. | **Detection:** A regression ships green; surfaces as a wrong headline number.

### H3 — The Leg-2 "independent SQL" recompute is not window-independent
**Severity:** High | **Category:** Parity-oracle soundness
**Evidence:** `apps/core/src/modules/attribution/tests/attribution-credit-writer.live.test.ts:228` calls `channel_contribution_as_of(..., '2026-06-01', '2026-06-30')` (which filters `economic_effective_at::date BETWEEN from AND to`) and compares it to a raw `SELECT channel, SUM(credited_revenue_minor) ... GROUP BY channel` (lines 232-235) that has **no date filter**. The two only agree because the fixture rows are all in June. The "independent" recompute therefore does not independently validate the seam's window-boundary logic (the most error-prone part — `::date` truncation of `economic_effective_at`).
**Impact (production):** The headline integrity gate ("engine == independent SQL, tolerance 0") would not catch a window-boundary bug in `channel_contribution_as_of` (e.g. an off-by-one on `>= from` / `<= to`, or `::date` truncation losing same-day reversals posted at 23:59Z). A whole class of time-window errors passes the oracle.
**Root Cause:** The independent recompute reuses an unfiltered aggregate as the "truth," not a hand-derived window-correct expectation.
**Recommended Fix:** Make the independent recompute apply the SAME `economic_effective_at::date BETWEEN` filter in raw SQL, AND add fixtures with rows straddling the window boundary (a touch at `from−1 23:59:59Z`, one at `to 00:00:01Z`) to prove the boundary.
**Priority:** P1 | **Tenant Impact:** All tenants. | **Detection:** Silent; only a hand-built boundary fixture would catch it.

---

## MEDIUM

### M1 — Dual-date window mismatch risk: as-of math windows on `economic_effective_at` but the residual mixes two seam windows
**Severity:** Medium | **Category:** Time-window boundary
**Evidence:** `attribution-reconciliation.ts:104-117` derives `realizedGmvMinor` from `realized_gmv_as_of` (0018, also `economic_effective_at::date`) and `attributedGmvMinor` from `attributed_gmv_as_of` (0032:203, `economic_effective_at::date`), both as `as_of(to) − as_of(from−1)`. But `byChannel` (lines 120-124) comes from `channel_contribution_as_of` which uses an inclusive `BETWEEN from AND to` on the same column. These align **only if** every credit and its clawback share the same `economic_effective_at::date` window. A clawback posts to the *current* open period (`billing_posted_period`, 0032:101) but its `economic_effective_at` is the reversal time (credit-writer.ts:144). If a credit's economic date is in-window and its clawback's economic date is in a *later* window, `attributedGmvMinor` (which nets the clawback as-of `to`) and `Σ byChannel` (windowed) can disagree, and the rendered `unattributed` won't equal `realized − Σ byChannel`.
**Impact:** The UI's per-channel bars (`byChannel`) and the headline `attributedGmvMinor`/residual can be internally inconsistent across a period boundary when reversals lag credits — exactly the common RTO case (order in month M, RTO in M+1).
**Root Cause:** Two different windowing semantics (cumulative-diff vs inclusive-between) over an event that legitimately spans periods (credit vs clawback economic dates differ).
**Recommended Fix:** Compute `attributedGmvMinor` as `Σ byChannel` from a single windowed seam (one source of truth), or document that the residual nets cross-period reversals while the bars don't, and reconcile them.
**Priority:** P2 | **Tenant Impact:** Brands with cross-period reversals. | **Detection:** Residual ≠ realized − Σ(channel bars) in the UI.

### M2 — Spec/implementation divergence on the dedup UNIQUE key (COALESCE on `reversed_of_credit_id`)
**Severity:** Medium | **Category:** Doc-vs-code divergence
**Evidence:** Spec 05-architecture §1 line 42 specifies the dedup index as `UNIQUE (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind)`. The migration (`0032:121-124`) adds a 7th key column `COALESCE(reversed_of_credit_id, '')`. The code is arguably **more** correct (the spec key would collide two distinct reversals of the same touch, since both are `row_kind='clawback'`), but the header comment at 0032:47 documents yet a *third* shape including `reversed_of_credit_id` directly. Three different stated keys; the PK is `(brand_id, credit_id)` (0032:104), and the writer's `ON CONFLICT` targets the PK (`credit-writer.ts:261`), **not** the dedup index — so the dedup UNIQUE is never the conflict arbiter the spec implies.
**Impact:** Replay idempotency actually rests on the deterministic `credit_id`/`clawback_id` (the PK), not the documented dedup index. The dedup index is a redundant guard whose definition contradicts the spec, creating confusion for anyone reasoning about double-clawback suppression. Two distinct reversal events of the same touch produce distinct `credit_id`s (keyed on `reversalLedgerEventId`) and both insert — which is the C2 over-clawback path.
**Root Cause:** The dedup-key design was revised during implementation (to keep distinct reversals distinct) without updating the spec, and the `ON CONFLICT` target was set to the PK, making the dedup index decorative.
**Recommended Fix:** Reconcile the spec and the three key descriptions; document that idempotency = deterministic id PK; decide whether the dedup index should be the `ON CONFLICT` target or dropped.
**Priority:** P2 | **Tenant Impact:** None directly (correctness holds via PK). | **Detection:** Code review only.

### M3 — `position_based` middle-remainder goes to endpoints, not "middles by seq" — spec text is self-contradictory
**Severity:** Medium | **Category:** Weight-distribution correctness
**Evidence:** Spec 05-architecture §2 line 63: "distribute the integer division remainder ... to touches in a deterministic order (**first touch, then last, then middles by seq**)." For `position_based` N≥3, the *middle* mass `20_000_000n/(N−2)` is what leaves a remainder, yet the code (`attribution-models.ts:151-155` `distributeRemainder`) hands those leftover units to index 0 then n−1 (the **endpoints**) first. Executed for N=11: endpoints become `40000001` each, middles stay `2222222`. So the 0.20 middle mass is *under*-distributed and the 0.40 endpoints are *over* 0.40. The unit test (`attribution-models.test.ts:84-93`) asserts exactly this endpoint-absorbs behavior — so code and test agree, but both contradict the natural reading that the *middle* remainder should stay within the middle band.
**Impact:** For N≥3 where `20_000_000` isn't divisible by `N−2` (N=5,7,9,11,…), endpoints receive a sliver of the middle's intended mass. Tiny (≤ a few hundred-millionths of weight → sub-penny on most orders) but it means "40-40-20" is not exactly held; endpoints are systematically ≥0.40. Defensible as a deterministic tiebreak, but it's a silent deviation from the model's stated semantics.
**Root Cause:** One generic `distributeRemainder` order (endpoints-first) is applied to all models; for `linear` endpoints-first is fine, but for `position_based` it bleeds middle mass into endpoints.
**Recommended Fix:** For `position_based`, distribute the middle remainder among the middle touches only (per the spec's "middles by seq"), keeping endpoints at exactly 40_000_000. Update the test literals accordingly.
**Priority:** P2 | **Tenant Impact:** All tenants, sub-penny. | **Detection:** Only a spec-literal test would catch it.

---

## LOW

### L1 — Reversal-hook fans out clawbacks across ALL four models unconditionally
**Severity:** Low | **Category:** Efficiency / correctness-by-luck
**Evidence:** `credit-writer.ts:310` `createAttributionReversalHook` loops `['first_touch','last_touch','linear','position_based']` and calls `writeClawback` for each on every reversal. It relies on `readSavedCredits` returning empty (→ no-op) for models with no saved rows. Since only the brand's active model (`position_based` default) ever has credit rows (C1 notwithstanding), three of four calls do a wasted SELECT per reversal.
**Impact:** 4× the clawback read load per reversal; harmless but wasteful. If a future change writes multiple models' credits, every reversal correctly fans out — but also quadruples write volume.
**Root Cause:** Defensive "run all models" rather than reading which models have saved credits for the order.
**Recommended Fix:** `SELECT DISTINCT model_id FROM attribution_credit_ledger WHERE order_id=$1` once, fan out only those.
**Priority:** P3 | **Tenant Impact:** None. | **Detection:** Query volume.

### L2 — `ratePct` negative-handling is fragile for the C2 path
**Severity:** Low | **Category:** Formatting robustness
**Evidence:** `attribution-reconciliation.ts:31-38` (and the duplicate in `journey-mix.ts:153`): `bps = (numerator*10000n)/denominator`; `whole = bps/100n`; `absFrac = frac<0n?-frac:frac`. When `numerator` is negative (over-clawback, C2), `whole` is negative and `absFrac` is positive, yielding e.g. `-12.34` — but if `whole` is `0` and `bps` is negative (e.g. −34 bps), the string is `0.34` (sign lost) because `whole = 0n` carries no sign. Mis-renders small negative rates as positive.
**Impact:** A small negative reconciliation rate displays as positive — masking the C2 corruption from a human reviewer.
**Root Cause:** Integer-bps formatter assumes a non-negative numerator (true until C2 violates it).
**Recommended Fix:** Carry the sign explicitly; or (better) prevent negative attributed at the source (C2).
**Priority:** P3 | **Tenant Impact:** All tenants if C2 occurs. | **Detection:** Visual.

### L3 — `ratePct` duplicated across modules (Single-Primitive drift)
**Severity:** Low | **Category:** Duplication
**Evidence:** Identical `ratePct` integer-bps helper defined in `attribution-reconciliation.ts:31`, `journey-mix.ts:153`, and (per the journey-mix header) `order-status-mix.ts`. Three copies of the same money-adjacent percentage primitive.
**Impact:** A fix to negative-handling (L2) or rounding must be applied in three places; drift risk.
**Recommended Fix:** Extract one shared `ratePct` in the metric-engine and import it.
**Priority:** P3 | **Tenant Impact:** None. | **Detection:** Code review.

---

## Verdict

The attribution **math core is solid** — scaled-integer weights summing to exactly 1e8, sign-preserving largest-remainder apportionment, exact per-order closed-sum, and a clean full-RTO mirror — and it is honestly no-float throughout with the ledger's RLS/append-only/currency invariants properly mirrored from 0018. But the engine is **not actually wired**: nothing in production calls `writeCredit` or the reversal hook, so `attribution_credit_ledger` is empty and every attribution surface returns "all unattributed" (C1, P0). The two correctness gaps that matter are an **unguarded clawback** that lets cumulative/duplicate reversals push attributed revenue negative and corrupt the reconciliation rate the Decision Engine consumes (C2, P0), and a **one-anon-per-order stitch map** that silently drops cross-device touches (H1). Coverage is thin where it counts: the headline `attribution_reconciliation_rate` function is untested and the "CI-blocking" period-level parity oracle only truly runs against a live DB, and even then its "independent" recompute doesn't validate the time-window boundary (H2/H3). The 40-40-20 split also doesn't exactly hold its stated semantics for non-divisible N (M3). Net: a well-engineered deterministic kernel sitting behind a disconnected, under-guarded pipeline — strong foundations, but not production-trustworthy for attribution decisions until C1/C2/H1 are closed.
