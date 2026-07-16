# cronworkflows — scheduled Argo CronWorkflows

One Argo `CronWorkflow` per entry in `values.yaml → jobs`. Each runs a single
job-entrypoint CLI in the core (or stream-worker) image. Jobs are idempotent;
`concurrencyPolicy: Forbid` + `startingDeadlineSeconds` mean a missed or retried
run never double-applies and never piles up. Schedules are IST (`Asia/Kolkata`).

## Scheduled jobs

| Job | Schedule (IST) | Image | Purpose |
|---|---|---|---|
| recommendation-detectors | `0 6 * * *` daily 06:00 | core | Morning Brief detectors |
| identity-export | `2 * * * *` hourly :02 | stream-worker | Attribution chain — materialize the Neo4j identity graph |
| journey-stitch-from-identity | `15 * * * *` hourly :15 | stream-worker | Attribution chain — identity-graph stitch (GAP-1) |
| attribution-reconcile | `30 * * * *` hourly :30 | core | Attribution chain — credit recognized orders (5 models incl. data_driven) + clawbacks |
| meta-token-refresh | `0 3 * * *` daily 03:00 | stream-worker | Re-exchange Meta long-lived tokens |
| shopify-token-refresh | `30 3 * * *` daily 03:30 | stream-worker | Re-exchange Shopify offline tokens |
| audit-checkpoint | `15 * * * *` hourly :15 | core | WORM-anchor audit hash-chain head to S3 |
| **partition-maintenance** | `30 2 * * *` daily 02:30 | stream-worker | **Create-ahead + drop-old RANGE partitions (C4)** |

### The attribution chain (Brain V4)

Ordered by **staggered schedule + idempotency**, not an Argo DAG (matching this chart's
one-container-per-CronWorkflow convention). The time gaps sequence the steps; each is idempotent so a
missed/retried run is safe (`concurrencyPolicy: Forbid` + `startingDeadlineSeconds`). Under Brain V4 the
recognition + attribution-gold rebuilds are **DuckDB** jobs (the `v4-silver`/`v4-gold` CronWorkflows
below), not dbt — dbt and StarRocks are removed:

1. **identity-export** (:02) — Neo4j identity graph → `silver_identity_link`, so the DuckDB Silver order
   spine resolves order `brain_id`. Runs BEFORE `v4-silver`.
2. **v4-silver** (:05, DuckDB) — Bronze → `silver_order_state` (recognition incl. prepaid finalization
   after horizon + COD delivery/RTO) + the rest of Silver.
3. **journey-stitch-from-identity** (:15) — `silver_touchpoint` anon → `identity_link(anon_id)`→brain_id
   ∩ the recognized order ledger, unambiguous-only → `connector_journey_stitch_map`.
4. **v4-gold** (:25, DuckDB) — `gold_revenue_ledger` → `gold_attribution_credit` →
   `gold_marketing_attribution` (incl. the data_driven model) + customer/gap/executive marts, served by
   the `brain_serving.mv_*` duckdb-serving views over Iceberg.
5. **attribution-reconcile** (:30) — credit recognized orders (`finalization ∪ cod_delivery_confirmed`)
   to their journeys under all 4 per-journey models + the global data-driven (Markov) model; clawbacks.

## Brain V4 DuckDB Silver/Gold (`templates/v4-transform.yaml`)

**Spark→DuckDB cutover** (`feat/spark-to-duckdb-cutover`): the transform tier is DuckDB-on-Iceberg now
(Spark is removed; dbt/StarRocks were already gone). The Iceberg medallion
(`brain_bronze`/`brain_silver`/`brain_gold`) is built by the DuckDB jobs and is the system of record; the
`brain_serving.mv_*` duckdb-serving views are thin projections straight over the Iceberg Gold/Silver marts. These
CronWorkflows invoke `python /opt/brain/duckdb/<layer>/<job>.py` — the mart jobs the `brain-duckdb` image
**carries** (`db/iceberg/duckdb/{silver,gold}/*.py`, COPYed into `/opt/brain/duckdb` by the Dockerfile).
Each job self-imports its `_base`/`_catalog` via `sys.path.insert` (no `--py-files`). One python pod per
cron, no JVM.

