# Phase 2 — Business Intelligence: Enterprise Implementation Specification

> **Status legend (used throughout):**
> **BUILT** = implemented and live in the cited file(s).
> **PARTIAL** = implemented for a subset; named extensions are not yet built.
> **DESIGNED-TARGET** = specified here as the intended next state; not yet in code.
> **REGISTERED-DISABLED** = present in the registry as `enabled=False`, fails closed via `NotImplementedYet`, never fabricated.
>
> **Audience:** engineering teams and AI coding agents. Every claim cites a real file. Do **not** redesign the approved architecture; this spec hardens and extends it.

---

## 0. Scope, invariants, and what Phase 2 is NOT

### 0.1 Approved architecture (do not change)

```
Fastify Collectors → Kafka (KRaft) → Spark Structured Streaming landing
  → Iceberg Bronze → Spark → Iceberg Silver
  → Phase 1 Identity Intelligence → Customer360 Contract
  → Phase 2 Business Intelligence → Iceberg Gold
  → Analytics Gateway (Redis cache-aside + Trino) → Fastify APIs
  → dashboards / AI / reports
```

- **Serving** = Trino-over-Iceberg + Redis cache-aside. **StarRocks is REMOVED.** `brain_serving.mv_*` are **Trino views** in `db/trino/views/` (e.g. `mv_gold_attribution_credit.sql`, `mv_gold_cohorts.sql`). Any in-code reference to "StarRocks" in comments/enums is documented naming debt (see §16.4), not a live engine.
- **Operational state** = PostgreSQL `ops` schema (and `brain_ops`-equivalent app-written natives, e.g. `dq_check_result`).
- **Identity SoR** = Neo4j (ADR-0004). Phase 2 **never** mutates identity/graph/Customer360; it **consumes** the Customer360 contract.
- **Money** = `bigint` minor units **+** a sibling `currency_code`. Never blended, never a float.
- **PII** = hash-only.
- **Tenancy** = `brand_id`-first on every row/key, enforced at the read seam by the `${BRAND_PREDICATE}` sentinel (fail-closed if missing).
- **Deterministic-first.** LLMs **never** match or compute. They consume deterministic outputs through read-only MCP tools (§17).

### 0.2 Vocabulary reconciliation (spec term → real implementation)

| Spec / generic term | Real Brain V4 implementation |
|---|---|
| "Phase-1 Splink probabilistic matcher" | **Rule-based, review-gated matcher**: score capped at 95, never bands `exact`, routes to review, never auto-merges. ML/household/cross-device matchers present. Splink/EM is the **gated future evolution**, not the current default. |
| "Phase-2 data-driven attribution" | **Markov removal-effect** (`packages/metric-engine/src/attribution-datadriven.ts`). |
| "Predictive LTV / health" | **REGISTERED-DISABLED** marts `predictive_ltv` / `predictive_health` (`db/iceberg/spark/gold/_gold_registry.py:577-612`, `enabled=False`). |
| "Materialized view (`mv_*`)" | **Trino view** over Iceberg (`db/trino/views/mv_*.sql`). |

### 0.3 What Phase 2 must NEVER do

- Mutate identity, the graph, or Customer360 inputs. It is **read-from-Silver, write-to-Gold** only.
- Let an LLM produce a number, a join, or a SQL string against tenant data.
- Blend currencies into a single money column without a sibling `currency_code` (two current honest deviations are tracked in §11.5 and §8.5).
- Emit a fabricated zero/empty as a success state. Missing input → `NULL` (honest-empty) or a graded `D` (honest-low-confidence), never a faked value.

---

## 1. Overall BI flow

**State: BUILT.**

Phase 2 reads the canonical Silver spine and the Customer360 contract, computes deterministic business marts, materializes them to Iceberg Gold (`brain_gold_local`), exposes them as Trino views (`brain_serving.mv_*`), and serves them through the Analytics Gateway. The single declarative source of truth for the Gold surface is the registry:

- **Registry:** `db/iceberg/spark/gold/_gold_registry.py` — 30 specs (24 enabled Gold + 3 `snap_*` + 2 disabled predictive). Each spec carries `pk` (brand_id-first), `money_columns` (minor+currency pairs), `mv_name`, `reads_from` lineage, `phase`, `enabled`, `not_implemented_reason`. Mirrored to the TS contract `GoldDataProduct`. The refresh loop, MCP, and parity oracle all read this registry.
- **Shared base:** `db/iceberg/spark/gold/_gold_base.py` — `silver()`, `silver_exists()`, `ensure_gold_table()`, `merge_on_pk()`, `run_job()`, `emit_job_log()`, `emit_cache_event()`. Partition convention `bucket(256, brand_id)`.
- **Orchestration:** `tools/dev/v4-refresh-loop.sh` runs identity-export → `silver_order_state` → rest of Silver → `gold_revenue_ledger` → journey-stitch → rebuild `silver_touchpoint` → rest of Gold → Trino view refresh. Invoked by `pnpm dev:v4-refresh`.

**Key correctness posture (BUILT, exemplary — keep as house standard):**
1. Integer-exact, sign-preserving money apportionment with **closed-sum assertions** (`attribution-models.ts`, `_attribution_math.py`).
2. **Dual implementation, parity-exact**: a TS system-of-record alongside a verbatim Python port (`packages/metric-engine/src/attribution-*.ts` ↔ `db/iceberg/spark/gold/_attribution_math.py`), guarded by `attribution-parity-oracle.test.ts`.
3. **"Pure module + the real SQL string replayed against sqlite"** test pattern (`_segment_rules.py` + `_segment_rules_test.py`, `_customer_360_enrich.py` + `_customer_360_enrich_test.py`) — executed logic == tested logic.
4. **Honest-empty / unattributed-residual-always-rendered**: a missing optional source yields `NULL`; the unattributed revenue residual is always surfaced, never hidden.

---

## 2. The processing pipeline (sequencing & determinism)

**State: BUILT (batch full-recompute), with a DESIGNED-TARGET to derive ordering from the registry.**

- Each Gold job is a **full recompute from Silver**, MERGE-UPDATEd on the PK. Re-runs are byte-identical (deterministic keys, e.g. `gold_revenue_ledger.ledger_event_id = sha2(concat_ws('\0', …))`).
- Parity determinism is handled with care: `gold_revenue_ledger.py:259-313` documents two real fixes — Spark `date_add` truncating time-of-day (→ `make_dt_interval`) and Spark `cast(timestamp as string)` trimming microseconds vs the fixed 6-digit serving render (`_sr_dt_str`).

**Weakness — sequencing lives in bash, not the registry.** The dependency chain is correct but hand-encoded in `v4-refresh-loop.sh`. `reads_from` exists in `_gold_registry.py` but nothing topologically sorts from it.

**DESIGNED-TARGET (P1):** Derive run order from `_gold_registry.reads_from` via a Kahn topological sort so the registry is the single sequencing SoT. A new mart added to the registry is then auto-sequenced; no manual loop edit. Implementation: a small Python toposort over the spec graph emitting the ordered job list that `v4-refresh-loop.sh` consumes.

**Weakness — `silver_exists()` swallows all exceptions to `False`** (`_gold_base.py:71`). A transient catalog/network blip during the probe makes a job silently write an empty mart and parity "SKIP" instead of failing. **Fix (P2):** catch only the not-found class (mirror the TS `isSilverUnavailable` distinction); re-raise transient errors.

