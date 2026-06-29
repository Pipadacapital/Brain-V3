# perf(spark): incremental + adaptive batching + AQE — end the OOM class & scale the medallion

Ends the recurring Spark OOMs by making jobs process **bounded batches** instead of the full table every run, so memory becomes **O(new data)** not **O(all-time history)** — the system scales with data growth instead of fighting it. Production-safe: every change is additive/opt-in, parity-gated, with a `FULL_REFRESH=1` escape hatch on every converted job.

## Why (two distinct OOM types — they need different fixes)
| Symptom | Type | Cause | Fix in this PR |
|---|---|---|---|
| `OutOfMemoryError: Java heap space` | **JVM heap OOM** | the process's `-Xmx` is too small for the data | incremental (process the delta) + adaptive batching |
| container `exit 137`, `OOMKilled` | **container OOM-kill** | total Docker-VM pressure | AQE + bounded partitions + container caps |

`silver-collector-event` heap-OOMed after the 9,916-order Shopify backfill grew `collector_events` past the default 1 GB driver heap. Raising memory only defers it — incremental fixes it permanently.

## What landed (tiered, each independently safe)

**1. AQE everywhere — every Spark job (zero risk, universal).** One change in the shared `build_spark()`: `spark.sql.adaptive` (coalesce + skewJoin) + `maxPartitionBytes`. Correctness-neutral (only the runtime plan changes). Kills the write-buffer container-OOM fleet-wide.

**2. Watermark + adaptive batching — the 10 per-event-grain jobs.** `silver_collector_event` + 9 `_silver_base` consumers (`cart_event, dispute, engagement_signal, form_submission, page_view, payment, refund, search, settlement`). Opt-in via `run_job(..., target_table=)`; `build()` unchanged. Process only rows newer than the target watermark (with overlap; idempotent MERGE dedups), split into ~`SILVER_BATCH_TARGET_ROWS` adaptive batches.

**3. Entity-incremental — the aggregating/fold jobs (the hard case).** Time-window incremental is unsafe for jobs that fold many events per key, so those reprocess only the **entities with new events**, reading each entity's **full history**, adaptively **hash-bucketed** (each entity's events stay in one bucket — no giant driver collect). Both fold shapes proven:
- `silver_order_state` (revenue) — entity `order_id`, keyed terminal-wins + Σrecognition.
- `silver_touchpoint` (attribution) — entity visitor `brain_anon_id`, **sessionization** (parity-critical murmur `session_key`).
- NEW reusable `silver_job_watermark` side-table for fold jobs whose target carries no `ingested_at`.

**4. Lane 1 (Collector→Kafka→Spark→Bronze)** already had the equivalent natively (Structured Streaming: Kafka-offset incrementality + `maxOffsetsPerTrigger` bounded micro-batches). Now + AQE via `build_spark`.

**5. Defense-in-depth (memory as a floor, not the lever):** `--driver-memory` on all transform scripts; compose `mem_limit` caps on the unbounded services (Trino done earlier; sinks/minio/neo4j/kafka here); `docs/ops/local-memory-budget.md`.

## Production safety — the contract
- **Additive / opt-in** — unconverted jobs are byte-for-byte unchanged.
- **Idempotent & replay-safe** — overlap window + latest-ingested-wins (or monotonic `touch_seq`) MERGE → no event loss, no double-count.
- **`FULL_REFRESH=1`** escape hatch on every converted job (backfills / schema changes / recovery).
- **Grain-safety rule** encoded in `run_job`'s docstring + the budget doc (only per-event-grain jobs use time-window; fold jobs use entity-incremental). 6 over-eager conversions were caught by a grain audit and reverted.

## Parity-validated (the safety proof — incremental == full-refresh)
| Job | Fingerprint (full == incremental) |
|---|---|
| `silver_collector_event` | 28,627 rows (full history → 6 adaptive batches, 0 OOM on a 2 GB heap) |
| `silver_engagement_signal` | 1,742 |
| `silver_page_view` | 1,875 |
| `silver_order_state` | **Σorder_value = 206,042,032** (full == 17-bucket incremental) |
| `silver_touchpoint` | **Σsession_key = 698,585,523,267** (the murmur hash; full == 5-bucket incremental) |

## Scaling note (velocity)
Incremental fixes **scale-by-size** (memory stays flat as history grows). For **scale-by-velocity** (a $1M/day brand's huge per-run delta), the same code distributes across a **Spark cluster** (more executors) — no code change; tables are already `brand_id`-bucketed. Very-many-bucket runs in one local container under Docker-VM pressure can SIGKILL (137) — a deployment/cluster knob, not a logic issue (parity held).

## Rollout
Run the first production cycle with `FULL_REFRESH=1` (full rebuild), then incremental takes over.

## Follow-ups (pattern proven, now mechanical)
Remaining fold jobs adopt the same `_fold_and_merge` + watermark/bucket orchestration: `order_line` (like order_state), `journey`/`sessions` (like touchpoint), `campaign`/`ad_account`/`cod_rto`/`fulfillment`/`message_send`, and the Gold aggregations — each with the same parity test.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
