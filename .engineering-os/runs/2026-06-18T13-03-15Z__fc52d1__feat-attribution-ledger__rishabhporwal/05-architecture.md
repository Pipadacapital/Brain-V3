# 05 — Architecture Plan: feat-attribution-ledger (Phase 5)

**req_id:** `feat-attribution-ledger` · **Lane:** high_stakes (money, data plane, multi_tenancy, ledger)
**Binding spec:** `.engineering-os/knowledge-base/METRICS.md` rows `attribution_credit`, `attribution_reconciliation_rate`, `attribution_confidence`.
**Cost paradigm:** Tier-0 deterministic (TypeScript metric engine) — ALL computation. Zero model calls, zero tokens/day, ~$0/mo incremental compute. The cheapest-sufficient tier is mandatory here (I-E03/I-E04); a model number on a money ledger is a P0 honesty violation. Justification: position-based weights, clawback reversal, closed-sum, confidence-min are all closed-form arithmetic — no statistical/ML tier is warranted (incrementality/MMM is an explicit non-goal D-5).

**Single-Primitive sweep:** CLEAN. Attribution is the analytics-context primitive (one credit ledger, one writer, one read seam). We EXTEND, not fork: reuse the `realized_revenue_ledger` LEDGER pattern (0018), the `withSilverBrand` Silver READ seam, `withBrandTxn` Postgres seam, the `computeBlendedRoas` ÷ `ad_spend_ledger` ROAS math, the `LedgerEventId` deterministic-ID service, the `PgLedgerRepository` append-only writer, the analytics sole-read-path use-cases, and the journey UI shell (synthetic-badge, "Powered by the Silver tier"). No per-channel forks — channel is a column, never a table.

---

## §1 — STORAGE DECISION: `attribution_credit_ledger` → **Postgres Gold table** (migration `0032`)

**DECISION: Postgres `attribution_credit_ledger`, mirroring `realized_revenue_ledger` (0018). NOT StarRocks brain_gold.**

### Rationale (the contract that forces it)
1. **The writer is the TS metric engine, and it needs append-only + RLS FORCE + signed integer money + deterministic-ID idempotency** — exactly the four guarantees the Postgres ledger pattern (0018) already ships and proves at migration time (the three DO-block assertions). StarRocks `brain_silver`/`brain_gold` in the dev `allin1-ubuntu:3.3.2` image has **no RLS** (row-policy is enterprise-only — already documented inert in `silver-deps.ts`) and **no UPDATE/INSERT app-grant immutability primitive**. A money System-of-Record for serving (METRICS.md: "`gold.attribution_credit_ledger` (SoR for serving)") MUST have provable per-brand isolation that is **NON-INERT under brain_app**. Only Postgres RLS FORCE gives us that today.
2. **The clawback is a transactional, idempotent append keyed on a deterministic reversal ID** — `ON CONFLICT DO NOTHING` semantics. StarRocks is an OLAP append store without upsert-on-conflict idempotency at row grain; Postgres gives us the same replay-suppression backstop the revenue ledger uses.
3. **The parity oracle recomputes over the canonical store via independent SQL** (METRICS.md §Rules: "independent SQL recomputation over the canonical stores"). Co-locating credit + realized revenue in Postgres lets the oracle JOIN `attribution_credit_ledger` ⟕ `realized_revenue_ledger` in ONE transactional snapshot — no cross-store skew window. That is the integrity property the CI gate depends on.
4. **`I-E05` no-new-deployable + additive-only:** a Postgres table is `CREATE TABLE IF NOT EXISTS` in migration `0032` — purely additive, no new service, no new datastore class (Postgres already owns the Gold revenue ledger).

### Reconciling the METRICS.md `gold.` naming
METRICS.md references `gold.attribution_credit_ledger` and `gold.attribution_confidence_mart`. `gold.` is the **logical tier name (System-of-Record Gold layer)**, NOT a physical StarRocks schema binding. The shipped precedent is identical: METRICS.md says `gold.realized_revenue_ledger`, and the physical table is the **Postgres** `realized_revenue_ledger` (0018). We follow that exact precedent.
> ASSUMPTION: `gold.` = the logical Gold SoR tier; physical home is Postgres for ledgers requiring RLS-FORCE + append-only-by-grant (mirrors realized_revenue_ledger). PROD GRADUATION trigger (documented, not built now): when a managed/enterprise StarRocks cluster with row-policies is available AND serving-scale OLAP reads dominate, a `brain_gold.attribution_credit_ledger` mirror may be materialized for fan-out reads — the Postgres table remains the write SoR. No graduation in M1.