| Job | Schedule (IST) | Image | Purpose |
|---|---|---|---|
| v4-silver | `5 * * * *` hourly :05 | brain-duckdb | keystone `silver_collector_event` + `silver_order_state` (brain_id spine) + the rest of Silver (×2 convergence passes) |
| v4-gold | `25 * * * *` hourly :25 | brain-duckdb | `gold_revenue_ledger` → attribution → customer/gap/executive marts |

There is **no `v4-mv-refresh` leg**: once a DuckDB job commits the new Iceberg snapshot, the serving `mv_*`
views resolve it directly. The dev mirror that runs the same keystone→Silver→Gold sequence is
`tools/dev/duckdb-refresh.sh` (`pnpm dev:v4-refresh`).

**Dependency order** is enforced by staggered schedule + idempotency (not an Argo DAG), and interleaves
with the node `.Values.jobs`: `identity-export` (:02) → **v4-silver** (:05) → `journey-stitch-from-identity`
+ `journey-stitch-export` (:15/:16) → **v4-gold** (:25). That is the full V4 attribution chain — identity
→ order-state → silver → stitch → gold — so the customer + attribution marts populate instead of
computing 0. The v4-silver cron runs the keystone first, then the order_state spine, then the rest of
Silver twice (a pass-1 sibling miss converges on pass 2), mirroring `duckdb-refresh.sh`.

**ENABLED** (`sparkV4.enabled: true`, value block kept for chart compatibility): the V4 crons run the
medallion refresh. They need the CI-built, digest-pinned `brain-duckdb` image (the template fail-closes on
a missing digest, B3) and a cluster. Each job is an idempotent Iceberg MERGE, wrapped in the Argo
`backoffLimit` — a transient blip is safe to re-run. Placement: the **streaming** Karpenter pool
(values-prod; the dedicated Spark `batch` pool was removed — DuckDB crons are lightweight python).

## Bronze/medallion maintenance (`templates/bronze-maintenance.yaml`, `templates/v4-maintenance.yaml`)

Iceberg maintenance (snapshot expiry / COW compaction; orphan-file sweep is a loud SKIP until
PyIceberg ships it, ADR-0014) runs via the **PyIceberg + DuckDB maintenance tier** the `brain-duckdb`
image carries (`db/iceberg/duckdb/maintenance/**`):
`python /opt/brain/duckdb/maintenance/bronze_maintenance.py` (daily 03:00, `bronze-maintenance`),
`bronze_raw_retention.py` (daily 03:40, `bronze-raw-retention`, the D4 raw-PII window), and
`medallion_maintenance.py` (weekly Sun 04:45, `v4-maintenance`, Silver/Gold sweep).

## Bronze raw-PII erasure (`templates/bronze-erasure.yaml`, AUD-OPS-037)

**Not a cron** — a `WorkflowTemplate` (`bronze-raw-erasure`) wrapping
`db/iceberg/duckdb/maintenance/erasure_raw_delete.py` (PyIceberg COW deletes + a DuckDB payload-path
sweep), the RTBF subject hard-delete across the raw Bronze
Iceberg tables (`*_raw_connect` column-equality DELETEs + the payload-path sweep of
`collector_events_connect`). The stream-worker **erasure orchestrator** (STEP 4 of the ordered
crypto-shred sequence, `EraseSubjectUseCase`) submits a Workflow from it per erasure signal:
prod runs the argo-workflows app controller-only (no REST server), so the submit is a
Kubernetes-API Workflow create (`workflowTemplateRef`) authorized by the
`bronze-raw-erasure-submitter` Role/RoleBinding this chart renders (create+get on `workflows`
in ns `argo`, bound to the stream-worker ServiceAccount — configure via
`sparkBronze.erasure.submitter`).

