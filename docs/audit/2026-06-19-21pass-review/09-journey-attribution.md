# Pass 9: Journey & Attribution Audit (journey-attribution)

## Board Verdict

The credit-weight arithmetic (position_based, linear, first/last touch), apportionment, and clawback math are provably correct: WEIGHT_SCALE sums, largest-remainder closure, and the full-RTO mirror property are all asserted by deterministic unit tests. RLS on the Gold `attribution_credit_ledger` is correctly ENABLE+FORCE with a two-arg fail-closed policy and is proven non-inert by the mutation fuzz test. However, four concrete defects were found that corrupt or misrepresent attribution in production:

1. **Critical** — `AttributionCreditWriter.writeCredit` has no production caller; credit rows are never written so the ledger is permanently empty and attribution is 100% unattributed residual for all live brands.
2. **High** — Journey endpoints (first-touch-mix, stitch-rate) send `toDate=T00:00:00Z` to StarRocks but attribution endpoints (by-channel, reconciliation, channel-roas) send `toDate=T00:00:00Z` to the Postgres date-cast seam — for journey the StarRocks predicate becomes `occurred_at <= '2026-06-18 00:00:00'` (exclusive of most of the to-day), while for attribution `economic_effective_at::date <= '2026-06-18'` (inclusive). Touchpoints on the to-day are in attribution numbers but not in journey channel counts.
3. **High** — The parity-oracle assertion `Σ channel_contribution + unattributed = realized` is structurally violated by a windowing mismatch: `attributedGmvMinor` is derived from `attributed_gmv_as_of(to) − attributed_gmv_as_of(from−1)` (as-of differencing), but `byChannel` uses `channel_contribution_as_of(from, to)` (direct window filter). Clawbacks whose `economic_effective_at` falls outside `[from, to]` but within the as-of scope cause the two totals to diverge.
4. **Medium** — `credit-writer.ts:readTouches` fetches ALL touches for a `brain_anon_id` with no order-time upper bound. A returning customer whose same anon ID produced touches across multiple visits and orders receives the entire accumulated touch history credited to every subsequent order (double-attribution of prior-cycle touches).

**Severity counts:** Critical 1 | High 2 | Medium 1 | Low 0

---

## Finding JA-1

**Title:** `writeCredit` has no production caller — attribution credit ledger is permanently empty

**Severity:** Critical

**Category:** Attribution Leakage / Unimplemented Write Path

**evidenceRef:**
- `apps/core/src/modules/attribution/internal/credit-writer.ts:97-131` — `writeCredit` defined
- Search across all non-test `.ts` files for `writeCredit`: zero hits outside `credit-writer.ts` itself and test files
- `apps/core/src/modules/measurement/internal/interfaces/consumers/OrderEventConsumer.ts:63-113` — order consumer has no attribution write
- `apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts:60-152` — stream-worker's `writeProvisionalRecognition` and `writeReversal` have no attribution credit call
- `apps/core/src/modules/attribution/index.ts:46-48` — `AttributionCreditWriter` exported but never instantiated in any composition root

**Impact:** The `attribution_credit_ledger` table contains zero credit rows for live brands. Every attribution query (`by-channel`, `reconciliation`, `channel-roas`) returns `attributed_gmv_minor = 0`, `reconciliation_rate_pct = 0.00`, and the full realized GMV appears as unattributed residual. ROAS is null (no attributed revenue). The parity oracle trivially holds at zero attributed. Stakeholders see a permanently empty attribution board while the codebase claims to produce attribution.

**Root Cause:** `writeCredit` was built as the I/O adapter for the credit domain math but the triggering call — which should fire after an order is recognized in the realized revenue ledger — was never wired into `OrderEventConsumer.handle` or any Kafka consumer. The clawback path (`createAttributionReversalHook` → `OrderEventConsumer.handleReversal`) was wired but the forward credit path was not.

**Fix:** In `OrderEventConsumer.handle` (after `this.recognizeOrder.execute(event)` succeeds), add an `attributionCreditHook?.onOrderRecognized(...)` call that resolves `brainAnonId` from the stitch map and invokes `AttributionCreditWriter.writeCredit`. Wire the hook in the composition root alongside the existing reversal hook. This is additive (I-E05) — no new deployable.

**Priority:** P0

**tenantImpact:** All brands; every brand's attribution ledger is empty.

