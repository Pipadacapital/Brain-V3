# perf(spark): partition-incremental for the 16 _gold_base marts (Gold wave 2)

Extends Gold partition-incremental (#302) to the **16 marts built on `_gold_base`** — the bulk of the Gold tier — via a one-line opt-in each. Every Gold aggregation now recomputes only the brands whose source Silver changed.

## The mechanism (no mart SQL changes)
`_gold_base.run_job(..., entity_incremental={table_name, source_tables:[...]})`:
- finds brands changed in **any** `source_table` since the watermark (union across sources; side-table watermark on `updated_at`; a source without `updated_at` degrades safely to "all its brands"),
- adaptively **hash-buckets** the affected brands,
- per bucket registers `_brand_bucket` and **activates `silver()` filtering** — so every `FROM {silver('silver_x')}` in a mart's SQL transparently becomes a brand-scoped view.

`build()` / rollup SQL / `merge_on_pk` are **unchanged**; same UPDATE/INSERT MERGE → parity. `FULL_REFRESH=1` recomputes all brands. Multi-source marts are handled correctly (every silver read is filtered, and affected-brand detection unions all declared sources).

## Converted (16, one-line opt-in each)
`repeat_latency`, `contribution_margin`, `logistics_performance`, `cod_rto`, `settlement_summary`, `funnel`, `abandoned_cart`, `engagement`, `behavior`, `conversion_feedback`, `retention`, `campaign_performance`, `journey`, `customer_health`, `recommendation_features`, `ai_features`.

*(Excluded `gold_campaign_attribution` — it reads only Gold sources, so it needs gold-source watermarking.)*

## Parity-proven
Representative batch via `run-gold-gap-marts` (full == reprocess-all incremental in per-brand buckets), **EXIT 0, 0 failures, no OOM**:

| Mart | full == incremental |
|---|---|
| funnel | 9 | retention | 4 | engagement | 4 | behavior | 17 |
| cod_rto | 2 | logistics_performance | 1 | conversion_feedback | 3 | abandoned_cart | 7 |

The 3-brand marts ran in 3 per-brand buckets and matched exactly — proving the brand hash-bucketing + the `silver()` filtered-view path.

## Gold coverage after this PR
- **Done (18):** `revenue_analytics`, `executive_metrics` (#302) + these 16.
- **Remaining (~9):** 2 direct single/multi-source (`gold_revenue_ledger`, `gold_cac` — same `run_entity_incremental` driver) and the gold-on-gold / custom-helper marts (`attribution_credit`, `attribution_paths`, `cohorts`, `customer_360`, `customer_scores`, `customer_segments`, `marketing_attribution`, `journey_paths`, `campaign_attribution`) — these read other Gold marts, so they chain off gold-source watermarking, a focused follow-up.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
