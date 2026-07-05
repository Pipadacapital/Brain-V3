# Spark-on-Kubernetes migration plan — batch compute for 10x

**Status: PLAN (not scheduled).** Do this when measured volume approaches the `local[*]` ceiling
(§1), not before. The point is to lift Brain's **batch** tier (Silver/Gold) off single-JVM local mode
onto real Spark executors so it absorbs ~10x event volume. Streaming (Bronze) is a lighter, separate
decision (§7). Companion to `docs/ops/spark-tuning.md` (the local-mode baseline this builds on).

## 0. Where we are today (the thing we're migrating)

- **Batch (Silver/Gold):** Argo `CronWorkflow`s (`infra/helm/cronworkflows/templates/spark-v4.yaml`)
  run **one pod per cron** with `spark-submit --master local[*]` — driver == executor, `driverMemory 3g`,
  pod limits `cpu 2 / mem 4Gi`. Schedules: bronze materialize `*/15m`, silver `:05`, gold `:25`.
- **Image:** `brain-spark-bronze` (`db/iceberg/spark/Dockerfile`, `apache/spark:3.5.3`) — **already**
  bundles `iceberg-spark-runtime-3.5`, `iceberg-aws-bundle`, `spark-sql-kafka-0-10`, `postgresql` JDBC.
  It is **already a valid Spark-on-K8s image** — no rebuild needed for the executor side.
