# Effectively-once dedup guarantee (ADR-0010: append-only Bronze, dedup in Silver)

> **Contract:** at-least-once delivery + an APPEND-ONLY Bronze (the Kafka Connect Iceberg sink is the
> ONLY Bronze writer) + the Silver admission `MERGE ... ON (brand_id, event_id)` = **effectively-once
> Silver** for every downstream consumer. No event loss at Bronze, no double-count from Silver on.

## Why this matters

Brain's ingest path is **at-least-once**, by design and by physics:

- the collector and every connector **re-emit on retry** (treat integrations as unreliable);
- a crashed stream-worker **re-produces in-flight events** it hadn't yet acked;
- a Kafka consumer-offset **replay** re-reads offsets whose rows were already landed after an
  unclean restart.

In all three cases the broker holds **2+ copies** of the same business event. Something must collapse
them to one row before the recognition ledger, journey, and attribution — or they double-count.

## What does NOT provide the guarantee: Kafka producer idempotence

Kafka producer idempotence (`enable.idempotence`) dedups **retries within a single producer session**.
It is keyed by `(producer-id [PID], epoch, per-partition sequence number)` and guarantees the broker
writes a given `(PID, seq)` at most once even if the producer's internal retry fires.

It does **not** cover the at-least-once shapes above:

| Scenario | Producer idempotence? | Covered by |
| --- | --- | --- |
| Internal retry of one `send()` (same PID/seq) | ✅ deduped | Kafka |
| Two separate `send()` of the same event (distinct seq) | ❌ both written | **Silver MERGE** |
| Crash-replay re-produced by a **new** producer session (new PID/epoch → state reset) | ❌ both written | **Silver MERGE** |
| Connect-sink offset replay after a connector restart | ❌ same offset re-read | **Connect commit coordination** (offset-level — zero extra rows) |

## What Bronze provides under ADR-0010: append-only, offset-level exactly-once, zero loss

The Kafka Connect Iceberg sink (the compose `kafka-connect` service, ~30s commit interval) lands the
collector topic **verbatim** into `iceberg.brain_bronze.collector_events_connect` (payload + kafka
coordinates only; the lift view `collector_events_connect_lifted` exposes the envelope scalars).

- Bronze is **APPEND-ONLY** — there is NO Bronze-side business dedup anymore. Two `send()`s of the
  same `event_id` (two offsets) land as **two Bronze rows**, by design: Bronze is the raw broker
  history.
- The sink's commit coordination (the `control-iceberg` topic — offsets are committed with the
  Iceberg snapshot) makes a re-read of the exact same `(topic, partition, offset)` after a connector
  restart land **zero extra rows** and lose **zero events**: offset-level exactly-once.

## What DOES collapse business duplicates: the Silver MERGE on (brand_id, event_id)

The Silver admission gate (`db/iceberg/spark/silver/silver_collector_event.py`) reads the raw Bronze
lane and lands every event with a within-window
`row_number() ... PARTITION BY brand_id, event_id` followed by:

```sql
MERGE INTO brain_silver.silver_collector_event t
USING (<deduped window on (brand_id, event_id)>) s
ON  t.brand_id = s.brand_id AND t.event_id = s.event_id
```

- Every Bronze copy of a `(brand_id, event_id)` — retry, crash-replay, backfill overlap — collapses
  to **exactly one Silver row**. Silver is the dedup system-of-record; everything downstream
  (journey, revenue truth, attribution) reads through it.

Net: **at-least-once delivery into an append-only Bronze + an idempotent Silver MERGE =
effectively-once from Silver on.** `(brand_id, event_id)` is the idempotency key; `brand_id`-first
also preserves tenant isolation on the key itself.

## How it is verified

`apps/stream-worker/src/tests/bronze-dedup-effectively-once.live.test.ts` proves it end-to-end against
the live lakehouse: produce N events with known `event_id`s → wait for them to land → **re-produce the
same `event_id`s** (the crash-replay) → poll Trino
`iceberg.brain_bronze.collector_events_connect_lifted` and assert **both copies landed** (append-only
Bronze, >= 2 rows per `event_id`) → then assert `iceberg.brain_silver.silver_collector_event` holds
**exactly one row per `event_id`** (conditional on a Silver job pass — set `DEDUP_SILVER_ASSERT=1`
to block on it). It self-skips when the `lakehouse` docker profile is not up (the operator runs it
live; CI does not run live stack tests).
