# Local memory budget — the OOM-prevention contract

Recurring OOMs (the then-serving Trino killed, Spark `silver-collector-event` killed — both
engines since removed, but the failure classes outlive them) had **two distinct root causes**.
This doc is the single source of truth for both so we stop playing whack-a-mole.

## The two OOM types (they need different fixes)

| Symptom | Type | Cause | Fix |
|---|---|---|---|
| `OutOfMemoryError: Java heap space` / DuckDB "Out of Memory" error (process keeps running / job aborts) | **in-process memory ceiling** | the process's own heap/`memory_limit` is too small for the data | raise that process's ceiling (`KAFKA_HEAP_OPTS`, `DUCKDB_SERVING_MEMORY_LIMIT`, etc.) |
| container `exit 137`, `OOMKilled=true` | **container OOM-kill** | total Docker-VM memory pressure → kernel kills the biggest container | bound every container + give the VM headroom |

Raising the Docker VM does **nothing** for a JVM heap OOM. Raising a process's `-Xmx`
does **nothing** for VM pressure. You must keep both levers tuned.

## Lever 1 — Docker VM size (fixes container OOM-kill headroom)

The Mac has **48 GB** physical; the Docker VM must be **≥ 32 GB** (Docker Desktop →
Settings → Resources → Memory). At the old 23.4 GB the steady stack (~20 GB) + one
transform job (~5 GB) = ~25 GB overflowed the VM and the kernel OOM-killed the
(then-)serving engine.

## Lever 2 — per-container caps (defense-in-depth; stop any one runaway)

Hard caps set **above** real steady usage (they cap runaway, they don't throttle
normal operation). Compose services use `mem_limit`; the transient transform jobs
are `docker run --memory` (they are host-launched, not compose services). **Every
running container is bounded** — nothing is left unbounded anymore.

| Service | Cap | Internal heap |
|---|---|---|
| duckdb-serving (replaced trino 7g — ADR-0014, no JVM) | 4g | `DUCKDB_SERVING_MEMORY_LIMIT=3GB` DuckDB in-process cap + spill `temp_directory`; `oom_score_adj: -700` — serving-critical, a pathological query 504s instead of OOMing |
| kafka-connect (compose service — the sole Bronze landing writer, ADR-0010; the old 7g host Spark sink `bronze_landing.py` / `dev-bronze-streaming.sh` is REMOVED, cutover 2026-07-05) | 2g (`mem_limit`) | `KAFKA_HEAP_OPTS -Xms256M -Xmx1G`; `oom_score_adj: -600` — ingest-critical, protected (AUD-LOCAL-003) |
| Spark transform jobs (ephemeral `docker run` via `db/iceberg/spark/run-*.sh`) | 7g (`SPARK_CONTAINER_MEMORY`) | `--driver-memory 4g`; `--oom-score-adj +100` (`SPARK_CONTAINER_OOM_SCORE_ADJ`) — retried by the loop, deliberately die FIRST (AUD-LOCAL-003) |
| minio | 5g | `GOMEMLIMIT=4500MiB` (soft GC ceiling) |
| kafka (KRaft) | 2.5g | `KAFKA_HEAP_OPTS -Xmx1G -Xms1G` (pinned; == image default — pairs 1G heap with the 2.5g limit) |
| neo4j | 1.5g | heap 512m + pagecache 256m |
| apicurio | 768m | `JAVA_OPTS_APPEND -Xmx512m` (67% of limit) |
| postgres | 512m | — |
| localstack | 512m | — |
| iceberg-rest | 512m | — |
| redis | 256m | `maxmemory 192mb` + `volatile-lru` (evict, don't OOM-kill) |
| prometheus | 256m | — (re-enabled 2026-07-02, AUD-LOCAL-001; loads `infra/observe/alerts/*.rules.yml`) |
| grafana | 256m | — (re-enabled 2026-07-02, AUD-LOCAL-001; dashboards at :3004) |
| alertmanager | 256m | — (added 2026-07-02, AUD-LOCAL-001; local no-op receiver, UI at :9093) |
| pgbouncer | 128m | — (small C daemon) |
| loki / tempo (`full-obs` profile) | 512m each | — (AUD-LOCAL-004) |
| otel-collector (`full-obs`) | 256m | — (AUD-LOCAL-004) |
| kafka-exporter (`debug`) | 128m | — (AUD-LOCAL-004) |
| one-shot inits (minio-init / iceberg-catalog-init / jmx-exporter-init) | 128m | — (AUD-LOCAL-004) |
| kafka-init | 512m | each `kafka-topics.sh` call is a JVM (256M default CLI heap) — 128m would OOM-kill the init and fail `up --wait` |

Not running (commented out in compose, re-enable by uncommenting): **litellm**
(`ai` profile — AI/NLQ features not active yet).

## Lever 3 — transient Spark transform jobs (fixes JVM heap OOM)

The Silver/Gold jobs run as ephemeral `docker run … spark-submit --master local[2]`.
They previously used Spark's **default 1 GB** driver heap → the 9,916-order Shopify
backfill grew `collector_events` past 1 GB → `silver-collector-event` heap-OOMed.

All 35 transform run scripts now pass `--driver-memory "${SPARK_DRIVER_MEMORY:-4g}"`
(driver == executor under `local[*]`, so this is the whole heap) inside a
`--memory "${SPARK_CONTAINER_MEMORY:-7g}"` container cap (PR #342). Tune for a
one-off heavy run with `SPARK_DRIVER_MEMORY=6g pnpm dev:v4-refresh`.

The Bronze landing writer (kafka-connect, ADR-0010) has no Spark checkpoint at all:
its consumed offsets are stored IN the Iceberg snapshot metadata (commit
coordination), so any restart/OOM resumes from the committed offsets — the old
OOM→restart→re-drain amplification loop cannot occur.

## Peak-load math (32 GB VM)

Steady (no refresh), realistic usage: duckdb-serving ~2g + kafka-connect ~1.2g +
minio ~4.4g + kafka ~1.1g + neo4j ~1g + small services ~1.5g ≈ **~11 GB**. During a
refresh the loop runs its transforms strictly sequentially, so ONE transform job adds
~5 GB → **~16 GB**, leaving ~16 GB headroom on a 32 GB VM. Sum of all hard caps
(compose ~17.7g incl. kafka-connect 2g + one transform 7g ≈ 24.7g) intentionally
exceeds realistic usage — caps exist to kill a single runaway before it creates
VM-wide pressure, not to add up to the VM size. (Net swing of the ADR-0010 cutover:
−7g host Spark sink, +2g kafka-connect; of the ADR-0014 cutover: trino 7g →
duckdb-serving 4g.)

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
3. In-process ceiling → raise that process's cap (`SPARK_DRIVER_MEMORY`, the kafka-connect
   `KAFKA_HEAP_OPTS`, or the serving `DUCKDB_SERVING_MEMORY_LIMIT` in docker-compose.yml).