**Detection:** Attribution reconciliation rate = 0.00% for all brands in prod. `SELECT COUNT(*) FROM attribution_credit_ledger WHERE row_kind = 'credit'` = 0.

---

## Finding JA-2

**Title:** Journey window uses T00:00:00Z upper bound in StarRocks, dropping all same-day touches from the to-date

**Severity:** High

**Category:** Time-Window Boundary Error / Journey Gaps

**evidenceRef:**
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts:2032-2033` — first-touch-mix: `to: new Date(`${toStr}T23:59:59Z`)` ← correct
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts:2094-2095` — stitch-rate: `to: new Date(`${toStr}T23:59:59Z`)` ← correct
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts:2220` — attribution by-channel: `toDate: new Date(`${toStr}T00:00:00Z`)` ← start-of-day
- `packages/metric-engine/src/journey-mix.ts:163-165` — `toStarRocksTs(d)` converts the Date to `'YYYY-MM-DD HH:MM:SS'` and passes it to StarRocks
- `packages/metric-engine/src/journey-mix.ts:230,242` — StarRocks SQL: `AND occurred_at <= ?` with the literal `'2026-06-18 00:00:00'`
- `db/migrations/0032_attribution_credit_ledger.sql:203` — attribution seam uses `economic_effective_at::date <= p_as_of` (date cast, inclusive of full day)

**Impact:** On any given query day, touchpoints recorded between 00:00:01 and 23:59:59 UTC are excluded from `computeFirstTouchMix` and `computeStitchHitRate` counts but are included in the attribution credit totals. A journey that was first-touch on today's date does not appear in first-touch-mix; the stitch-rate denominator under-counts same-day journeys. This skews the channel distribution (e.g., paid campaigns running on the to-date are invisible in the mix) and inflates the stitch-hit-rate. The reconciliation rate denominator counts same-day orders but the numerator journey counts do not.

**Root Cause:** The BFF inconsistently applies `T23:59:59Z` to journey endpoints but `T00:00:00Z` to attribution endpoints. For the Postgres attribution seam this makes no difference (date-cast ignores time), but for the StarRocks seam `toStarRocksTs` preserves the time component and passes it as a DATETIME literal, making the upper bound midnight rather than end-of-day.

**Fix:** In `bff.routes.ts`, change all journey endpoint `to` Date constructions from `T23:59:59Z` to `T23:59:59Z` consistently (already done for journey) AND change all attribution `toDate` to use `T23:59:59Z` as well (currently `T00:00:00Z`). Since attribution seams use date-cast this is harmless for Postgres and restores symmetry. Alternatively, `toStarRocksTs` could strip the time and append `23:59:59` unconditionally for the `to` bound.

**Priority:** P1

**tenantImpact:** All brands equally; every brand's journey channel counts under-count the to-date's touchpoints.

**Detection:** Compare `first_touch_mix.total` for window `[today, today]` at 13:00 UTC vs 23:59 UTC — count should grow during the day but does not. Stitch-rate denominator for today-only window = 0 before the day ends.

---

## Finding JA-3

**Title:** Parity-oracle closed-sum violated — `attributedGmvMinor` uses as-of differencing but `byChannel` uses a direct window filter

**Severity:** High

**Category:** Attribution Leakage / Parity Oracle Drift

**evidenceRef:**
- `packages/metric-engine/src/attribution-reconciliation.ts:107-117` — `attributedGmvMinor = attributed_gmv_as_of(to) − attributed_gmv_as_of(fromMinus1)` (cumulative as-of difference)
- `packages/metric-engine/src/attribution-reconciliation.ts:119-124` — `byChannel = channel_contribution_as_of(from, to)` (direct `economic_effective_at::date >= p_from AND <= p_to`)
- `db/migrations/0032_attribution_credit_ledger.sql:189-204` — `attributed_gmv_as_of` sums ALL rows where `economic_effective_at::date <= p_as_of` (inclusive of prior periods)
- `db/migrations/0032_attribution_credit_ledger.sql:211-236` — `channel_contribution_as_of` filters `>= p_from AND <= p_to` (direct window, excludes prior-period rows)
- `packages/metric-engine/src/attribution-reconciliation.ts:133` — `unattributedMinor = realizedGmvMinor - attributedGmvMinor`

**Impact:** When a clawback row has `economic_effective_at` on a date before `fromDate` (e.g., a cross-period RTO where the reversal is processed after period close and `economicEffectiveAt` is back-dated), `attributed_gmv_as_of(to) − attributed_gmv_as_of(fromMinus1)` captures that clawback in the window (it is subtracted via the as-of difference), but `channel_contribution_as_of(from, to)` excludes it (the clawback's date is before `from`). The result: `Σ byChannel ≠ attributedGmvMinor`, so `Σ byChannel + unattributedMinor ≠ realizedGmvMinor`. The UI renders a parity-oracle violation silently — the channel breakdown does not add up to the total.

**Root Cause:** Two different seams were built for the same logical quantity (`attributed GMV in a window`) but use structurally different SQL: one uses cumulative as-of arithmetic (inherited from `realized_gmv_as_of` pattern), the other uses a direct date range filter. They agree only when clawback `economic_effective_at` always falls within `[from, to]`, which is not guaranteed for cross-period reversals.

**Fix:** Make `byChannel` use the same windowing as `attributedGmvMinor`: replace `channel_contribution_as_of(from, to)` with `channel_contribution_as_of_windowed(from−1, to) − channel_contribution_as_of_windowed(NULL, from−1)`, or rewrite `channel_contribution_as_of` to accept an `as-of` lower exclusion bound to mirror the differencing pattern. Alternatively, have `channel_contribution_as_of` use the cumulative-difference pattern to match `attributed_gmv_as_of`.

**Priority:** P1

**tenantImpact:** All brands with any cross-period reversal. Only manifests when a clawback `economic_effective_at` falls outside the UI query window.

**Detection:** Query `SELECT SUM(contribution_minor) FROM channel_contribution_as_of(...)` and compare to `attributed_gmv_as_of(to) - attributed_gmv_as_of(from-1)` for a brand that has had reversals — they should be equal but diverge.

---

## Finding JA-4

**Title:** `readTouches` fetches all-time anon touches with no order-time upper bound — prior-cycle touchpoints double-attributed to repeat orders

**Severity:** Medium

**Category:** Attribution Leakage / Missing Touchpoint Filter

**evidenceRef:**
- `apps/core/src/modules/attribution/internal/credit-writer.ts:158-171` — `readTouches(brandId, brainAnonId)` queries `silver_touchpoint WHERE brain_anon_id = ? ORDER BY touch_seq ASC` with no `occurred_at <= orderDate` predicate
- `db/migrations/0031_connector_journey_stitch_map.sql:35-43` — `connector_journey_stitch_map` PK is `(brand_id, order_id)` — no unique constraint on `(brand_id, stitched_anon_id)`, so one anon can stitch to multiple orders
- `db/dbt/models/marts/silver_touchpoint.sql:52-74` — the mart takes only the earliest stitched order per anon (`_stitch_rn = 1`), but the credit writer does not apply this constraint

**Impact:** For a returning customer who uses the same browser (same `brain_anon_id`) across two separate purchase journeys, all touchpoints from visit 1 (including those that led to order 1) are included in the touch list credited to order 2. This double-counts the pre-first-order paid-channel touches: the first order's paid_meta touchpoints accumulate attributed revenue twice. ROAS for paid_meta is inflated on the second order and beyond.

**Root Cause:** The credit writer fetches touches by anon identity alone, not bounded by the order's conversion timestamp. The spec (architecture §2) requires the journey to be the touches leading up to the order's conversion event, not the customer's entire history. The stitch map correctly models a one-anon-to-one-order relationship in the mart (via `_stitch_rn = 1`), but the writer bypasses this constraint.

**Fix:** Pass `occurredAt` (the order's `occurredAt`) into `readTouches` and add `AND occurred_at <= ?` to the Silver query. This constrains the attributed touchpoints to those that occurred before or at the order's conversion time, matching the per-order journey semantics. The touch sequence numbers remain stable for replay because touch_seq is stable within the bounded window.

**Priority:** P2

**tenantImpact:** Brands with returning customers (common in D2C). Second+ orders from any customer who shares a `brain_anon_id` across visits receive inflated attribution.

**Detection:** Find orders where `brain_anon_id` appears in `connector_journey_stitch_map` more than once. For those orders' credit rows, check if `MIN(occurred_at)` of credited touches predates the first stitched order for that anon.
