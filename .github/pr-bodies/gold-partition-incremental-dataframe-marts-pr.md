# perf(spark): partition-incremental for the 3 DataFrame Gold marts

Extends Gold partition-incremental (#302, #303) to the DataFrame-API marts. These aggregate via `.groupBy().agg()` (not SQL views), so the `silver()`-filtered-view path doesn't apply — added `_gold_base.gold_partition_filter(df, table_name, source_tables)` → `(filtered_df, commit_fn)`: restricts the read DataFrame to brands changed in any source since the watermark (side-table; silver_* or gold_* sources), `commit_fn()` advances it **after** the MERGE. FULL_REFRESH/first-run → df unchanged.

## Converted (3)
`gold_cohorts`, `gold_customer_segments`, `gold_customer_scores` (all over `silver_customer`).

**Parity-proven:** incremental (cohorts filtered to 2 changed brands) == FULL_REFRESH == **4 / 15 / 1976**, EXIT 0, 0 failures, no OOM.

## Gold coverage: 21 of 27
Remaining 6 (complex tail, focused follow-up): DELETE-pattern (`journey_paths`, `attribution_paths`), multi+gold-source (`customer_360`, `attribution_credit`), gold-on-gold (`marketing_attribution`, `campaign_attribution`).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
