# perf(spark): entity-incremental for ALL remaining Silver fold jobs (wave 2)

Completes the Spark scaling program from #300. That PR made the **per-event-grain** jobs incremental and proved **entity-incremental** on the two hardest folds (`order_state`, `touchpoint`). This wave rolls entity-incremental across **every remaining Silver fold/aggregate job**, so the whole Silver tier now processes only the entities that changed — memory stays O(new data) at any scale.

## What's an "entity-incremental" job
A job that folds many source events per key (an order's lifecycle, a visitor's journey, a campaign's spend). A time-window slice would regress its aggregate, so instead it: finds the **entities with new events** since a watermark → adaptively **hash-buckets** them (every event of an entity in one bucket) → re-folds each bucket reading those entities' **full history** → idempotent MERGE. Memory is bounded per bucket; correctness is complete per entity.

## Landed
**Reusable driver** — `iceberg_base.run_entity_incremental(table_name, source_fqtn, event_filter, entity_expr, fold_fn, view_name='bronze_events', time_col='ingested_at')`. Fold jobs convert in a few lines; `build()`/fold SQL unchanged.

**`_silver_base` entity-incremental mode** — `run_job(..., entity_incremental={table_name, event_types, entity_path})` for the consumer fold jobs: it hash-buckets entities and registers `_entity_bucket` so `read_bronze_events` restricts each batch to that bucket's entities (full history) — the job's transform + `merge_on_pk` run unchanged.

**Jobs converted (all parity-proven, full == reprocess-all-incremental):**
| Job | Entity | Parity fingerprint |
|---|---|---|
| `silver_order_line` | `order_id` | 18876 / Σline_total **3,614,840,494** (4 buckets) |
| `silver_journey` | visitor `brain_anon_id` | 478 (5 buckets) |
| `silver_cod_rto` | `order_id` | 400 |
| `silver_campaign` | `campaign_id` | 3 |
| `silver_ad_account` | `ad_account_id` | 0 (no-data, clean) |
| `silver_fulfillment` | `fulfillment_id` | 0 |
| `silver_message_send` | `message_id` | 0 |
| `silver_sessions` | visitor `brain_anon_id` (source `silver_touchpoint`) | 493 / Σtouch 3747 / Σdur 48368 (multi-bucket) |

All `EXIT 0`, no OOM.

## Production safety (unchanged contract)
Additive/opt-in (`build()` untouched); idempotent MERGE; `FULL_REFRESH=1` escape hatch on every job; side-table watermark advanced only after all buckets merge. Composite-key dimensions (`campaign`, `ad_account`) bucket by their id alone — safe (only ever co-locates a key's events, never splits them). `sessions` watermarks on `silver_touchpoint.updated_at`, which touchpoint stamps when it re-folds a visitor → the incrementality chains touchpoint → sessions.

## Coverage after this PR
- **Every Silver job**: per-event-grain → time-window incremental; fold/sessionization → entity-incremental. All parity-proven.
- **Remaining**: Gold aggregations (a different shape — recompute affected brand/period partitions; they already have AQE and aggregate to small outputs).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