### The table (mirror 0018 exactly — same RLS template, same append-only GRANT, same 3 assertions)
`attribution_credit_ledger` columns:
- `brand_id UUID NOT NULL` — RLS anchor (I-S01).
- `credit_id TEXT NOT NULL` — deterministic: `sha256(brand_id‖order_id‖brain_anon_id‖touch_seq‖model_id‖row_kind‖version)`. PK is `(brand_id, credit_id)` (tenant-first, idempotency backstop).
- `order_id TEXT NOT NULL`, `brain_anon_id TEXT NOT NULL` (the journey key), `touch_seq INT NOT NULL`, `channel TEXT NOT NULL` (the canonical `JourneyChannel` set), `campaign_id TEXT NULL`.
- `model_id TEXT NOT NULL CHECK (model_id IN ('first_touch','last_touch','linear','position_based'))` — the model that produced this weight (multiple models can coexist; the brand's active model is selected at read time).
- `row_kind TEXT NOT NULL CHECK (row_kind IN ('credit','clawback'))`.
- `weight_fraction DECIMAL(9,8) NOT NULL` — exact, persisted at credit time. **Same value carried verbatim onto the clawback row** (never re-apportioned).
- `credited_revenue_minor BIGINT NOT NULL` — SIGNED (positive on credit, negative on clawback). NEVER float (I-S07). Assertion-3 enforces `%_minor` = bigint.
- `currency_code CHAR(3) NOT NULL` — paired always; the 0018 currency-matches-brand BEFORE-INSERT trigger is replicated (`attribution_credit_currency_matches_brand()`).
- `reversed_of_credit_id TEXT NULL` — non-null ONLY on `row_kind='clawback'`; points at the original credit row's `credit_id`. CHECK: `(row_kind='clawback') = (reversed_of_credit_id IS NOT NULL)`.
- `reversal_reason TEXT NULL CHECK (reversal_reason IN ('rto_reversal','refund','chargeback','cancellation','concession') OR reversal_reason IS NULL)`.
- `realized_revenue_minor BIGINT NOT NULL` — the order's realized revenue basis used for this credit (provenance; `credited = round(weight_fraction × realized_revenue_minor)`).
- `confidence_grade TEXT NOT NULL` + `attribution_confidence NUMERIC(4,3)` — see §4 (stamped at credit time).
- `model_version TEXT NOT NULL` (metric_version provenance), `metric_snapshot_id TEXT NULL`.
- `occurred_at TIMESTAMPTZ NOT NULL` (conversion/reversal event-time), `economic_effective_at TIMESTAMPTZ NOT NULL` (drives as-of), `billing_posted_period CHAR(7) NOT NULL` (reversal posts to current open period — same dual-date rule as 0018), `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`.

**Indexes:** dedup `UNIQUE (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind)` (replay → `ON CONFLICT DO NOTHING`); read-seam `(brand_id, model_id, economic_effective_at)`; reversal-lookup `(brand_id, reversed_of_credit_id) WHERE row_kind='clawback'`.
**RLS:** `ENABLE` + `FORCE ROW LEVEL SECURITY`; two-arg fail-closed policy `current_setting('app.current_brand_id', TRUE)::uuid` (copy 0018 §3). **GRANT:** `REVOKE ALL; GRANT SELECT, INSERT` to `brain_app` (append-only). **Assertions:** copy 0018's three DO-blocks (NN-1 two-arg, append-only-by-GRANT no UPDATE/DELETE, no-float-SQL bigint).
**Named as-of read seam:** `attributed_gmv_as_of(p_brand_id UUID, p_model_id TEXT, p_as_of DATE) RETURNS BIGINT` — `SECURITY INVOKER`, `SUM(credited_revenue_minor) WHERE economic_effective_at::date <= p_as_of AND model_id = p_model_id`. This is the SOLE attributed-sum path (no ad-hoc SUM in app, mirrors `realized_gmv_as_of`). A second seam `channel_contribution_as_of(brand, model, from, to)` returns `(channel, currency_code, contribution_minor)` grouped — feeds the UI + the parity oracle.

---

## §2 — CREDIT MODEL SET (Tier-0 deterministic, pure domain math)

Lives in **`packages/metric-engine/src/attribution-models.ts`** — a PURE function module (no I/O), the analogue of a domain `policy`. Input: the ordered touch list for ONE journey (from `silver.touchpoint` via `withSilverBrand`) + the order's `realized_revenue_minor`. Output: `weight_fraction DECIMAL(9,8)` per touch, **summing to exactly 1.0** (precision gate), plus `credited_revenue_minor` per touch via exact integer apportionment.

### The model set (brand-configurable; `position_based` default)
For N touches in conversion order `[t_1 … t_N]`:
- **first_touch:** `w_1 = 1`, rest `0`.
- **last_touch:** `w_N = 1`, rest `0`.
- **linear:** each `w_i = 1/N`.
- **position_based (40-40-20 default):**
  - N=1 → `w_1 = 1.0`.
  - N=2 → `w_1 = 0.5, w_2 = 0.5` (no middle; the 40/40 endpoints + 20 middle collapses to a 50/50 split when there is no middle — endpoints absorb the middle proportionally so the sum stays 1.0).
  - N≥3 → first = `0.40`, last = `0.40`, middle `0.20` split **evenly** across the `N-2` middle touches (`0.20/(N-2)` each).

### Exact weight math (no float ever — DECIMAL via scaled BIGINT)
Weights are computed as integer **hundred-millionths** (scale `1e8`, matching `DECIMAL(9,8)`). `TOTAL = 100_000_000n`. position_based N≥3: `first = last = 40_000_000n`; each middle = `20_000_000n / (N-2)` (integer divide). **Largest-remainder rounding:** distribute the integer division remainder (`TOTAL − Σ` so far) to touches in a deterministic order (first touch, then last, then middles by seq) so `Σ weight_units = 100_000_000n` EXACTLY. `weight_fraction` string = units rendered as `D.DDDDDDDD`.

### Exact credited-revenue apportionment (closed-sum at the order grain)
`credited_revenue_minor` per touch is NOT `round(weight × revenue)` independently (that leaks pennies). Instead **largest-remainder over minor units**: `raw_i = (weight_units_i × realized_revenue_minor) / TOTAL` (BigInt floor); residual `R = realized_revenue_minor − Σ raw_i`; hand the `R` leftover minor units one each to the touches with the largest fractional parts (deterministic tiebreak by touch_seq). Guarantees `Σ credited_revenue_minor = realized_revenue_minor` for the order EXACTLY — this is the per-order leg of the closed-sum oracle. Signed: negative `realized_revenue_minor` (a reversal basis) apportions with the same algorithm, sign-preserving.

**hasData/honest:** journeys with zero touches in Silver → unattributed (no credit rows written; the order's realized revenue lands entirely in the `unattributed_minor` residual). Never fabricate a touch.

---

## §3 — CLAWBACK (saved-weight reversal)

When the realized-revenue ledger records an `rto_reversal | refund | chargeback | cancellation | concession` for an order (signed-negative `amount_minor` on `realized_revenue_ledger`), the attribution writer appends **mirrored negative credit rows** — one per original credit row of that order — using the **SAVED `weight_fraction`** read back from `attribution_credit_ledger` (NEVER re-derived from current touches; the journey may have changed, the credit must not).

- **Reversal amount:** `clawback_minor_i = −round_largest_remainder(saved_weight_i × reversal_basis_minor)`, where `reversal_basis_minor` is the (negative) realized delta. For a **full RTO** the reversal basis = `−(original realized_revenue_minor)`, so each clawback row exactly negates its credit row → `SUM(credit_i + clawback_i) = 0` per touch and per order → **closed-sum = 0**. For a **partial refund**, the basis is the partial negative delta; the same saved-weight apportionment yields **proportional** clawback (fixture-asserted: clawback proportions match the original saved weights, not a fresh re-apportionment).
- **Deterministic reversal IDs:** `credit_id = sha256(brand_id‖order_id‖brain_anon_id‖touch_seq‖model_id‖'clawback'‖reversal_ledger_event_id)` — keyed on the source reversal's `ledger_event_id` so each distinct refund event produces a distinct clawback row, but a **replay of the same reversal** produces the SAME id → `ON CONFLICT DO NOTHING` → idempotent (no double-clawback). `reversed_of_credit_id` = the original credit row's id.
- **Append-only:** the original credit row is NEVER mutated; clawback is a NEW signed row (structural — no UPDATE grant). `billing_posted_period` = the reversal's current open period (dual-date, mirrors `PostReversal`).
- **Multiple model rows:** if multiple `model_id`s have credit rows for the order, the clawback fans out per model (each model's saved weights reversed independently).
- **Driver:** the writer consumes realized-ledger reversal events. M1 binding = the same `OrderEventConsumer` path that already produces reversals (`measurement/internal/interfaces/consumers/OrderEventConsumer.ts`) calls into the attribution writer command after the revenue reversal is appended. (No new deployable — in-module use-case, I-E05.)

---

## §4 — `attribution_confidence` binding (`gold.attribution_confidence_mart`)

Per METRICS.md, `attribution_confidence` feeds `effective_confidence = min(cost_confidence, attribution_confidence)` (the CM2/CAC consumers, Phase-6). Phase 5 produces it as a first-class, **deterministic** grade — NO invented floats; a fixed lookup, not a model.

**Definition (deterministic, journey-signal-driven):** per order's attribution, the confidence grade is the **floor over its touches' resolution quality**:
- `strong` (grade A, `attribution_confidence = 1.000`): the journey **deterministically stitched** to the order (`stitched_brain_id IS NOT NULL` — the §journey-mix stitch signal) AND every credited touch carries a click-id or UTM medium (deterministic channel, not the `direct` fallback).
- `partial` (grade C, `0.700`): stitched but ≥1 credited touch is the cookieless/`direct` residual bucket.
- `weak` (grade D, `0.400`): unstitched / synthetic-enriched coverage (the dev-thin path).

This maps onto METRICS.md §Rules' 70-line gate (below C/Insufficient → rendered "Estimated"). The grade is **stamped onto each credit row** (`confidence_grade` + `attribution_confidence`) at credit time and carried verbatim to the clawback row (same as weight). The **`gold.attribution_confidence_mart`** is a named read seam `attribution_confidence_mart(brand, model, from, to)` over the credit ledger returning `(grade, attribution_confidence, attributed_minor_at_grade)` — the logical mart, materialized as a SECURITY-INVOKER function (no separate StarRocks object; same `gold.`=logical reasoning as §1).
> ASSUMPTION: the three grade thresholds (A/C/D ↔ 1.0/0.7/0.4) are the M1 deterministic defaults; exact values are registry constants, Data-Engineer-confirmable in Sprint 0 (consistent with the METRICS.md confidence ASSUMPTION). No floats invented at runtime — these are frozen constants.

---

## §5 — CLOSED-SUM PARITY ORACLE (CI-BLOCKING) + `attribution_reconciliation_rate`

### The oracle (the acceptance gate)
`Σ channel_contribution_minor + unattributed_minor = realized_gmv_minor` for every brand-period. Enforced **two ways**, both CI-blocking:
1. **Per-order invariant (engine-internal):** `Σ credited_revenue_minor (all touches, one model) = realized_revenue_minor` — guaranteed by the largest-remainder apportionment (§2). Unattributed = realized revenue of orders with zero credited touches (no journey).
2. **Period-level independent recompute:** the test computes `Σ channel_contribution_minor` via the `channel_contribution_as_of` seam (engine path) AND independently via raw SQL `SELECT SUM(credited_revenue_minor) ... GROUP BY channel` over the same Postgres snapshot, then asserts: `engine_channel_sum + (realized_gmv_as_of − attributed_gmv_as_of) == realized_gmv_as_of`, AND `engine == independent_SQL` (exact integer equality, tolerance 0 — the parity-oracle tolerance per the METRICS.md ASSUMPTION, NOT the ±2-3% reconciliation tolerance which is a separate metric). Any drift fails the build.

**Fixtures (REQUIRED pass-1, all four):**
- **full-RTO:** order credited, then fully RTO'd → `Σ(credit+clawback)=0`, attributed→0, closed-sum=0.
- **partial refund:** 50% refund → clawback = 50% of EACH saved weight (proportional to saved weights, asserted touch-by-touch).
- **multi-touch:** N≥3 position_based → weights sum to exactly `1.00000000` (DECIMAL precision gate) AND `Σ credited = realized` exactly.
- **cookieless residual:** order with no journey / `direct`-only → lands in `unattributed_minor`, grade D, closed-sum still holds.

### `attribution_reconciliation_rate` metric
`(attributed_gmv_minor / realized_gmv_minor) × 100`, `NUMERIC(5,2)`, integer-basis-point math (the `ratePct` pattern). `attributed_gmv_minor = attributed_gmv_as_of` (positive+clawback netted, deduped by order via the finalized pass). The **unattributed residual** = `realized − attributed` is ALWAYS returned alongside and rendered (§6). Lives in `packages/metric-engine/src/attribution-reconciliation.ts`.

---

## §6 — UI (stakeholder-visible, MANDATORY)

New page `apps/web/app/(dashboard)/analytics/attribution/` (mirrors the journey/spend page shell). Renders, via the BFF → analytics use-case → metric-engine sole-read-path (UI NEVER touches the ledger/StarRocks — I-ST01):
- **Attributed revenue by channel/campaign** (bar/table) for the selected model + window, with the **model selector** (first/last/linear/position_based; default = brand's active = position_based).
- **Reconciliation residual** shown alongside (the `unattributed_minor`) — never hidden, never spread silently (METRICS.md §Rules).
- **Channel ROAS** = attributed_revenue_per_channel ÷ ad_spend_per_channel (joins `ad_spend_ledger` via the §1 channel-contribution seam + the existing `ad_spend_as_of`; same-currency only, honest null when spend=0). This makes `blended_roas` per-channel.
- **`attribution_confidence`** badge per row + the `attribution_reconciliation_rate` headline.
- Honest empty state + **`synthetic-badge`** "synthetic (dev)" where journey data is thin (23 real touchpoints), + "Powered by the Silver tier".

---

## TRACKS (3) — exact file targets

### Track A — @data-engineer (storage + migration + seams)
**Acceptance (pass-1 REQUIRED):** RLS NON-INERT under brain_app (isolation-fuzz mutation test must leak brand-B rows when predicate disabled); append-only assertion (no UPDATE/DELETE grant); no-float assertion (all `%_minor` bigint); replay `ON CONFLICT DO NOTHING` idempotent.
- `db/migrations/0032_attribution_credit_ledger.sql` — CREATE TABLE (§1 columns), dedup + read + reversal indexes, RLS ENABLE+FORCE + two-arg policy, REVOKE/GRANT SELECT+INSERT, `attribution_credit_currency_matches_brand()` trigger, the 3 DO-block assertions (copy 0018), and the seams `attributed_gmv_as_of()`, `channel_contribution_as_of()`, `attribution_confidence_mart()` (all SECURITY INVOKER). Header rollback block. ADDITIVE ONLY.
- `tools/isolation-fuzz/src/attribution-credit-ledger.test.ts` — NON-INERT proof (mirror `silver-touchpoint.test.ts` mutation pattern under brain_app).
- `apps/core/src/modules/measurement/tests/attribution-credit-ledger.live.test.ts` — append-only + dedup-replay + closed-sum-at-order-grain live tests (mirror `realized-revenue-ledger.live.test.ts`).

### Track B — @backend-developer (the metric-engine WRITER + reads + parity oracle)
**Acceptance (pass-1 REQUIRED):** all Tier-0 deterministic (no model/prompt/dbt macro — I-E03/E04); weights sum to exactly 1.0; per-order `Σ credited = realized`; full-RTO closed-sum=0; partial-refund clawback proportional to SAVED weights; reversal idempotent (replay → no new rows); the parity oracle CI-blocking with all 4 fixtures; reads via named seams only (no ad-hoc SUM).
- `packages/metric-engine/src/attribution-models.ts` — the 4 models + exact scaled-integer weight math + largest-remainder apportionment (PURE, no I/O).
- `packages/metric-engine/src/attribution-models.test.ts` — weight-sum-1.0 + apportionment-closed-sum unit tests (incl. N=1,2,3,many).
- `packages/metric-engine/src/attribution-credit.ts` — `computeAttributionCredit(brandId, orderId, model, deps, silverDeps)`: reads touches via `withSilverBrand` + order realized via `realized_gmv_as_of`/order basis, computes rows, returns credit rows (+ confidence grade §4).
- `packages/metric-engine/src/attribution-clawback.ts` — `computeClawback(...)`: reads SAVED weights from the ledger, mirrors negative rows with deterministic reversal ids.
- `packages/metric-engine/src/attribution-confidence.ts` — the deterministic grade lookup (§4 constants).
- `packages/metric-engine/src/attribution-reconciliation.ts` — `computeAttributionReconciliationRate` + channel-contribution + residual (§5).
- `packages/metric-engine/src/attribution-channel-roas.ts` — per-channel attributed ÷ ad_spend (reuse `exactRatioString`/`ad_spend_as_of`).
- `packages/metric-engine/src/attribution-parity-oracle.test.ts` — **CI-BLOCKING** oracle: engine-vs-independent-SQL exact-integer equality + the 4 fixtures (full-RTO, partial-refund, multi-touch, cookieless).
- `packages/metric-engine/src/registry.ts` — add `attribution_credit`, `attribution_reconciliation_rate`, `attribution_confidence` MetricIds + a `attribution_credit_ledger` readSeam value.
- `packages/metric-engine/src/index.ts` — export the new compute fns + types.
- `apps/core/src/modules/attribution/internal/credit-writer.ts` + `apps/core/src/modules/attribution/index.ts` — the writer use-case (append credit + clawback via `PgLedgerRepository`-style append-only insert; deterministic id via `LedgerEventId` analogue) wired into `OrderEventConsumer` for the reversal trigger. Public surface exported from the module index.
- `apps/core/src/modules/analytics/internal/application/queries/get-attribution-by-channel.ts`, `get-attribution-reconciliation.ts`, `get-channel-roas.ts` — sole-read-path use-cases (mirror `get-blended-roas.ts`).
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` — add `GET /api/v1/analytics/attribution/by-channel`, `/reconciliation`, `/channel-roas` (model + from/to params; mirror the journey routes incl. `dataSource:'synthetic'` honesty + `bffProtectedPreHandler` + brand-from-session).

### Track C — @frontend-web-developer (the UI)
**Acceptance (pass-1 REQUIRED):** model selector functional; residual rendered alongside (never hidden); channel ROAS shown; honest empty + synthetic-badge where thin; "Powered by the Silver tier"; reads ONLY via BFF (no direct ledger/StarRocks).
- `apps/web/app/(dashboard)/analytics/attribution/page.tsx` + `attribution-content.tsx` — page shell (mirror `journey/page.tsx` + `journey-content.tsx`).
- `apps/web/components/analytics/attributed-channel-chart.tsx` — attributed-revenue-by-channel bar/table.
- `apps/web/components/analytics/attribution-model-selector.tsx` — the 4-model selector.
- `apps/web/components/analytics/channel-roas-table.tsx` — per-channel ROAS (attributed ÷ spend, honest null).
- `apps/web/components/analytics/reconciliation-residual-card.tsx` — reconciliation rate + unattributed residual, always visible.
- Reuse `apps/web/components/analytics/synthetic-badge.tsx`.

---

## Deploy-pipeline note
No new service / no new deployable (I-E05) — all changes land in existing `apps/core` (:3001), `apps/web` (:3000), `packages/metric-engine`, `db/migrations`. The existing affected-only build + per-service deploy + canary + auto-rollback pipeline for `core` and `web` covers this; the additive migration `0032` runs in the standard migration step (CREATE IF NOT EXISTS, rollback-DROP-safe — the credit ledger is rebuildable from Silver + the revenue ledger).

## Cost estimate
Tier-0 deterministic only: **0 tokens/day, ~$0/mo** incremental model spend. Compute = O(touches) integer arithmetic per order + GROUP BY scans on an indexed Postgres table (negligible). No new infra footprint.

## Reversibility
`0032` is additive `CREATE IF NOT EXISTS`; rollback = `DROP TABLE attribution_credit_ledger` + `DROP FUNCTION` the three seams (the ledger is fully rebuildable from `silver.touchpoint` + `realized_revenue_ledger` — same property as 0018). No data loss on down-migrate.

## Alternative considered + rejected
**StarRocks `brain_gold.attribution_credit_ledger`** (taking METRICS.md `gold.` literally). REJECTED: dev StarRocks has no RLS (isolation would be INERT — fails the NON-INERT acceptance gate), no row-grain upsert idempotency for clawback replay, no append-only-by-grant immutability, and a cross-store snapshot skew window would break the exact-integer parity oracle. The shipped `realized_revenue_ledger` precedent (logical `gold.` → physical Postgres) settles it.
</content>
</invoke>