- **Catalog/storage:** prod = Glue catalog + per-layer S3 buckets, `S3FileIO`. **Unchanged by this migration.**
- **Job code** uses `{CATALOG}.{namespace}.{table}` with **zero local assumptions** → cluster-portable as-is.
- **Config seam already in place:** `iceberg_base.spark_perf_configs()` (#312) reads the cluster knobs
  from env (`SPARK_OFFHEAP_SIZE`, `SPARK_SHUFFLE_PARTITIONS`, …) that are **no-ops in local mode today
  and become live on K8s** — so most of this migration is *configuration*, not code.

## 1. Trigger — when to actually do this (not premature)
Migrate when any holds for 2+ weeks: a v4 batch cron's pod sustains **>80% of its mem limit** or OOM-kills;
the **silver or gold cron runtime exceeds its window** (silver approaching the :25 gold start, or gold
> ~15 min, breaking the "Gold within 15 min of Bronze" SLO); or projected volume (orders/spend/pixel)
is **>~5x** today. Until then, local mode + the #312 tuning + the env knobs are cheaper and simpler.

## 2. Scope & non-goals
- **In scope:** Silver + Gold batch jobs → Spark-on-K8s **cluster mode** (1 driver + N executors per job).
- **Out of scope (this phase):** Bronze streaming sinks (§7 — separate, lower priority); the Iceberg
  catalog/storage (already prod-correct); any job business logic (unchanged — parity-gated, §6).

## 3. Architecture decision — submit path

| Option | What | Verdict |
|---|---|---|
| **A. `spark-submit --master k8s://` from the existing Argo crons** | Change the cron's `submit()` from `--master local[*]` to `--master k8s://$KUBERNETES_SERVICE_HOST` + `spark.kubernetes.*`; Spark itself launches executor pods, driver runs in the cron pod (client) or a launched pod (cluster). | **RECOMMENDED.** Minimal new infra — Argo already orchestrates ordering/retries/secrets; no operator to run/upgrade. One-line `--master` flip is also the rollback. |
| B. Spark Operator (`SparkApplication` CRD) | Declarative CRDs, a controller reconciles. | More moving parts (a controller to run, RBAC, upgrades). Defer unless we want GitOps-declared Spark jobs platform-wide. |

Go with **A**: keep Argo as the scheduler/orchestrator; let `spark-submit` drive K8s. The image, catalog,
secrets wiring, and job entrypoints all stay; only the submit flags + a ServiceAccount/RBAC change.

## 4. What changes (concrete, minimal)

**4.1 The cron `submit()` (spark-v4.yaml)** — per job, swap local for k8s + add executor sizing:
```
spark-submit --master k8s://https://kubernetes.default.svc \
  --deploy-mode cluster \
  --conf spark.kubernetes.container.image=$SPARK_IMAGE \           # the existing brain-spark-bronze digest
  --conf spark.kubernetes.namespace=brain-spark \
  --conf spark.kubernetes.authenticate.driver.serviceAccountName=spark \
  --conf spark.kubernetes.driver.request.cores=1 \
  --conf spark.driver.memory=$SPARK_DRIVER_MEMORY \                # 4–8g
  --conf spark.executor.instances=$SPARK_EXEC_INSTANCES \          # start 4, dynamic below
  --conf spark.executor.cores=4 --conf spark.executor.memory=$SPARK_EXEC_MEMORY \   # 5–8g
  --conf spark.dynamicAllocation.enabled=true \
  --conf spark.dynamicAllocation.shuffleTracking.enabled=true \    # NO external shuffle service needed on K8s 3.x
  --conf spark.dynamicAllocation.minExecutors=2 \
  --conf spark.dynamicAllocation.maxExecutors=$SPARK_MAX_EXECUTORS \
  --py-files /opt/brain/iceberg_base.py /opt/brain/<silver|gold>/<job>.py
```
**4.2 `iceberg_base.spark_perf_configs()` — NO code change.** The env knobs already wire it: set in the
cron env `SPARK_SHUFFLE_PARTITIONS` (e.g. 256–512 for cluster shuffles vs 64 local), `SPARK_OFFHEAP_SIZE`
(e.g. 2g — now meaningful with real executors), `SPARK_AQE_ADVISORY_BYTES` (128MB). The `spark.executor.*`
/ `dynamicAllocation.*` knobs that were dead config in local mode are now the live ones (set via submit).

**4.3 K8s primitives (new):** namespace `brain-spark`, a `spark` ServiceAccount + Role/RoleBinding
(create/watch/delete pods + configmaps for executor pods), an image-pull secret for ECR. Helm-templated
alongside the existing `infra/helm/cronworkflows`.

**4.4 Streaming checkpoints:** when Bronze later moves (§7), set `CHECKPOINT_LOCATION` to a durable
`s3a://` path (the code already documents this; hadoop-aws is in the image) for exactly-once resume.

## 5. Resource & cost model
- **Sizing:** start executors at `cores=4, memory=6g` (≈1.5g/core heap + overhead), `instances=4`,
  dynamic `min 2 / max 12`. Driver `4–8g`. Tune from the Spark UI / metrics after first runs.
- **Cost:** executors on **spot/preemptible** node pool (batch is restart-safe — Iceberg MERGE is
  idempotent, jobs are retried by Argo); driver on on-demand. Dynamic allocation + per-cron lifecycle
  means **scale-to-zero between crons** (no idle cluster). This is typically *cheaper* than an always-on
  cluster and only runs when a cron fires.

## 6. Migration phases (blue-green, parity-gated, one-flip rollback)
1. **Stand up** namespace + RBAC + a non-scheduled "v4-gold-k8s" CronWorkflow (manual trigger) pointing at
   the SAME image/catalog, writing to a **shadow namespace** (e.g. `brain_gold_k8s`) — no prod impact.
2. **Parity:** run the K8s job and diff its marts against the live local-mode marts using the existing
   **parity oracle** (`db/iceberg/spark/parity/`) — byte/sum parity on money columns, row counts, PKs.
3. **Cut over Gold first** (heaviest, most SLO-pressured): point the real `v4-gold` cron at `--master k8s`.
   Keep local-mode silver. Watch one full day of SLO + cost.
4. **Cut over Silver**, then the **bronze-maintenance** cron (Bronze landing is Kafka Connect,
   not Spark — §7).
5. **Rollback at any step = flip `--master k8s://` back to `local[*]`** in the cron (the image/code/catalog
   are identical) — instant, no data migration (Iceberg is the shared SoR).

## 7. Streaming (Bronze) — no longer Spark's problem
Bronze landing moved OFF Spark entirely: the Kafka Connect Iceberg sink (compose `kafka-connect`
service / `infra/helm/kafka-connect` chart) is the sole landing writer (ADR-0010, cutover
2026-07-05 — the Spark-SS sinks `bronze_materialize.py`/`bronze_raw_landing.py` are removed).
Scaling it is Kafka partition count + Connect tasks, decoupled from this batch migration. Spark
keeps only the scheduled Bronze maintenance/retention/erasure jobs, which migrate with the batch
tier.

## 8. Observability (do this WITH the migration)
- Enable Spark's PrometheusServlet (`spark.ui.prometheus.enabled=true` + `spark.metrics.conf`) → scrape
  driver/executor → Grafana: heap/off-heap, GC time/count, shuffle read/write, executor count, task
  failures, Kafka consumer lag (Bronze). Alert on: executor OOM, dynamic-alloc maxed for >N min,
  cron runtime > SLO, heap > 90%. (JMX exporter already covers Kafka; this adds Spark internals.)

## 9. Risks
- **S3 throttling under parallel executors** → 503s. Mitigate: `fs.s3a.connection.maximum` (already
  raised in #312), Iceberg write `target-file-size` + `distribution-mode=hash`, and S3 request-rate
  spread (Iceberg's hashed object layout already helps).
- **Shuffle on K8s without external shuffle service** → use `dynamicAllocation.shuffleTracking.enabled`
  (3.x) so executors aren't reclaimed while their shuffle blocks are needed.
- **Cost runaway** from `maxExecutors` too high → cap it; alert on sustained max.
- **Parity drift** → the oracle gate in phase 2 is mandatory before any cutover.

## 10. Effort
~1–2 weeks: ½ wk K8s namespace/RBAC/Helm + submit-flag templating; ½ wk parity harness run + tuning;
the rest cutover + observability + a soak. No application code changes — config + infra only.
