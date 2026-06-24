# cronworkflows — scheduled Argo CronWorkflows

One Argo `CronWorkflow` per entry in `values.yaml → jobs`. Each runs a single
job-entrypoint CLI in the core (or stream-worker) image. Jobs are idempotent;
`concurrencyPolicy: Forbid` + `startingDeadlineSeconds` mean a missed or retried
run never double-applies and never piles up. Schedules are IST (`Asia/Kolkata`).

## Scheduled jobs

| Job | Schedule (IST) | Image | Purpose |
|---|---|---|---|
| recommendation-detectors | `0 6 * * *` daily 06:00 | core | Morning Brief detectors |
| revenue-finalization | `0 * * * *` hourly :00 | stream-worker | Attribution chain ① — horizon-based revenue realization |
| journey-stitch-from-identity | `15 * * * *` hourly :15 | stream-worker | Attribution chain ② — identity-graph stitch (GAP-1) |
| attribution-reconcile | `30 * * * *` hourly :30 | core | Attribution chain ③ — credit recognized orders (5 models incl. data_driven) + clawbacks |
| feature-materialization | `40 * * * *` hourly :40 | stream-worker | Gold features → Redis online store |
| meta-token-refresh | `0 3 * * *` daily 03:00 | stream-worker | Re-exchange Meta long-lived tokens |
| audit-checkpoint | `15 * * * *` hourly :15 | core | WORM-anchor audit hash-chain head to S3 |
| **partition-maintenance** | `30 2 * * *` daily 02:30 | stream-worker | **Create-ahead + drop-old RANGE partitions (C4)** |

### The attribution chain (① → ② → ③ → gold rebuild)

Ordered by **staggered schedule + idempotency**, not an Argo DAG (matching this chart's
one-container-per-CronWorkflow convention). The time gaps sequence the steps; each is idempotent so a
missed/retried run is safe (`concurrencyPolicy: Forbid` + `startingDeadlineSeconds`):

1. **revenue-finalization** (:00) — prepaid recognized after the return/cancel horizon → `finalization`
   rows (COD recognizes separately via `cod_delivery_confirmed`; never double-finalized).
2. **journey-stitch-from-identity** (:15) — `silver_touchpoint` anon → `identity_link(anon_id)`→brain_id
   ∩ `realized_revenue_ledger(order→brain_id)`, unambiguous-only → `connector_journey_stitch_map`.
3. **attribution-reconcile** (:30) — credit recognized orders (`finalization ∪ cod_delivery_confirmed`)
   to their journeys under all 4 per-journey models + the global data-driven (Markov) model; clawbacks.
4. **attribution-gold-refresh** (:45) — dbt rebuild of the credit ledger →
   `brain_gold.gold_marketing_attribution` (incl. the data_driven model), which the dashboard
   Attribution surface serves. Runs on the **dbt-runner image** (`db/dbt/Dockerfile`) — Node images
   can't run dbt. **Shipped `enabled: false`**: flip `jobs[attribution-gold-refresh].enabled: true`
   per env once CI publishes + pins `dbtRunnerImage.digest` (the template fail-closes on a missing
   digest, so a disabled job is simply skipped). Until enabled, the marts refresh on the nightly dbt
   build — one cycle behind the ledger. Mirrors `make attribution-gold-refresh`.

### The dbt-runner image (`db/dbt/Dockerfile`)

The runtime for scheduled dbt rebuilds (Node job images have no dbt/StarRocks-catalog runtime). Bundles
the dbt project + `dbt-starrocks` + the catalog-bootstrap SQL; parameterized via env (`DBT_SELECT`,
`DBT_VARS`, `DBT_FULL_REFRESH`, `DBT_THREADS`, `DBT_BOOTSTRAP_CATALOG`). Build:
`docker build -f db/dbt/Dockerfile -t brain-dbt-runner db`. Also serves Silver intraday rebuilds (set
`DBT_SELECT` accordingly) — closing the Silver-freshness follow-up in `brain-slo.rules.yml`.

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
(`infra/terraform/modules/redpanda → live_topic_partition_count`); the worker HPA
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
