# Spark tuning & audit — Brain medallion compute

This is the grounded answer to "audit + revamp Spark." It documents what Brain's Spark setup
**actually is** (not the cluster-centric assumptions a generic audit makes), the production tuning
now applied in the shared session factories, and the one place a cluster becomes relevant (10x scale).

## 1. What Brain's Spark actually is (reality, not assumptions)

- **Execution model: `--master local[*]` everywhere.** There is **no Spark cluster, no YARN, no
  Spark Operator, no "two clusters."** The driver JVM *is* the executor.
  - **Streaming (Bronze): not Spark anymore.** Bronze landing is the Kafka Connect Iceberg sink
    (compose `kafka-connect` service / `infra/helm/kafka-connect` chart — ADR-0010, cutover
    2026-07-05; the Spark-SS sinks `bronze_materialize.py`/`bronze_raw_landing.py`/`bronze_landing.py`
    are removed). Spark keeps only Bronze maintenance/retention/erasure.
  - **Batch (Silver/Gold):** **ephemeral, per-job** `spark-submit` containers — `run-silver-*.sh` /
    `run-gold-*.sh` locally (one `docker run` per mart), and single `spark-submit --master local[*]`
    pods in the Argo `CronWorkflow`s (`infra/helm/cronworkflows/templates/spark-v4.yaml`) in prod.
    Jobs run **sequentially**, so there is no inter-job resource contention to "consolidate."
- **Spark 3.5.3** (already the latest 3.5.x; JDK 17 → **G1GC is already the default collector**).
- **One shared config root:** `iceberg_base.build_spark()` (Silver/Gold) — AQE has been on
  fleet-wide since #300. (The retired Bronze sinks' own `build_spark()` went with them, ADR-0010.)
- **Storage:** Iceberg REST catalog (local: `iceberg-rest` + MinIO; prod: Glue + per-layer S3),
  `S3FileIO`, path-style.
- **Container memory is budgeted**, not ad-hoc — see `docs/ops/local-memory-budget.md`.

### Therefore, these generic-audit items are N/A here (do not add — they'd be dead config)
`spark.executor.*`, `spark.dynamicAllocation.*`, external shuffle service (`spark.shuffle.service.*`),
YARN queues / K8s namespaces for resource sharing, cluster sizing / node counts / auto-scaling.
In `local[*]` they are no-ops. They become relevant **only** at the 10x-scale step (§5).

## 2. OOM status — already addressed (the audit's central premise is stale)

The transform-tier OOM class was fixed in **#300** (AQE everywhere + watermark/adaptive batching +
entity-incremental folds + `silver_job_watermark`). Verified at audit time: **0 OOMs in 11h of
streaming, 0 container OOM-kills, 0 refresh-job failures.** Bronze streaming caps
`maxOffsetsPerTrigger=2000`; a daily compaction cron (`maintenanceSchedule 0 3 * * *`) controls small
files. So this work is **hardening + standardisation**, not firefighting.

## 3. Tuning now applied (shared, in-session, local-mode-correct)

Defined once in `iceberg_base.spark_perf_configs()` and applied by every Silver/Gold session. (The
retired Bronze sinks used to duplicate this dict; with the ADR-0010 cutover, Bronze landing is not a
Spark session at all — there is nothing to keep in sync anymore.) All env-overridable.

| Config | Default | Why |
|---|---|---|
| `spark.serializer` = KryoSerializer | on | faster + far less GC garbage than Java serialization |
| `spark.kryoserializer.buffer.max` | 256m | headroom for large broadcast/closures |
| `spark.sql.adaptive.advisoryPartitionSizeInBytes` | 64MB | right-size AQE-coalesced partitions (avoids tiny-task overhead **and** giant-partition write OOM) |
| `spark.sql.shuffle.partitions` | 64 | 200 is wasteful for local single-JVM data; AQE coalesces anyway |
| `spark.shuffle.compress` / `spill.compress` | true | cut spill I/O |
| `spark.shuffle.file.buffer` | 1m | fewer syscalls on the spill path |
| `spark.network.timeout` | 300s | a long GC pause / slow Iceberg commit no longer drops the local executor or Kafka consumer (the "consumer poll timeout" sink warnings) |
| `spark.executor.heartbeatInterval` | 30s | must stay < network.timeout |
| `spark.hadoop.fs.s3a.connection.maximum` | 64 | MinIO/S3 read throughput |
| `spark.hadoop.fs.s3a.fast.upload` | true | streaming uploads |
| `spark.memory.offHeap.{enabled,size}` | **env-gated (off)** | preserves the tuned local mem budget; **enable in prod** (`SPARK_OFFHEAP_SIZE=2g`) to move shuffle/Iceberg buffers off the GC heap |

Already present (kept): AQE enable + coalesce + skewJoin, `spark.sql.files.maxPartitionBytes=128MB`.

### Env knobs for prod scale-up (no code change)
`SPARK_SHUFFLE_PARTITIONS`, `SPARK_AQE_ADVISORY_BYTES`, `SPARK_OFFHEAP_SIZE`, `SPARK_KRYO_BUFFER_MAX`,
`SPARK_NETWORK_TIMEOUT`, `SPARK_S3A_CONN_MAX`, `SPARK_MAX_PARTITION_BYTES`, `SPARK_DRIVER_MEMORY`.

## 4. Job-code remediation checklist (audit the `.py` builders against these)
- No `collect()` / `show()` / `toPandas()` on unbounded data (pulls to the single driver heap).
- No `df.cache()` without a matching `unpersist()` (in local mode cache competes with execution memory).
- Prefer built-in SQL functions over Python UDFs (UDFs serialize per-row + bypass Tungsten).
- Window functions must `PARTITION BY` (Brain marts already key on `brand_id`-first).
- High-cardinality `groupBy` → pre-aggregate or `approx_count_distinct` where exactness isn't required.
- Writes partitioned `brand_id`-first (tenant invariant; also bounds partition size).
- Broadcast only genuinely small dims (`spark.sql.autoBroadcastJoinThreshold`); never broadcast a fact.

## 5. The one real architectural limit: scaling to 10x
`local[*]` is a single JVM — it cannot absorb 10x batch volume by config alone. The honest path when
volume demands it: **move batch (Silver/Gold) to Spark-on-Kubernetes** (real executors, dynamic
allocation, the cluster knobs that are N/A today), keeping the streaming sinks as-is. The job code is
already cluster-portable (`{CATALOG}.{namespace}.{table}`, no local assumptions). This is a project to
schedule against measured volume, **not** a config tweak — and not needed at current volumes.

## 6. Monitoring (gap → plan)
- **Have:** JMX exporter (Kafka/JMX → SLO dashboards), structured per-job logs (`spark_job` events with
  rows_in/out, merge_upserted, duration_ms).
- **Add:** Spark driver metrics → Prometheus (`spark.metrics.conf` PrometheusServlet) → Grafana panels
  for heap/off-heap, GC time/count, shuffle read/write, Kafka consumer lag; alerts on streaming lag,
  batch duration > SLA, and heap > 90%.