Parameters mirror the job's env contract: `brand-id` (UUID, tenant-isolation key — always
the first DELETE predicate), `identifier-hash` (64-hex per-brand-salted SHA-256),
`anon-ids`/`device-ids` (comma-separated RAW payload ids). `brand-id`/`identifier-hash` have no
defaults — an incomplete submit is rejected (fail-closed). Idempotent: a replayed erasure
deletes 0 rows. Erasure is **physically complete after the `bronze-maintenance` snapshot-expiry
pass** ages out the pre-delete snapshots (D4 posture). Completed Workflow CRs are TTL'd
(`sparkBronze.erasure.ttlSecondsAfterCompletion`, 7d default).

Manual submit (ops / verification):

```bash
argo submit -n argo --from workflowtemplate/bronze-raw-erasure \
  -p brand-id=<uuid> -p identifier-hash=<64-hex> [-p anon-ids=a1,a2] [-p device-ids=d1]
```

## C4 — partition maintenance (CRITICAL)

The RANGE-partitioned tables (migration 0080) need a partition created ahead of
each new month. The catalog routine `public.maintain_time_partitions(ahead, retention)`
does this; `partition-maintenance` runs it daily.

- **Schedule:** `30 2 * * *` (02:30 IST) — runs BEFORE any month rolls over even
  with a few days of controller downtime near a boundary.
- **`PARTITION_AHEAD_MONTHS=3`** — pre-creates the current + next 3 months on every
  partitioned table, so writes NEVER land in the `*_pdefault` catch-all. Without this
  job scheduled, from **Oct 2026** all partitioned writes would fall into `*_pdefault`.
- **`PARTITION_RETENTION_MONTHS=36`** — drops partitions older than 36 months. The
  routine NEVER drops a DEFAULT partition.
- The routine is `SECURITY DEFINER` (owned by superuser `brain`, `EXECUTE` granted to
  `brain_app`), so the job connects as `brain_app` like every other worker path — no
  elevated DDL grant on the role.

### Alert — non-empty `*_pdefault`

Any rows in a `*_pdefault` partition mean partition creation has fallen behind
(controller down too long, or the job failing). This is a data-routing regression:
those rows live in the catch-all instead of their month partition.

**Detection (PromQL / scheduled SQL check):** alert when the row count of any
`*_pdefault` partition is `> 0`. A lightweight check:

```sql
-- For each partitioned table, count rows in its DEFAULT partition.
-- Non-zero on any => PAGE: partition-maintenance is lagging.
SELECT c.relname AS pdefault_partition,
       pg_catalog.obj_description(c.oid) AS note
FROM   pg_partitioned_table p
JOIN   pg_inherits i      ON i.inhparent = p.partrelid
JOIN   pg_class c         ON c.oid = i.inhrelid
WHERE  pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT';
-- then SELECT count(*) per matched *_pdefault and alert if > 0.
```

Wire this as a Grafana/Prometheus alert (severity: page) once the metrics exporter
emits a per-partition row gauge. Until then, the daily run logs
`created=N dropped=M`; a `created=0` near a month boundary is a soft signal.

## H5 — live-topic partitions & worker autoscaling

The live collector topic partition count is the hard ceiling on stream-worker
consumer parallelism. Prod is now **96 partitions**
(`infra/helm/strimzi-kafka → live_topic_partition_count`); the worker HPA
`maxReplicas` is decoupled from the old hard 12 (prod `maxReplicas: 48`, still
`<= 96`). A *real* repartition that wants per-brand ordering must FIRST change the
producer key from the brand-prefixed composite to `brand_id` alone — owned by the
analytics/identity stream, NOT this chart.

## ingest-scheduler — NOT a CronWorkflow

`apps/stream-worker/src/jobs/ingest-scheduler/run.ts` is a CONTINUOUS interval loop
wired into the long-running stream-worker deployment (`main.ts`), not a cron. It is
already running wherever stream-worker runs; it needs no CronWorkflow entry. Its
per-tick claim work-queue parallelises across the worker replicas governed by the
HPA above.
