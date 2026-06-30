# Bronze effectively-once dedup guarantee

> **Contract:** at-least-once delivery + a `MERGE INTO ... ON (brand_id, event_id) WHEN NOT MATCHED`
> sink = **effectively-once Bronze** for every downstream consumer. No event loss, no double-count.

## Why this matters

Brain's ingest path is **at-least-once**, by design and by physics:

- the collector and every connector **re-emit on retry** (treat integrations as unreliable);
- a crashed stream-worker **re-produces in-flight events** it hadn't yet acked;
- a Kafka consumer-offset **replay** (the Spark checkpoint resume path) **re-reads** an offset whose
  rows were already landed after an unclean kill.

In all three cases the broker holds **2+ copies** of the same business event. Something must collapse
them to one Bronze row, or the recognition ledger, journey, and attribution double-count.

## What does NOT provide the guarantee: Kafka producer idempotence

Kafka producer idempotence (`enable.idempotence`) dedups **retries within a single producer session**.
It is keyed by `(producer-id [PID], epoch, per-partition sequence number)` and guarantees the broker
writes a given `(PID, seq)` at most once even if the producer's internal retry fires.

It does **not** cover the at-least-once shapes above:

| Scenario | Producer idempotence? | Covered by |
| --- | --- | --- |
| Internal retry of one `send()` (same PID/seq) | ✅ deduped | Kafka |
| Two separate `send()` of the same event (distinct seq) | ❌ both written | **Bronze MERGE** |
| Crash-replay re-produced by a **new** producer session (new PID/epoch → state reset) | ❌ both written | **Bronze MERGE** |
| Spark consumer-offset replay after unclean kill | ❌ same offset re-read | **Bronze MERGE** |

## What DOES provide the guarantee: the Bronze MERGE on (brand_id, event_id)

The Spark Structured-Streaming sink (`db/iceberg/spark/bronze_materialize.py`) lands every event with:

```sql
MERGE INTO brain_bronze.collector_events t
USING (<dedup-within-batch on (brand_id, event_id)>) s
ON  t.brand_id = s.brand_id AND t.event_id = s.event_id
WHEN NOT MATCHED THEN INSERT (...)
```

- `WHEN NOT MATCHED` means a re-delivered `(brand_id, event_id)` that already exists is a **no-op** —
  never a second row. Bronze stays raw / append-only / immutable.
- A within-micro-batch `row_number() ... PARTITION BY brand_id, event_id` collapses the case where a
  single batch contains the same key twice (e.g. a re-pull emitting a dupe).
- The Kafka offset is committed to the checkpoint **only after** the durable Iceberg snapshot commit
  (the `commits/<batchId>` ordering proof in `build_writer()`), so a process death after the MERGE but
  before the offset-commit simply **re-reads and re-MERGEs** the same offsets — a no-op replay, with
  **zero event loss**.

Net: **at-least-once delivery into an idempotent MERGE sink = effectively-once Bronze.** `(brand_id,
event_id)` is the idempotency key; `brand_id`-first also preserves tenant isolation on the key itself.

## How it is verified

`apps/stream-worker/src/tests/bronze-dedup-effectively-once.live.test.ts` proves it end-to-end against
the live lakehouse: produce N events with known `event_id`s → wait for them to land → **re-produce the
same `event_id`s** (the crash-replay) → poll Trino `iceberg.brain_bronze.collector_events` and assert
**exactly one row per `event_id`**. It self-skips when the `lakehouse` docker profile is not up (the
operator runs it live; CI does not run live stack tests).
