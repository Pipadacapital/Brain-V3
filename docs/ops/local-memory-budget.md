# Local memory budget — the OOM-prevention contract

Recurring OOMs (Trino killed, Spark `silver-collector-event` killed) had **two distinct
root causes**. This doc is the single source of truth for both so we stop playing whack-a-mole.

## The two OOM types (they need different fixes)

| Symptom | Type | Cause | Fix |
|---|---|---|---|
| `OutOfMemoryError: Java heap space` (process keeps running / job aborts) | **JVM heap OOM** | the process's own `-Xmx` is too small for the data | raise that process's heap (`--driver-memory`, Trino `MaxRAMPercentage`, etc.) |
| container `exit 137`, `OOMKilled=true` | **container OOM-kill** | total Docker-VM memory pressure → kernel kills the biggest container | bound every container + give the VM headroom |

Raising the Docker VM does **nothing** for a JVM heap OOM. Raising a process's `-Xmx`
does **nothing** for VM pressure. You must keep both levers tuned.

## Lever 1 — Docker VM size (fixes container OOM-kill headroom)

The Mac has **48 GB** physical; the Docker VM must be **≥ 32 GB** (Docker Desktop →
Settings → Resources → Memory). At the old 23.4 GB the steady stack (~20 GB) + one
transform job (~5 GB) = ~25 GB overflowed the VM and the kernel OOM-killed Trino.

## Lever 2 — per-container caps (defense-in-depth; stop any one runaway)

Hard `mem_limit`s in `docker-compose.yml`, set **above** real steady usage (they cap
runaway, they don't throttle normal operation):

| Service | `mem_limit` | Internal heap |
|---|---|---|
| trino | 7g | jvm.config `MaxRAMPercentage=70` → ~4.9g |
| spark-bronze-sink | 7g | `--driver-memory 4g` |
| spark-bronze-raw-sink | 6g | `--driver-memory 4g` |
| minio | 5g | `GOMEMLIMIT=4500MiB` (soft GC ceiling) |
| redpanda (Kafka KRaft) | 2.5g | default |
| neo4j | 1.5g | heap 512m + pagecache 256m |
| apicurio | 768m | `JAVA_OPTS_APPEND -Xmx512m` (67% of limit) |
| pgbouncer | 128m | — (small C daemon) |
| redis | 256m | `maxmemory 192mb` + `volatile-lru` (evict, don't OOM-kill) |
| postgres / litellm / localstack / iceberg-rest | unbounded (small, ~3g combined) | — |

## Lever 3 — transient Spark transform jobs (fixes JVM heap OOM)

The Silver/Gold jobs run as ephemeral `docker run … spark-submit --master local[2]`.
They previously used Spark's **default 1 GB** driver heap → the 9,916-order Shopify
backfill grew `collector_events` past 1 GB → `silver-collector-event` heap-OOMed.

All 35 transform run scripts now pass `--driver-memory "${SPARK_DRIVER_MEMORY:-4g}"`
(driver == executor under `local[*]`, so this is the whole heap). Tune for a one-off
heavy run with `SPARK_DRIVER_MEMORY=6g pnpm dev:v4-refresh`.

## Peak-load math (32 GB VM)

Steady (no refresh): trino 5g + sinks ~7g + minio 4.4g + kafka 1.1g + neo4j 1g +
misc 2g ≈ **20.5 GB**. During a refresh one transform job adds ~5 GB → **~25.5 GB**,
leaving ~6.5 GB headroom on a 32 GB VM. The sinks' 4g heaps were sized for cold-start
backlog drain; if you ever need to claw back room, drop them to 2g in steady state.

## Incremental processing — the grain-safety rule (correctness, not just memory)

Watermark + adaptive batching (`run_job(..., target_table=)`) is applied **only to per-event-grain
jobs** — where the MERGE pk includes `event_id`, so each output row derives from a single source event.
For those it's provably correct (parity-tested: `silver_collector_event` 28,627, `silver_engagement_signal`
1,742, `silver_page_view` 1,875 — incremental == full-refresh).

It is **deliberately NOT applied** to jobs that aggregate/fold across multiple events per key:
- **entity-grain folds** — `silver_order_state` / `silver_order_line` (min/max/latest over an order's
  events), `silver_journey` (folds a visitor's touchpoints), `silver_campaign` / `silver_ad_account`
  (entity dimensions).
- **sessionization** — `silver_touchpoint` / `silver_sessions` (30-min-gap sessions can span a batch).

A time-window slice would regress those aggregates. They stay **full-refresh + AQE** (Tier 1 — safe,
and AQE + bounded partitions already prevents the write-buffer OOM). The correct scaling pattern for them
is **entity-incremental**: find the entities (orders / anons) with new events since the watermark, then
reprocess each entity's FULL history. That's a separate, careful enhancement — tracked, not rushed.

**Coverage today:** Tier 1 (AQE + bounded partitions) = every Spark job. Tier 2 (watermark + adaptive)
= the 10 per-event-grain Silver jobs. Lane 1 (Kafka→Bronze) = native streaming incrementality.

## If an OOM recurs

1. `docker inspect <ctr> --format '{{.State.OOMKilled}} {{.State.ExitCode}}'` →
   `true`/137 = container OOM-kill (Lever 1/2); a `Java heap space` in the job log
   with no 137 = JVM heap OOM (Lever 3).
2. Container-kill → check `docker stats` for the VM total vs sum of usage; raise the
   VM or the offending cap.
3. Heap OOM → raise that process's heap (`SPARK_DRIVER_MEMORY`, the sink
   `--driver-memory`, or trino `db/trino/jvm.config`).
