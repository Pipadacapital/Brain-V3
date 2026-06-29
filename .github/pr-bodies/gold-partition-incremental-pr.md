# perf(spark): partition-incremental Gold aggregations (brand-level)

Extends the Spark scaling program (#300, #301) to the **Gold tier**. Gold marts are `GROUP BY brand/period` aggregates over Silver, so the right shape is **partition-incremental**: recompute only the brands whose source Silver changed, not the whole table every run.

## Key insight — it reuses the same driver
The partition is `brand_id` (every Gold mart is brand_id-first), and the Silver sources now carry `updated_at` from the incremental work in #300/#301. So **Gold partition-incremental = `run_entity_incremental` with `entity = brand_id`** — the identical driver, no new machinery. The conversion is a mechanical 3-edit pattern per mart:
1. imports (`col`, `lit`, `run_entity_incremental`)
2. fold body → `_fold_and_merge(spark, fqtn)` (drop the `spark.read.table(...)` — the driver registers the view)
3. `build()` → `run_entity_incremental(table_name, source_fqtn, event_filter=lit(True), entity_expr=col("brand_id"), fold_fn=..., view_name=<source view>, time_col="updated_at")`

It recomputes only brands whose source changed since the watermark (order_state stamps `updated_at` when it re-folds → chains the incrementality), each over the brand's FULL history, hash-bucketed by brand. Unaffected brands untouched; the **same UPDATE/INSERT MERGE** as the full job → parity.

## Landed (parity-proven)
| Mart | Source | Parity (full == reprocess-all incremental) |
|---|---|---|
| `gold_revenue_analytics` | `silver_order_state` | 28 rows / 3 brands / Σorder 2682 / **Σrealized 206,042,032** (3 per-brand buckets) |
| `gold_executive_metrics` | `silver_order_state` | 8 / 3 / Σorders 2681 / **Σrealized 206,042,032** (3 per-brand buckets) |

Both `EXIT 0`, no OOM. Notably the recompute brought Gold **current** with Silver (the marts had been stale at the old 202,407,914 — they now match the live `silver_order_state` Σ exactly).

## Safety (same contract)
Additive/opt-in (`build()`/aggregation SQL unchanged); `FULL_REFRESH=1` escape hatch; side-table watermark advanced only after all buckets. Single-brand still recomputes that brand fully each run (correct); the date-partition refinement (entity = brand+period) is a future optimization for the very-high-velocity single-brand case.

## Remaining (mechanical, same 3-edit pattern)
The other ~24 Gold marts: single-source ones (`gold_cac`, `gold_cohorts`, `gold_retention`, the IA marts, …) are identical conversions; multi-source ones (`gold_customer_360`, `gold_attribution_credit`) take the same pattern (filter the primary source; secondary joins read full — still brand-scoped + parity-correct, just less optimized). Each gets the same full==incremental parity test.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