---

## 3. MODULE — Customer360 / Enrichment mart

**State: BUILT.** File: `db/iceberg/spark/gold/gold_customer_360.py` (+ `_customer_360_enrich.py`, `_customer_360_enrich_test.py`).

- **Purpose:** the flagship denormalized mart — one row per `(brand_id, brain_id)`. Spine columns carried byte-identical from `silver_customer`; lifecycle rollup (delivered/rto/cancelled/refunded) from `silver_order_state`; B2 enrichment (`aov_minor`, `preferred_channel`, `preferred_device`, `top_category`, `acquisition_source`, `last_activity_at`, `health_band`, `churn_score`, `lifecycle_stage`).
- **Inputs:** `silver_customer`, `silver_order_state`, `silver_touchpoint`, `silver_page_view`, `silver_order_line`; and (cross-Gold) `gold_customer_health`, `gold_customer_scores`.
- **Outputs:** `brain_gold_local.gold_customer_360` → `mv_gold_customer_360`. PK `(brand_id, brain_id)`.
- **Dependencies:** Phase-1 Customer360 contract (consumed, never mutated).
- **Processing logic:** single-responsibility staging builders (touchpoint enrich / device enrich / category enrich / health+scores fold), each optional → `NULL`. Pure scalar transforms factored into `_customer_360_enrich.py`, unit-tested without Spark, then applied via UDF so executed logic == tested logic. `aov_minor = lifetime_value_minor div lifetime_orders` (IntegralDivide, per-currency, nullsafe). Mode ties tie-break lexicographically (`pick_mode`, mirrored in the Spark window `_n DESC, _v ASC`).
- **Incremental strategy:** full recompute → MERGE on PK. (Incremental is the scaling target in §13.)
- **Replay strategy:** deterministic; idempotent MERGE.
- **Failure handling:** `_read_silver`/`_read_gold` degrade gracefully on cold sources → `NULL`.
- **Performance/Scalability:** `bucket(256, brand_id)`.
- **Monitoring:** `main()` emits `emit_job_log` with correlation id (`gold_customer_360.py:438-461`).

**Weaknesses & required improvements:**

1. **Cross-Gold eventual-inconsistency (P1).** `health_band`/`churn_score`/`lifecycle_stage` fold from Phase-2 sibling marts (`gold_customer_health`, `gold_customer_scores`). On a cold cycle they are absent → those columns are `NULL` while lifecycle counts are present → the row is transiently internally inconsistent (`gold_customer_360.py:286-291` documents this). **Fix:** either (a) toposort the DAG so scores/health build before customer_360 (§2), **or** (b) fold the RFM/health signals **inline from the spine** exactly as `gold_customer_segments.py` already does (the no-cross-Gold pattern — make this the standard).
2. **`preferred_device` is identified-session-biased.** It modes `silver_page_view.device_class` bridged via `silver_touchpoint(brand_id, brain_anon_id → stitched_brain_id)`. Anonymous, never-stitched pageviews are dropped. **Fix:** label the contract column "identified-session device," not "preferred device."
3. **`top_category` is a proxy** (`silver_order_line.title` mode) until a real category dimension exists (`gold_customer_360.py:35`, honest). Low risk; tracked.
4. **DESIGNED-TARGET — completeness stamp.** Add a `data_completeness` / freshness stamp per row recording which optional sources were present at build, so downstream AI/dashboards can distinguish "NULL = no data" from "NULL = cold cycle." Today both look identical.
5. **Observability uniformity (P2):** extend the structured `spark_job` log line (already in `gold_customer_360.main()`) to segments/scores/attribution `main()` (which still only print a human DONE line).

---

## 4. MODULE — Journey analytics

**State: BUILT.** Files: `db/iceberg/spark/gold/gold_journey.py`, `gold_attribution_paths.py`; `packages/metric-engine/src/customer-journey.ts`, `journey-mix.ts`.

