<!-- SPEC: D.1 / D.5 -->
# Wave D — Semantic layer deprecation map

**Status:** semantic entities LIVE (`iceberg.brain_serving.semantic_*`, `db/trino/views/semantic_*.sql`).
Consumer migration is Wave D.3, gated behind the per-brand flag **`semantic.serving` (DEFAULT OFF**,
`packages/platform-flags`). Until a consumer is migrated + parity-proven behind that flag, it keeps reading
its legacy mart.

## Binding rules (§0.5 additive-only)
- **Nothing here is dropped, renamed, or column-reduced.** Every legacy mart below stays live and served.
  "Deprecated" = *soft* — a new naming/consumption authority exists (the `semantic_*` entity); the legacy
  mart is frozen for NEW consumers only.
- **`consumers-migrated Y/N`** reflects whether the LIVE app/BFF/metric-engine/BAI readers of the legacy
  mart have been repointed at the semantic entity. All currently **N** — D.3 (semantic.serving flag) is the
  route-by-route migration with per-endpoint parity; D.5 lint then blocks NEW consumers of the deprecated
  marts. This map is the input to both.
- The semantic entities are **thin compositions** (views, no recompute) — see `composes` per row.

## Deprecation table (legacy mart → semantic replacement → consumers-migrated)

| Legacy mart / view (stays live) | Semantic replacement | `composes` (what the replacement reads) | consumers-migrated |
|---|---|---|---|
| `mv_gold_customer_360` (`gold_customer_360`) | `semantic_customer` | `gold_customer_360` (spine) + `identity_current_v` (sanctioned identity summary) + `gold_customer_scores` (RFM) | **N** (D.3) |
| `mv_gold_customer_scores` (`gold_customer_scores`) | `semantic_customer` (RFM cols folded in) | `gold_customer_scores` | **N** (D.3) |
| `mv_gold_customer_list` | `semantic_customer` (list = `SELECT … FROM semantic_customer`) | `gold_customer_360` | **N** (D.3) |
| `mv_gold_customer_segments` | `semantic_customer` (`recency/frequency/monetary_score`, `churn_risk`, `lifecycle_stage`) | `gold_customer_360` + `gold_customer_scores` | **N** (D.3) |
| `mv_silver_order_state` (`silver_order_state`) | `semantic_order` (order spine) | `silver_order_state` | **N** (D.3) |
| `mv_silver_order_line` (`silver_order_line`) | `semantic_order` (line summary: count/qty/distinct SKUs) | `silver_order_line` | **N** (D.3) |
| `mv_gold_attribution_credit` (`gold_attribution_credit`) — order-grain slice | `semantic_order` (top deterministic channel/campaign) | `gold_attribution_credit` (deterministic ledger, §1.4) | **N** (D.3) |
| **`gold_contribution_margin`** + served twin `metric-engine/contribution-margin.ts` (**AMD-17**) | `semantic_order` (spec-numbered `cm1/cm2/cm3_minor`) + `semantic_product` (per-product CM) | `gold_order_economics` / `gold_product_economics` (Wave C, **spec** CM numbering) | **N** — see AMD-17 note below |
| `mv_gold_product_detail` (`gold_product_detail`) | `semantic_product` (catalog + performance) | `gold_product_detail` | **N** (D.3) |
| `mv_gold_product_costs` (`gold_product_costs`) | `semantic_product` (cost-validity cols) | `gold_product_costs` (open-interval `valid_to IS NULL`) | **N** (D.3) |
| `mv_gold_campaign_performance` (`gold_campaign_performance`) | `semantic_campaign` (spend/reach/ROAS) | `gold_campaign_performance` | **N** (D.3) |
| `mv_gold_campaign_attribution` (`gold_campaign_attribution`) | `semantic_campaign` (attributed revenue/orders) | `gold_campaign_attribution` (deterministic, §1.4) | **N** (D.3) |
| `mv_gold_cac` | `semantic_campaign.cac_new_minor` | `gold_attribution_credit` ⋈ `gold_order_economics.is_new_customer` | **N** (D.3) |
| `mv_gold_marketing_attribution` | `semantic_campaign` | `gold_campaign_attribution` + `gold_attribution_credit` | **N** (D.3) |
| `mv_journey_events_current` (`journey_events`, Wave B) | `semantic_journey` (namespace alias) | `journey_events` (identical column semantics; `is_current` filter for current) | **N** (D.3) |
| `mv_gold_journey_timeline` | `semantic_journey` | `journey_events` | **N** (D.3) |

**NOT deprecated (kept as-is; the semantic entities do not supersede them):** `mv_gold_journey_paths`,
`mv_gold_attribution_paths`, `mv_gold_product_affinity`, `mv_gold_customer_health`, `customer_sessions_extended_v`
(probabilistic-inclusive, §A.3 — deliberately outside the deterministic semantic entities).

## AMD-17 — `gold_contribution_margin` → semantic economics (naming authority convergence)
Per **AMD-17** (R1, binding): the live `gold_contribution_margin` + its served TS twin use *shifted*
numbering — **live CM1 ≙ spec CM2**, **live CM2 ≙ spec CM3**. Wave C introduced `gold_order_economics` /
`gold_product_economics` with the **industry-standard spec numbering** (CM1 = net − COGS; CM2 = CM1 − fwd/rev
shipping − packaging − fees; CM3 = CM2 − marketing). The **semantic layer is the single naming authority**:
`semantic_order.cm{1,2,3}_minor` and `semantic_product.cm{1,2,3}_minor` are **spec-numbered**.

- Migration mapping for any consumer moving off `gold_contribution_margin`:
  `live cm1_minor → semantic cm2_minor`, `live cm2_minor → semantic cm3_minor`.
- This is an **explicit, tested rename**, never a silent re-label — the live mart + twin are untouched
  (still shifted numbering) until their consumers migrate behind `semantic.serving`. D.5 lint then blocks
  NEW consumers of `gold_contribution_margin`.

## Enforcement (D.4.5 — LIVE)
The deprecation lint is **built and blocking**: `tools/lint/deprecation-guard.sh` (self-test
`--selftest`, wired in `.github/workflows/pr.yml` alongside the sibling guards) fails CI on any **NEW**
app/BFF/metric-engine reference to a deprecated mart. It does **not** touch existing readers — the
grandfathered baseline of current consumers is `tools/lint/deprecation-guard-allowlist.txt` (each with a
WHY; additive — they migrate route-by-route in D.3). As a reader repoints onto the semantic layer, delete
its allowlist line and the guard then blocks any regression back onto the legacy mart. This file is the
allow/deny source of truth; the guard's `DEPRECATED_MARTS` list mirrors the "Legacy mart / view" column
above.
