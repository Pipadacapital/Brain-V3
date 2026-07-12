# Runbook — Re-run / backfill the medallion (prod) — and the FULL_REFRESH rule

Audit trail: **AUD-OPS-020**. Re-running Silver/Gold is routine (a failed cron, a schema
change, a connector backfill just landed, a source re-point) — but it carries the one trap
that produces **silently-wrong marts**: the entity-incremental watermark. Read the
FULL_REFRESH section before any non-routine re-run.

Grounding: `infra/helm/cronworkflows/templates/spark-v4.yaml` (the `v4-silver`/`v4-gold`
CronWorkflows, ns `argo`), `db/iceberg/spark/iceberg_base.py` (watermark + `FULL_REFRESH`
env), `db/iceberg/spark/{silver,gold}/run-*.sh` (compose-local mirrors).

## 1. Routine re-run (failed/missed cron, post-backfill refresh)

Every Silver/Gold MERGE is idempotent — re-running is always safe. Submit one-off runs from
the CronWorkflows, **in order** (Gold reads Silver):

```bash
argo submit -n argo --from cronworkflow/v4-silver --wait
argo submit -n argo --from cronworkflow/v4-gold  --wait
```

Notes:
- `concurrencyPolicy: Forbid` serializes against the schedule (:05 Silver / :25 Gold) — a
  manual submit close to the top of the hour may just queue behind the scheduled run; that's
  fine.
- **There is NO separate mv-refresh leg**: the `brain_serving.mv_*` Trino views are thin
  projections — they resolve the new Iceberg snapshot the moment the Spark job commits.
  (Local dev is the same sequence via `tools/dev/v4-refresh-loop.sh`.)
- After a **connector backfill**, just re-run both: the backfill lands in Bronze
  (`<lane>_raw_connect` / `collector_events_connect`) with event timestamps that the
  incremental reads pick up normally. FULL_REFRESH is NOT needed for a backfill that lands
  *new Bronze rows now* — the watermark is on *arrival*, and MERGEs dedupe.

## 2. The FULL_REFRESH rule (entity-incremental watermark gotcha)

Entity-incremental jobs (order_state/revenue spine, touchpoint sessionization, and every job
built on `iceberg_base.py`'s watermark helper) keep a per-job high-water mark in the
`silver_job_watermark` side-table and only fold **entities with new events since
(watermark − overlap)**. Consequence:

> **Widening what a job READS does not fold historical rows already landed below the
> watermark.** The run succeeds, freshness looks green, and the mart is silently missing
> history — no error anywhere. Historic incident: `silver_order_state` read-widening left
> orders at **790 instead of 9,903** until a one-time `FULL_REFRESH=1` re-baseline.

`FULL_REFRESH=1` (env; accepted values `1|true|yes`) makes the job rescan ALL source rows.
MERGEs are idempotent, so a full refresh never double-counts — it only costs compute time.

**FULL_REFRESH=1 is MANDATORY (once, per affected job) when:**
1. A job's **source table is re-pointed** (e.g. the ADR-0010 Bronze cutover:
   `collector_events` → `collector_events_connect`).
2. A job's **reads are widened** — new source columns, relaxed filters, a new joined lane —
   anything that makes previously-skipped/absent rows now relevant.
3. **Quarantine replay / late Bronze rewrite** where rows were (re)written with OLD event
   timestamps below the job's watermark.
4. Rollback re-baselines (see `adr-0010-kafka-connect-bronze.md` — same rule, same reason).

It is NOT needed for routine re-runs, ordinary backfills, or code changes that don't change
what qualifies as input.

## 3. Running FULL_REFRESH in the prod cluster

The CronWorkflows do not parameterize `FULL_REFRESH` (deliberately — it must never become an
accidental default). Run the affected job as a one-off pod on the SAME pinned image + secret +
ServiceAccount the crons use (values from `infra/helm/cronworkflows/values-prod.yaml`:
image `sparkV4.image.repository@digest`, secret `core-env`, SA `brain-jobs`):

```yaml
# full-refresh-oneoff.yaml — edit JOB_FILE + the image digest, then:
#   kubectl apply -f full-refresh-oneoff.yaml && kubectl -n argo logs -f job/full-refresh-oneoff
apiVersion: batch/v1
kind: Job
metadata: { name: full-refresh-oneoff, namespace: argo }
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      serviceAccountName: brain-jobs
      containers:
        - name: run
          image: <ECR>/brain-spark-bronze-prod@<sparkV4.image.digest from values-prod.yaml>
          envFrom: [{ secretRef: { name: core-env } }]
          env: [{ name: FULL_REFRESH, value: "1" }]
          command: ["/bin/bash", "-c"]
          args:
            - /opt/spark/bin/spark-submit --master local[*] --driver-memory 3g
              --py-files /opt/brain/iceberg_base.py
              /opt/brain/silver/silver_order_state.py   # ← JOB_FILE: the ONE affected job
```

Run FULL_REFRESH **per affected job**, not fleet-wide (a full-Silver rescan is hours of
compute for no benefit). Then run a normal `v4-gold` (§1) so downstream marts fold the
re-baselined Silver. Locally the same thing is
`FULL_REFRESH=1 db/iceberg/spark/silver/run-silver-<job>.sh`.

## 4. Verify after any re-run

```bash
# Freshness — every mart's snapshot age (also the Prometheus brain_data_freshness_seconds gauge):
kubectl -n trino port-forward svc/<trino-coordinator> 8090:8080 &
trino --server http://127.0.0.1:8090 --execute \
  "SELECT committed_at FROM iceberg.brain_silver.\"silver_order_state\$snapshots\" ORDER BY committed_at DESC LIMIT 1"

# Completeness after a FULL_REFRESH (the failure this runbook exists for) — mart vs source count
# for one brand; a large gap means the watermark trap, not a transform bug:
trino --server http://127.0.0.1:8090 --execute \
  "SELECT count(*) FROM iceberg.brain_serving.mv_silver_order_state WHERE brand_id = '<BRAND_UUID>'"
```

Cross-check the count against the Data tab / source-of-truth surface for the same brand
(the 790-vs-9,903 signature). Dashboards read only `brain_serving.mv_*`, so once these
queries are right the product is right.