- **Purpose:** reconstruct per-customer touch sequences and journey-path aggregates from the stitched touchpoint spine for attribution and path analysis.
- **Inputs:** `silver_touchpoint` (stitched), `silver_order_state` (conversions).
- **Outputs:** `gold_journey`, `gold_attribution_paths` → `mv_*`.
- **Dependencies:** journey-stitch step in `v4-refresh-loop.sh` (rebuilds `silver_touchpoint` before Gold journey/attribution).
- **Processing logic:** deterministic ordering by `touch_seq`; path keys are ordered channel concatenations.
- **Incremental/Replay:** full recompute → MERGE; deterministic keys.
- **Edge case (load-bearing for §5):** journey touch sets are currently **unbounded in time** and include any touch the stitcher attached. A conversion-time cutoff and a lookback window must be applied at the journey/credit boundary (see §5.2 #1 and #2). On local Silver there are currently 0 stitched touchpoints, so downstream credit tables are empty — this **masks** the late-touch hazard until stitching produces post-conversion touches.

---

## 5. MODULE — Multi-touch attribution

**State: BUILT, deep.** Files: `packages/metric-engine/src/attribution-models.ts` (first/last/linear/position/time-decay), `attribution-datadriven.ts` (Markov), `attribution-clawback.ts`, `attribution-confidence.ts`, `attribution-reconciliation.ts`, `attribution-channel-roas.ts`, `attribution-campaign-roas.ts`, `blended-roas.ts`; `db/iceberg/spark/gold/gold_attribution_credit.py`, `gold_attribution_paths.py`, `_attribution_math.py`; driver `apps/core/.../attribution/internal/reconcile-attribution.ts`; contract `packages/contracts/src/api/attribution.api.v1.ts`.

### 5.1 Strengths (best-practice — keep)

- **No float touches money.** Weights are integer 1e8 units (`WEIGHT_SCALE = 100_000_000n`); Σ closed via largest-remainder (`distributeRemainder`/`normalizeWeightUnits`); revenue apportioned by `apportionMinor` with a hard `Σ out == totalMinor` assertion (`attribution-models.ts:410-415`). Markov confines float to the weight vector, quantized to 1e8 before any money (`attribution-datadriven.ts:18-29,165`).
- **Dual implementation, parity-exact** (`_attribution_math.py` is a 1:1 port; `attribution-parity-oracle.test.ts`).
- **Refunds/cancellations via SAVED-weight clawback** (`attribution-clawback.ts`): negative rows mirrored over the **persisted** `weight_fraction` (never re-apportioned), idempotent on `reversalLedgerEventId`; `clampReversalBasis` (`:141`) caps cumulative clawback at Σcredit so duplicate/oversized reversals can't drive attributed revenue negative (audit R-11). Full RTO → Σ(credit+clawback)=0; partial refund → proportional.
- **Closed-sum reconciliation** (`attribution-reconciliation.ts:82-92`): always returns `unattributed = realized − attributed` plus the per-channel split; integer basis-point rates (`attributionRatePct`, truncate-not-round). Residual never hidden.
- **Confidence-graded** (strong/partial/weak → 1.000/0.700/0.400) from deterministic-channel signals (click-ids / utm_medium): `attribution-confidence.ts`, `_attribution_math.py:316-337`.
- **Replayable/idempotent:** `credit_id = sha256(brand‖order‖anon‖touch_seq‖model‖'credit'‖v1)`; clawback id keyed on the reversal event.

### 5.2 Gaps & required improvements (the real findings)

**#1 — P0: Late-touch restatement hazard.** The Gold credit MERGE is **INSERT-only** (`gold_attribution_credit.py:342` — `WHEN NOT MATCHED THEN INSERT`, no `WHEN MATCHED UPDATE`), and `credit_id` keys on `touch_seq`, **not** on `n` or the weight. If a journey gains a touch *after* the order was credited, existing touches' correct weights change (their `n` grew) but their `credit_id`s don't → MERGE keeps **stale** weights while the new touch is inserted → **Σ credited ≠ realized** (silent over-attribution), breaking the closed-sum oracle for that order.
> **Fix (choose, recommend a+):**
> (a) Only count touches with `touch.occurred_at ≤ conversion_occurred_at` — a conversion-time cutoff makes the touch set **stable** (also fixes view-through ordering). **Strongly recommended.**
> (b) Make credit restatement transactional: delete-then-insert per `(order_id, model)` on recompute, **or** key the MERGE on the `(order_id, model)` group so a changed journey fully restates.
> Additionally: add a **per-order closed-sum assertion** in the Spark job after MERGE (the TS path asserts per-apportionment; the Spark path must assert Σ-per-order-after-MERGE).

**#2 — P0: No configurable attribution lookback window.** The credit basis (`reconcile-attribution.ts:118-136`, `gold_attribution_credit.py:_read_recognized_basis`) reads **all** recognized events with no `occurred_at` window; touches are unbounded in time. (`grep lookback|attribution_window` finds only cod-rto/funnel constants — none in attribution.)
> **Fix:** add brand-config `attribution_lookback_days` (default 90 click / 1 view). Apply where touches are assembled — in the Spark credit job filter `conversion_occurred_at − lookback ≤ touch.occurred_at ≤ conversion_occurred_at`, and mirror in the TS writer's touch resolution. This changes the weight base `n`, so the lookback must be a **first-class, versioned input to `credit_id`** (see #5).

**#3 — P1: Single fixed revenue basis (no gross/net/profit selection).** `grep revenue_basis|gross|profit` in attribution modules → nothing. Basis is hardcoded to "recognized" = `finalization ∪ cod_delivery_confirmed` (`reconcile-attribution.ts:44`, `gold_attribution_credit.py:73`) = net realized.
> **Fix:** promote `revenue_basis ∈ {gross, net, profit}` to a first-class dimension feeding `credit_id`. `profit` sources `contribution_minor` from `gold_contribution_margin.py` instead of `amount_minor`. The apportionment math is basis-agnostic (just a signed total), so this is mostly plumbing + a basis column on the ledger. Profit-based attribution is the highest-value enterprise add and the margin data already exists.

**#4 — P1: Markov data_driven is first-order, global-only, full-corpus, untimed, un-pinned.** `computeMarkovChannelWeights` learns **global per-channel** weights from the whole corpus then distributes by channel — ignores touch *position* and *recency* (a channel appearing twice just gets 2 shares, `attribution-datadriven.ts:181-188`); retrains on the **entire** corpus every run (no incremental/windowed training); weights drift silently as the corpus grows; historical credit rows are INSERT-only and won't restate → the ledger holds credits computed under **different vintages** with no `model_snapshot_id`.
> **Fix:** persist the trained `channelWeightUnits` vector with a `markov_model_snapshot_id` (use the existing-but-always-NULL `metric_snapshot_id` column, `gold_attribution_credit.py:231`), stamp it on every data_driven credit row, and train on a configurable window. Per-brand training (vs. global) is a fairness/accuracy caveat to surface; pairwise/higher-order transitions are a future model.

**#5 — P1: `metric_snapshot_id` / `model_version` are inert.** Every credit row writes `model_version='v1'`, `metric_snapshot_id=NULL`. These are precisely the seams that make incremental recompute and basis/lookback/Markov-vintage versioning auditable. **Activate them** (drives #1/#3/#4).

**#6 — P2: `time_decay` half-life not configurable end-to-end.** `computeWeightUnits` accepts `halfLifePositions` but the driver and Spark use default `H=1` (only value with exact integer math). The general integer-nth-root path exists and is parity-ported → exposing per-brand `H` is low-risk/additive. Note: `time_decay` uses **positional** age (touch index), not **temporal** age (documented, `attribution-models.ts:26-30`); enterprise buyers often expect time-based decay — add a config flag once lookback (#2) lands (you'll then have `occurred_at` deltas).

**#7 — P3: Spark clawback fold not yet ported.** `gold_attribution_credit.py:38-42` documents that clawback rows are produced only by the TS writer and skipped in Spark (no-op on 0-credit ledger). Once credits exist, the Spark dual-run diverges from the TS ledger on any reversal until ported. Tracked follow-up.

**#8 — Low: SQL-injection surface (guarded).** Reconciliation/ROAS interpolate `model`/dates into SQL but guard with `/^[a-z0-9_]+$/` and `toISOString().split('T')[0]` (`attribution-reconciliation.ts:144,152-165`, `attribution-channel-roas.ts:86-89`). Correct, but ad-hoc per file. **Centralize** a `safeModelId()`/`isoDate()` helper, and route dynamic values through the adapter `?`/params path (§16.3).

### 5.3 Attribution module contract

- **Purpose:** assign each recognized conversion's realized (or, target, gross/profit) revenue to journey touches under a selectable model, exactly and reversibly.
- **Inputs:** `silver_touchpoint` (stitched, lookback-bounded — target), recognized basis from `gold_revenue_ledger`, reversal events; brand config (lookback, half-life, basis — target).
- **Outputs:** `gold_attribution_credit` (per-touch credit + clawback rows; `credit_id`, `weight_fraction`, `confidence`, `model`, `model_version`, `revenue_basis` [target], `metric_snapshot_id` [activate]), `gold_attribution_paths`; reconciliation/ROAS at read.
- **Dependencies:** journey-stitch (§4), recognition chain (§9 `gold_revenue_ledger`), margin (§9 `gold_contribution_margin`, for profit basis).
- **Incremental:** full recompute (target: snapshot-pinned + lookback-bounded restatement).
- **Replay:** deterministic `credit_id`; idempotent MERGE — **but must become restatement-safe (#1)**.
- **Failure handling:** clamp reversal basis at Σcredit; honest unattributed residual; null ratio on zero spend.
- **Performance/Scalability:** `bucket(256, brand_id)`; date-partition the credit/ledger marts (§12.b).
- **Monitoring:** closed-sum oracle (grade it in DQ, §14).

---

## 6. MODULE — Segmentation

**State: BUILT (deterministic), with documented scope limits.** Files: `db/iceberg/spark/gold/gold_customer_scores.py` (RFM), `gold_customer_segments.py` + `_segment_rules.py` (+`_segment_rules_test.py`); `packages/metric-engine/src/customer-segments.ts`, `customer-score.ts`.

Three layers:
- **RFM** (`gold_customer_scores.py`): recency/frequency/monetary each 1..5 + `churn_risk` band; transparent integer thresholds (not ML).
- **Value tier + Lifecycle/behavioral** (`gold_customer_segments.py` over `_segment_rules.py`): two orthogonal dimensions keyed `(brand_id, segment_type, segment)`; `value_tier` ladder + `lifecycle` (VIP/loyal/high_value/first_time_buyer/at_risk/churned/cart_abandoner/window_shopper) via first-match precedence.
- **Propensity/predictive:** **REGISTERED-DISABLED** (`predictive_ltv`/`predictive_health`, `_gold_registry.py:577-612`, `enabled=False`, fail-closed, never faked).

**Strengths:** rules single-sourced as module constants; the exact CASE **string** the Spark job runs is unit-tested against sqlite with a parallel pure-Python reference (`_segment_rules.py` + `_segment_rules_test.py`). No cross-Gold dependency — RFM/health folded **inline from `silver_customer`** (`gold_customer_segments.py:23-27`) so it can run in Phase 1 before scores/health (the pattern Customer360 should adopt, §3.1). Deterministic precedence is well-reasoned (a churned VIP is operationally churned).

**Weaknesses & required improvements:**

1. **P2 — Confined to the PURCHASER spine.** `silver_customer` is built by grouping `silver_order_state`, so every row has `lifetime_orders ≥ 1`. Thus `cart_abandoner`/`window_shopper` are **proxies within purchasers**, not true non-purchaser browse/abandon segments (`_segment_rules.py:46-52`, honest). **DESIGNED-TARGET:** add an anon-visitor segment mart reading `silver_page_view`/`silver_cart_event` keyed on `brain_anon_id`, then union identified+anon. Additive (`new reads_from`). This is the single biggest segmentation gap for a growth-OS.
2. **P2 — `segment_value_minor` blends currencies.** `gold_customer_segments.py:34-38` sums `lifetime_value_minor` across all of a brand's currencies into one bucket with no `currency_code` (registry `money_columns=[]`, parity oracle deliberately skips it, `_gold_registry.py:295`). Meaningless for a multi-currency brand. **Fix:** key the rollup `(brand_id, segment_type, segment, currency_code)` and carry the sibling currency (invariant I-S07).
3. **P2 — Recency uses build-time `current_date`, not as-of.** `recency_days = datediff(current_date, last_seen_at)` (`gold_customer_segments.py:124`) → non-reproducible historically; re-running next week re-buckets customers. **Fix:** accept an `as_of_date` parameter (reuse the existing `snap_*`/`_snap_as_of.py` as-of pattern) so segment history is replayable.
4. **P2 — Thresholds global, not brand-configurable.** VIP/loyal/value cutoffs are hardcoded constants (an INR-scale `1e7`-minor VIP floor is arbitrary across brands/currencies). **Fix:** externalize to per-brand config (constants are cleanly single-sourced → low-risk).

**Segmentation module contract:** Purpose = deterministic, replayable customer grouping for activation; Inputs = `silver_customer` (+ target: `silver_page_view`/`silver_cart_event`); Outputs = `gold_customer_scores`, `gold_customer_segments` → `mv_*`; Incremental = full recompute → MERGE; Replay = deterministic CASE strings (target: as-of param); Failure = honest first-match precedence, no fabricated tier; note no per-brain_id segment read seam exists → `segment_lookup` MCP tool is REGISTERED-DISABLED (§17).

---

## 7. MODULE — LTV (historical / predictive / cohort)

**State: historical BUILT (three coexisting definitions — consistency risk); predictive REGISTERED-DISABLED; cohort PARTIAL.**

### 7.1 Historical LTV — BUILT, but 3 definitions

- Brand cohort-naive LTV = `realized_value_minor ÷ distinct_customers` — `packages/metric-engine/src/executive-metrics.ts:127`.
- Per-customer lifetime value = `Σ order_value_minor` — `gold_customer_360.py`, `gold_ai_features.py`.
- Acquisition-cohort LTV = `cohort_value_minor = Σ lifetime_value_minor` — `gold_cohorts.py:346`.

Each is correct in isolation, but there is **no single canonical `ltv`**; the executive tile and the cohort page can legitimately disagree (different denominators).
> **Fix (P3):** designate one registry metric `ltv` with an explicit grain; have the others reference it.

### 7.2 Predictive LTV — REGISTERED-DISABLED (correct)

`predictive_ltv`: `enabled=False`, `module=None`, `mv_name=None`, `not_implemented_reason="NotImplementedYet…"` (`_gold_registry.py:577-600`). Fails closed via `disabled_marts()` / `NotImplementedYetError`. Promotion path declared (`reads_from=["silver_customer","gold_revenue_ledger"]`, needs a `brain_ops.model_registry` version). **Keep — no black box.**

### 7.3 Cohort LTV — PARTIAL

`gold_cohorts` stores a **single lifetime-to-date** value per acquisition month, **not** a `cohort_month × months_since_acquisition` retention/value triangle. `computeCohortRetention` admits this (`executive-metrics.ts:162-164`).
> **DESIGNED-TARGET (P1):** add `gold_cohort_activity` keyed `(brand_id, cohort_month, period_offset)` summing realized value/orders per offset from `silver_order_state` joined to first-seen → true retention/value triangle and cohort-performance. This also unblocks cohort×channel (§10).

**LTV module contract:** Inputs = `silver_customer`, `silver_order_state`, `gold_revenue_ledger`; Outputs = per-customer LTV (`gold_customer_360`), cohort LTV (`gold_cohorts`, target `gold_cohort_activity`); Incremental = full recompute; Replay = deterministic; Failure = honest-null; predictive marts fail closed.

---

## 8. MODULE — Marketing intelligence

**State: BUILT, deterministic/replayable.** Files: `blended-roas.ts`, `attribution-channel-roas.ts`, `attribution-campaign-roas.ts`, `cac.ts`, `gold_cac.py`, `gold_campaign_performance.py`, `gold_marketing_attribution.py`.

**Coverage:** blended ROAS, channel ROAS, campaign ROAS (Gold `gold_campaign_performance.py` with integer-bps CTR/CPC/ROAS), CAC, revenue-by-channel/campaign. All read deterministic ledgers, exact bigint money, per-currency-never-blended, honest-null.

**Weaknesses & required improvements:**

1. **P1 — `platformToChannel` hardcoded map.** `attribution-channel-roas.ts:49-53` maps only `meta`/`google_ads`/`tiktok`; any new platform silently falls through to `'paid'` → wrong per-channel ROAS, no error. A parity test guards known literals (the comment documents a prior real `google` vs `google_ads` bug), but a *new* platform reintroduces silent misattribution. **Fix:** a registered platform→channel table that **fails loudly** (logs/raises) on an unmapped platform rather than collapsing to `'paid'`.
2. **P1 — CAC is blended-spend CAC, possibly mislabeled.** `gold_cac.py` numerator = **all** monthly spend (incl. retention); denominator = `new_customers` by `first_seen_at`. (a) overstates true acquisition CAC; (b) `cac.ts:233` documents the denominator as "first order in-month" but the impl uses `silver_customer.first_seen_at` (first *identification*, which can be a pixel anon event). Doc and code disagree. **Fix:** label "blended CAC"; reconcile first-seen-vs-first-order.
3. **P2 — Time-base mismatch in ROAS windows.** Channel/campaign ROAS filter credited revenue on `economic_effective_at` but spend on `stat_date` (`attribution-channel-roas.ts`). For short windows, revenue recognized after the spend window distorts ROAS. Acceptable; **document for marketers.**
4. **Caveat — Markov is GLOBAL, not per-brand** (§5.2 #4): small brands inherit corpus-wide removal effects. Surface the accuracy/fairness caveat.
5. **DESIGNED-TARGET — cohort×channel.** No `cohort × channel` mart exists (channel-effectiveness-by-cohort). Build on `gold_cohort_activity` (§7.3).

**Marketing module contract:** Inputs = `gold_attribution_credit` (net of clawback), `silver_ad_spend`/`gold_*` spend ledgers, `gold_campaign_performance` raw stats; Outputs = ROAS/CAC marts + read-time ratios; money per-currency-only, ratio `NULL` on zero spend (no fabricated ∞); operands always exact BIGINT.

---

## 9. MODULE — Revenue recognition & contribution (ledger backbone)

**State: BUILT.** Files: `db/iceberg/spark/gold/gold_revenue_ledger.py`, `gold_revenue_analytics.py`, `gold_contribution_margin.py`; `packages/metric-engine/src/provisional-revenue.ts`, `orders-timeseries.ts`, `revenue-timeseries.ts`.

- **`gold_revenue_ledger`** reproduces the recognition chain byte-exact; `ledger_event_id = sha2(concat_ws('\0', …))`. Read paths exclude `event_type <> 'provisional_recognition'` (`blended-roas.ts:382-383`, `orders-timeseries.ts:71`, `revenue-timeseries.ts:85`).
- **`gold_revenue_analytics`** is **month-grain only** (`period_month = yyyy-MM`, `gold_revenue_analytics.py:220`).
- **`gold_contribution_margin`** provides `contribution_minor` (needed for profit-basis attribution, §5.2 #3).

**Weaknesses:**
1. **P3 — `gold_revenue_ledger.py` doesn't use the shared base** (own `main()`/MERGE/`emit_job_log`; a confusingly-named `BRONZE_TABLE` constant actually points at `brain_silver.silver_collector_event`). It is the highest-risk money mart and most likely to drift. **Fix:** fold onto `merge_on_pk`/`run_job`.
2. **DESIGNED-TARGET — `gold_revenue_daily`.** Daily/weekly executive series currently come from a different code path (`orders-timeseries.ts`/`revenue-timeseries.ts` reading `gold_revenue_ledger` directly), while `gold_revenue_analytics` is month-only. Add a single additive `gold_revenue_daily` mart that weekly/monthly roll up from, so daily-weekly-monthly is one source/one basis (§12 executive consistency).

---

## 10. MODULE — Executive KPIs

**State: mostly BUILT (additive-component discipline correct).** Files: `db/iceberg/spark/gold/gold_executive_metrics.py`; `packages/metric-engine/src/executive-metrics.ts`, `kpi-summary.ts`, `gold_retention.py`.

`gold_executive_metrics.py` stores **additive components** (orders, realized value, distinct customers, terminal/delivered/rto/cancelled/refunded counts); ratios (AOV, LTV, refund-rate, repeat-rate, growth) are **derived at read** (`executive-metrics.ts`) — textbook ADR-004.

**The significant finding — P0: inconsistent "realized revenue" basis across dashboards.**
- `gold_executive_metrics.realized_value_minor` = `Σ order_value_minor` over **all lifecycle states, no `provisional` exclusion**. `silver_order_state.order_value_minor` = `Σ amount_minor where lifecycle_state <> 'placed'` (`silver_order_state.py:362-364`) → **includes provisional recognition rows**.
- The Revenue/ROAS path **excludes** `provisional_recognition` (§9).
- Net: a brand with in-flight provisional revenue shows a **higher Executive headline** (`realizedValueMinor`, labeled "Realized GMV (finalized)" at `executive-metrics.ts:40`) than its Revenue page / ROAS numerator. The label says "finalized" but the math isn't — a cross-dashboard truth violation ("Revenue truth over platform truth").
> **Fix:** re-point `gold_executive_metrics` to the `gold_revenue_ledger` provisional-excluded math, **or** rename the tile to "Gross order value" and add a separate finalized-revenue tile.

**Other executive findings:**
- **P2 — daily/weekly rollups GAP in Gold.** See §9 `gold_revenue_daily` DESIGNED-TARGET. Today "daily-weekly-monthly consistent" rides two sources with two revenue bases.
- **P3 — `repeat_rate` defined twice.** `executive-metrics.ts:103-104` (from `mv_gold_customer_360`, `COUNT lifetime_orders>=2`) vs `gold_retention.py:463` (from `silver_customer`). Same concept, two sources → drift. **Canonicalize one.**
- **AOV denominator** divides `realized_value_minor` by `total_orders` over all lifecycle states (`gold_executive_metrics.py:93`) — numerator/denominator consistent; confirm intent (includes cancelled/rto orders that may carry netted value).

**Executive module contract:** Inputs = `silver_order_state`, `gold_revenue_ledger` (target basis), `mv_gold_customer_360`; Outputs = `gold_executive_metrics` (additive) + read-time ratios; Replay = deterministic given an as-of basis (today wall-clock for growth deltas — see §11.1).

---

## 11. Reproducibility / Versioning / Explainability / Incrementality (cross-cutting)

### 11.1 Reproducible — PARTIAL (weakest axis)

Transforms are deterministic and idempotent, but behavioral marts embed wall-clock:
- `gold_customer_scores.py:760-763` — `snapshot_date = current_date()`, `days_since_last_order = datediff(current_date(), …)` → RFM tiers and `churn_risk` change by the day; not reproducible as-of a past date.
- Same in `gold_customer_health.py` (`datediff(current_date(),…)`) and `gold_retention.py:460` (rates recomputed against today's counts).
- **No `as_of_date` parameter anywhere.**
> **Fix (P1):** thread a single `RUN_AS_OF_DATE` env into `_gold_base` and replace `current_date()`/`current_timestamp()` with it across `gold_customer_scores`/`_health`/`_retention`/`gold_customer_segments` so backfill/replay reconstructs historical scores exactly.

### 11.2 Versioned — PARTIAL

Point-in-time history exists only for `snap_order_state`, `snap_attribution_credit`, `snap_identity_link` (`_gold_registry.py`, `layer='silver'`; AS-OF read seam `_snap_as_of.py` + `snap_identity_link_asof_test.py` — exemplary). **No snapshot for** `gold_executive_metrics`, `gold_cac`, `gold_cohorts`, `gold_customer_scores`, `gold_customer_health`, `gold_retention` — full-MERGE overwrites `updated_at` and prior values are gone (Iceberg time-travel is the only recourse, not surfaced). "What was the KPI / churn band on date X" is unanswerable.
> **Fix (P1):** add daily `snap_customer_scores` / `snap_executive_metrics` mirroring the existing snap pattern.
> **Snapshot edge case:** `snapshot_date = current_date()` → if `v4-refresh-loop` misses a day, that slice is absent and an AS-OF read silently returns the prior slice (not deterministically backfillable). Add a backfill mode accepting explicit `--snapshot-date`, and document the limitation.

### 11.3 Explainable — BUILT (strength)

RFM (`gold_customer_scores.py:780-794`), health (additive recency 0-60 + frequency 0-40, `gold_customer_health.py`), churn bands, and Markov removal-effect are transparent rule code; LLMs only consume outputs. **Weakness:** thresholds are **hardcoded magic numbers** (recency ≤30/60/90/180, monetary ≥1e7/5e6/1e6/2e5) with no per-brand config/provenance and a single-currency (INR-scale) assumption. **Fix:** externalize to per-brand config (ties to §6.4).

### 11.4 Incremental — GAP (universal)

Every Gold mart is a **full recompute from Silver each refresh** (docstrings in `gold_retention.py`, `gold_customer_health.py`, `gold_ai_features.py`, etc.). `gold_executive_metrics`/`gold_revenue_analytics` rescan all `silver_order_state` every loop; scores/cohorts rescan all `silver_customer`. Silver's watermark/incremental logic is **not** carried into Gold. At low/medium volume this is simplest and fine; at scale it is O(all-history) per 300s cycle — the main cost problem.
> **DESIGNED-TARGET (P1, scaling):** Iceberg incremental/changelog reads or partition-pruned recompute (only touched `bucket(brand_id)` partitions or recent `period_month`), keyed on a Silver `updated_at`/ingestion watermark + brand-scoped MERGE. The registry already declares `pk` and `reads_from` to support this.

### 11.5 Money-rule deviations (honest, tracked — must be structurally fixed)

Two documented currency-blending deviations, both reconciled out-of-band (parity oracle skipped via `money_columns=[]`), neither hidden:
- `gold_customer_segments.segment_value_minor` (`_gold_registry.py:295`) — §6.2.
- `gold_customer_scores` monetary blend.
> **Fix:** add `currency_code` to those grains (multi-row per segment/score) or split into per-currency marts.

---

## 12. Gold layer design

**State: BUILT, mature.** Registry-driven (§1). `pk` brand_id-first; `money_columns` minor+currency pairs; `bucket(256, brand_id)` partitioning; per-table purpose/grain documented in-file.

**Required improvements:**

**(a) P0 — MERGE has no DELETE / no not-matched-by-source handling.** `merge_on_pk` (`_gold_base.py:88-114`) and the bespoke MERGE in `gold_revenue_ledger.py:339` are `WHEN MATCHED UPDATE * / WHEN NOT MATCHED INSERT *` only. A "full recompute" that never DELETEs is **not authoritative**: if a Silver row disappears (order corrected/removed, touchpoint reclassified, currency bucket emptied), its Gold rollup row **survives forever as a phantom**, silently inflating segment/cohort/executive sums.
> **Fix:** `MERGE … WHEN NOT MATCHED BY SOURCE THEN DELETE` (Iceberg/Spark 3.4+), **scoped to the brands present in the staged recompute** (so a partial/brand-scoped run doesn't wipe other tenants), or a brand-scoped `DELETE` + insert inside one transaction. This is the single highest-value Gold correctness fix. (Note this also resolves attribution restatement when combined with §5.2 #1.)

**(b) P1 — Date-grained marts have no date partition.** Every mart is `bucket(256, brand_id)` only. Date-range-served marts — `gold_revenue_ledger` (read with `CAST(economic_effective_at AS DATE) BETWEEN …`), `gold_funnel` (`funnel_date`), `gold_revenue_analytics` (`period_month`), `gold_engagement`/`gold_behavior`/`gold_abandoned_cart` (date) — get **no partition pruning** → every windowed read full-scans the brand bucket.
> **Fix:** add a second partition field on the high-cardinality date marts: `PARTITIONED BY (bucket(256, brand_id), days(economic_effective_at))` / `month(period_month)`. Iceberg hidden partitioning → no reader change, low risk.

**(c) P2 — Versioning is implicit.** No mart-level `schema_version` column; serving-version lives only in the cache key (`SERVING_VERSION='v1'`). Schema evolution relies on Iceberg column-add tolerance + Trino view projection.
> **Fix:** a `_gold_meta` stamp or at minimum a documented 3-step evolution runbook: Spark add col → Trino view project → TS contract.

**(d) P3 — `gold_revenue_ledger.py` doesn't use the shared base** — §9.1.

**(e) Honest money deviations** — §11.5.

---

## 13. Spark implementation

**State: BUILT (batch full-recompute), PARTIAL on incremental.**

- **Idempotency/replay:** strong (deterministic keys, MERGE on PK, byte-identical re-runs).
- **Parity rigor:** `gold_revenue_ledger.py:259-313` documents the `make_dt_interval` and `_sr_dt_str` fixes — keep this standard.
- **Money apportionment:** `_attribution_math.py apportion_minor` is largest-remainder, sign-preserving, Σ-exact.

**Weaknesses (and fixes):**
- **No incremental/watermark/checkpoint on Gold** (streaming/checkpoint live only in the Bronze sink) — §11.4 DESIGNED-TARGET.
- **No exactly-once delete path** — §12.a.
- **`silver_exists()` swallows all exceptions** — §2.
- **Sequencing in bash, not registry** — §2 DESIGNED-TARGET (toposort `reads_from`).

---

## 14. Data Quality

**State: PARTIAL.** Quarantine + 4 graded categories BUILT; reconciliation/LTV/segment/KPI validations largely NOT built as graded checks.

- **Silver quarantine — BUILT/good.** `_silver_technical.py:411 write_quarantine(...)` + `dq_violations_udf` (`:455`), used across ~25 `silver_*` jobs; rejects → `brain_silver.silver_quarantine` (`stage='dq'`). Money/strict-decimal failures (`_raw_normalize.decimal_to_minor_strict`) quarantine, never crash the batch.
- **Graded DQ — BUILT for 4 categories only.** `apps/stream-worker/src/jobs/dq/{freshness,completeness,reconciliation,schema-validity}-check.ts` write `dq_check_result` grades; read seam `get-data-quality-summary.ts` computes cost/effective-confidence + gate at read time (never persists a float). `EXPECTED_COVERAGE` (`get-data-quality-summary.ts`) is the graded matrix.

**Gaps vs the task's named DQ surface (all DESIGNED-TARGET):**
1. **P1 — Attribution reconciliation NOT graded.** The closed-sum oracle (Σ channel + unattributed = realized) is computed at *read* time (`attribution-reconciliation.ts`) but there is no `reconciliation` grade for attribution in `EXPECTED_COVERAGE` (only `bronze_vs_silver.order_state` and `bronze_vs_gold.realized_revenue`). A Σ-mismatch is visible only if someone opens the metric. **Fix:** add an executor grading `attribution.credit_vs_realized`; append to `EXPECTED_COVERAGE`.
2. **Revenue reconciliation grade exists** (`bronze_vs_gold.realized_revenue`) — the load-bearing one. Keep.
3. **P1 — LTV-sanity / segment-completeness / KPI cross-foot NOT built.** No bounds-check on `lifetime_value_minor` (negative LTV, LTV > Σ orders); no segment-coverage check (every customer in exactly one `value_tier` + one `lifecycle`); no KPI cross-foot (executive realized == Σ revenue_ledger non-provisional — directly grades the §10 P0 finding). `predictive_ltv` absence is honest (disabled), but the **deterministic** LTV/segment marts ship ungraded. **Fix:** add these executors to make "confidence before decisions" real for the intelligence marts.
4. **P2 — Serving freshness omits 5 views** without `updated_at` (`snap_*`, `mv_gold_customer_scores`, `mv_silver_order_line`) — `get-serving-freshness.ts:20` (honest, not faked as 'never', but no staleness signal). **Fix:** project `updated_at` onto those marts/views.
5. **Dual freshness surfaces, two stores:** `get-serving-freshness.ts` (Trino `max(updated_at)` cross-brand) vs `get-data-quality-summary.ts` (PG `dq_check_result` per-brand). Document: serving-freshness = pipeline-health truth; `dq_check_result` = per-brand trust truth.

**DQ module contract:** Inputs = Silver/Gold marts + `gold_revenue_ledger`; Outputs = `dq_check_result` grades (A–D, honest D on missing input) + read-time effective-confidence gate; never persists a float; deterministic graders; per-brand isolation.

---

## 15. Operational

**State: BUILT.**

- **Orchestration:** `tools/dev/v4-refresh-loop.sh` (`pnpm dev:v4-refresh`) runs the documented dependency chain; sequencing hardening (toposort) is the §2 DESIGNED-TARGET.
- **Observability:** `gold_customer_360.main()` emits structured `emit_job_log` with correlation id; extend to all marts (§3.5).
- **Operational state:** PostgreSQL `ops` schema / app-written natives (`dq_check_result`, ML inference log). PG is operational-only; Iceberg is the system of record.
- **Snapshots:** `snap_*` AS-OF seam centralized in `_snap_as_of.py`; backfill-mode gap noted (§11.2).

---

## 16. Security & tenancy

**State: BUILT, fail-closed.**

- **Brand isolation at the read seam:** `withTrinoBrand` injects parameterized `brand_id = ?` from the `${BRAND_PREDICATE}` sentinel; **missing sentinel throws (fail-closed)** — the right model since Trino REST has no row-policy. `silver-deps.ts` aliases to it so ~41 callers are unchanged.
- **Cache keys brand-leading by construction** (`buildCacheKey`); invalidation enforces `${brandId}:` prefix on every SCAN with defense-in-depth double-guard + per-key cross-brand guard, FAIL-SAFE commit.
- **PII hash-only**; money bigint-minor + currency_code; brand_id-first PK on every Gold spec.

**Findings/fixes:**
1. **P2 — Trino param "binding" is client-side interpolation** (`trino-adapter.ts substituteParams`; values escaped/validated). `attribution-reconciliation.ts:152-165` interpolates `fromStr`/`toStr`/`model` directly (model regex-guarded `/^[a-z0-9_]+$/`, dates via `toISOString().split` — safe) but bypasses even the adapter `?`-path. **Fix:** route all dynamic values through the `?`/params path; centralize `safeModelId()`/`isoDate()` (§5.2 #8) so escaping is uniform/auditable.
2. **Sanctioned non-scoped read:** `get-serving-freshness.ts` deliberately uses plain `srPool.query` (no `${BRAND_PREDICATE}`) for cross-brand pipeline health (counts/timestamps only, `UNION ALL` over `information_schema`-discovered view names, regex-guarded by `SAFE_MV_NAME`). Justified/documented — keep tightly fenced; ensure **no future tenant-data metric reuses this plain-pool pattern.**
3. **Naming debt (P3, harmless-but-real):** StarRocks references remain in `query-route.ts` enum `starrocks_serving` + docstrings, `trino-deps.ts` header, `_gold_registry.py mv_name` doc, `analytics-cache.ts`, `dispatch-wiring.ts` though the engine is Trino (ADR-0007 records this deferred). An onboarding/audit hazard. **Fix:** one mechanical rename pass (enum + comments).

---

## 17. Scalability

**State: adequate now; explicit scaling cliffs identified.**

- **Partitioning:** `bucket(256, brand_id)` everywhere; **add date partitions** to date-grained marts (§12.b).
- **Incremental:** universal full-recompute is the main cost cliff (§11.4) → Iceberg changelog / partition-pruned recompute.
- **MERGE DELETE scoping:** must be brand-scoped to avoid cross-tenant wipes under partial runs (§12.a).
- **Cache stampede:** `IoredisCacheAdapter.inFlight` is **per-instance only** (in-process Map) → multi-replica core still thundering-herds a hot key. **Fix (multi-replica prod):** layer a Redis `SET NX PX` compute-lock. Latent scale gap, not a bug.

---

## 18. Analytics Gateway integration

**State: BUILT, well-architected (ADR-0007 accurate and load-bearing).**

- **Cache-aside chokepoint:** `createServingCacheReader` wrapped by `cachedRead` in `analytics-core.routes.ts:39` (pass-through when `servingCache` absent). Fail-soft: GET-fail → direct compute; SET-fail → serve+drop-write; compute-fail → propagate (no double query, no retry).
- **Keys:** brand-leading; params hashed order-insensitively (`canonicalize` + sha256).
- **Gold-never-direct** (ADR-0007 D4) enforced by the CI naming guard.

**Findings/fixes:**

**(a) P2 — Cache invalidation does NOT cover non-identity Gold refreshes.** `v4-refresh-loop.sh` rebuilds **all** Gold every cycle but emits **no** `cache.invalidate` (the loop has no Redis step; `_gold_base.emit_cache_event` exists but is opt-in, never called by any mart, not wired to a Kafka producer — it only prints a JSON line nobody ships). The **only** publisher of `cache.invalidate.v1` is `IdentityChangeRecomputeConsumer`, scoped to customer-grained marts on identity change. So a new order changing revenue/attribution/funnel/executive marts is **not** event-invalidated → relies **solely on the 30s TTL** (`TRINO_SERVING_CACHE_TTL_MS` default `30_000`, `core.ts:92`). Bounded ≤30s staleness (acceptable), but ADR-0007's "invalidation after Gold refresh" framing **overstates** coverage.
> **Fix (choose):** (i) make `v4-refresh-loop` emit `gold.rewritten` → `cache.invalidate` per rebuilt mart (wire `emit_cache_event` + a log-shipper / small producer step), closing the loop honestly; **or** (ii) document explicitly that TTL is the primary freshness mechanism and event-invalidation is an identity-only fast-path. Also verify the 30s TTL hit-rate target for low-QPS brands (it caps usefulness — the cache mostly serves repeated reads inside a 30s window).

**(b) P2 — Stampede guard per-instance only** — §17.

**(c) P2 — Standardize dynamic SQL through `?`/params** — §16.1.

**(d) P3 — StarRocks→Trino naming pass** — §16.3.

**(e) `get-serving-freshness.ts` sanctioned non-scoped read** — §16.2.

**Gateway contract:** Inputs = brand-scoped metric requests; Path = Redis cache-aside → Trino-over-Iceberg → metric-engine compute; Failure = fail-soft cache, fail-closed brand seam; Replay = deterministic compute behind the cache; Monitoring = serving-freshness (§14.4).

---

## 19. AI / MCP integration

**State: BUILT, exemplary — read-only by construction.**

- **Registry SoT:** `packages/ai-gateway-client/src/mcp-tools.ts` — 11 tools, **every** `access:'read'`; `writeToolCount` derived (===0, CI-asserted in `tools/isolation-fuzz/src/mcp.test.ts`). `FORBIDDEN_TOOL_NAME_SUBSTRINGS` bans sql/write/mutate/etc. in tool names. **No SQL tool, no text-to-SQL.**
- **Tools:** `customer360_lookup`, `journey_lookup`, `attribution_lookup`, `marketingperf_lookup`, `ltv_lookup`, `recfeature_lookup`, `timeline_lookup`, `identity_explainability_lookup`, `list_metrics`, `resolve_and_compute`. `segment_lookup` is **REGISTERED-DISABLED** (honest: `gold_customer_segments` is brand-grained, no per-`brain_id` backing read → fails closed `NotImplementedYet`, never fakes empty).
- **Mount:** `dispatch-wiring.ts` — `brand_id` from `McpPrincipal` (never tool input); seams are read-only metric-engine + injected read-only identity. **The LLM selects a binding; the engine produces the number** — "LLMs never compute" is structurally enforced.
- **AI→Trino ad-hoc SQL:** `routeAiAdHocTrino()` unconditionally throws `NotImplementedYet` (registered, greppable, test-covered) — disabled by policy, not omission.

**Minor guidance:**
- `ltv_lookup` folds brand currency from a second `getCustomer360Summary` read to pair money with currency (`dispatch-wiring.ts:98`) because the score mart has no currency — honest workaround, but an N+1. **If `ltv_lookup` becomes hot:** denormalize `currency_code` onto the score mart (also resolves §11.5).
- No further security findings.

**AI/MCP contract:** Inputs = LLM tool selection + `McpPrincipal.brand_id`; Outputs = deterministic metric-engine results; Failure = disabled tools fail closed (`NotImplementedYet`); Security = read-only by type system + CI fuzz; no write/SQL path can be added without tripping the `writeToolCount===0` gate.

---

## 20. Recommendation & ML features mart

**State: BUILT (deterministic features); predictive consumers REGISTERED-DISABLED.** Files: `db/iceberg/spark/gold/gold_recommendation_features.py`, `gold_ai_features.py`; `packages/metric-engine/src/recommendation-features.ts`, `ai-features.ts`.

- **Purpose:** expose a deterministic per-customer feature row for recommendation/ML consumers and the `recfeature_lookup` MCP tool.
- **Inputs:** `silver_customer`, `silver_order_state`, `gold_customer_360`/scores.
- **Outputs:** `gold_recommendation_features`, `gold_ai_features` → `mv_*`.
- **Predictive consumers:** `predictive_ltv`/`predictive_health` are REGISTERED-DISABLED (§7.2); features are runtime-folded, never a permanent feature-precompute table (per the no-`feature_customer_daily` invariant). Replay = deterministic; Failure = honest-null.

---

## 21. Consolidated priority backlog

| Pri | Finding | File(s) |
|---|---|---|
| **P0** | Gold MERGE: add brand-scoped DELETE-not-matched-by-source (phantom rollup rows) | `_gold_base.py:88`, `gold_revenue_ledger.py:339` |
| **P0** | Late-touch attribution restatement hazard (INSERT-only + `touch_seq`-keyed id → Σ≠realized) | `gold_attribution_credit.py:342` |
| **P0** | No configurable attribution lookback window (touches unbounded in time) | `reconcile-attribution.ts:118`, `gold_attribution_credit.py` `_read_recognized_basis` |
| **P0** | Inconsistent realized-revenue basis (executive includes provisional; revenue/ROAS excludes it) — "finalized" mislabel | `gold_executive_metrics.py`, `executive-metrics.ts:40`, `silver_order_state.py:362` |
| **P1** | No gross/net/profit revenue-basis selection (profit data exists in `gold_contribution_margin`) | `reconcile-attribution.ts:44` |
| **P1** | Markov: global-only, full-corpus retrain, no pinned vintage on rows — activate `metric_snapshot_id` | `attribution-datadriven.ts`, `gold_attribution_credit.py:231` |
| **P1** | Customer360 cross-Gold eventual-inconsistency → toposort DAG or fold inline | `gold_customer_360.py:286` |
| **P1** | Thread `as_of_date`/`RUN_AS_OF_DATE` (scores/health/retention/segments non-reproducible) | `gold_customer_scores.py:760`, `gold_customer_health.py`, `gold_retention.py:460` |
| **P1** | Add daily snapshots (`snap_customer_scores`, `snap_executive_metrics`) | `_snap_as_of.py`, registry |
| **P1** | Build `gold_cohort_activity` (cohort_month × period_offset) → retention/LTV triangle + cohort×channel | `gold_cohorts.py:346` |
| **P1** | Make `platformToChannel` a fail-loud registered map | `attribution-channel-roas.ts:49` |
| **P1** | Grade attribution reconciliation + add LTV-sanity / segment-completeness / KPI cross-foot DQ executors | `get-data-quality-summary.ts` `EXPECTED_COVERAGE` |
| **P1** | Date-partition date-grained Gold marts | `gold_revenue_ledger.py`, `gold_funnel.py`, `gold_revenue_analytics.py`, `gold_engagement/behavior/abandoned_cart` |
| **P1** | Incrementalize big rollups (Iceberg changelog / partition-pruned recompute) | all enabled Gold |
| **P1** | Topologically derive run order from `_gold_registry.reads_from` | `tools/dev/v4-refresh-loop.sh`, `_gold_registry.py:101` |
| **P2** | Close cache-invalidation loop for non-identity marts (or document TTL-as-primary) | `v4-refresh-loop.sh`, `_gold_base.emit_cache_event`, `IdentityChangeRecomputeConsumer` |
| **P2** | Segmentation: anon-spine browse/abandon mart; per-currency `segment_value_minor`; as-of recency; configurable thresholds | `gold_customer_segments.py`, `_segment_rules.py` |
| **P2** | Tighten `silver_exists()` to not-found-only; multi-instance Redis stampede lock; standardize `?`-param SQL | `_gold_base.py:71`, `IoredisCacheAdapter`, `attribution-reconciliation.ts` |
| **P2** | Add `gold_revenue_daily` additive mart (single daily/weekly/monthly basis) | `gold_revenue_analytics.py:220` |
| **P2** | Project `updated_at` onto the 5 freshness-omitted views | `get-serving-freshness.ts:20` |
| **P2** | Customer360 `data_completeness` stamp; uniform `spark_job` log across marts; relabel `preferred_device` | `gold_customer_360.py` |
| **P3** | Port Spark clawback fold; canonicalize `ltv`/`repeat_rate`; mart `schema_version`; fold `gold_revenue_ledger` onto base; reconcile/relabel CAC; StarRocks→Trino rename pass | various |

---

## 22. Invariant compliance summary

Upheld across the reviewed surface: bigint-minor + sibling `currency_code` (never blended — two honest, in-code-documented deviations tracked in §11.5), brand_id-first tenancy, `${BRAND_PREDICATE}` fail-closed isolation, PII-hash-only, deterministic-first, LLMs-consume-never-compute (CI-enforced `writeToolCount===0`), honest-empty / unattributed-residual-always-rendered. The remaining work is **configurability** (lookback, basis, thresholds, as-of), **restatement-safety** (MERGE DELETE + stable touch sets), **reproducibility/versioning** (as-of params + Gold snapshots), **incrementality** (scaling), and **extending segmentation past the purchaser spine** — none of which requires redesigning the approved architecture.
