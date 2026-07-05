# Runbook — ADR-0010: Kafka Connect Bronze landing (cutover EXECUTED 2026-07-05)

The Kafka Connect Iceberg sink IS the sole Bronze landing writer. The host Spark-SS landing
(`bronze_landing.py` / `tools/dev/dev-bronze-streaming.sh`) and the `BRONZE_LANDING` /
`BRONZE_SOURCE` switches were REMOVED at the 2026-07-05 decommission (see the ADR's
"Decommission executed" section) — there is no env-flip posture anymore. Connect writes
`brain_bronze.collector_events_connect` + the nine `brain_bronze.<lane>_raw_connect`; the
legacy Spark-written tables (`brain_bronze.events`, `collector_events`, `*_raw`) were DROPPED
on 2026-07-05 (unify-bronze-decommission Step 3 executed).

## Phase 1 — parallel run (bake, both writers on) — HISTORICAL

> Executed and closed at cutover; retained for the record. The Spark comparison target no longer
> runs (its code is deleted), so a parallel run cannot recur without the rollback below.

Nothing to do: the `kafka-connect` compose service is in the `core` profile, so `pnpm dev:up`
brings it up alongside the Spark sink. Both consume the same topics into different tables.

Watch (≥ a few days of real traffic):
```bash
curl -s localhost:8083/connectors | jq .                       # 10 connectors
curl -s localhost:8083/connectors/iceberg-bronze-collector/status | jq '.tasks[].state'
docker logs brainv3-kafka-connect-1 2>&1 | grep "Commit complete"
```

Parity — per lane, Connect table vs Spark table over the SAME window (Trino, :8090):
```sql
SELECT count(*) FROM iceberg.brain_bronze.collector_events_connect;             -- Connect
SELECT count(*) FROM iceberg.brain_bronze.events WHERE connector = 'collector'; -- Spark
-- rows only in one writer (should be Ø once both started before the window):
SELECT json_extract_scalar(payload,'$.event_id') FROM iceberg.brain_bronze.collector_events_connect
EXCEPT
SELECT event_id FROM iceberg.brain_bronze.events WHERE connector = 'collector';
```
NOTE: Connect started later than Spark ⇒ it only has rows still inside the 7-day topic retention.
Parity windows must start at the Connect deploy time.

Exactly-once probe: `docker restart brainv3-kafka-connect-1` mid-traffic, wait 2 commit intervals,
re-run the count — no duplicates (offsets live in the Iceberg snapshot metadata) and no gaps.

## Phase 2 — cutover (EXECUTED 2026-07-05)

Done — there is nothing to flip and no env to set. The `BRONZE_LANDING` / `BRONZE_SOURCE`
switches no longer exist; the `kafka-connect` compose service (core profile) locally and the
`infra/helm/kafka-connect` chart in prod are the only landing path, and `pnpm dev:up` brings
the service up with the infra step. What the cutover did, for the record:

- Silver was re-baselined ONCE (`FULL_REFRESH=1 db/iceberg/spark/silver/run-silver-collector-event.sh`
  — a source-table switch is a watermark gotcha: rows below the old watermark are silently
  skipped otherwise). Idempotent MERGEs made the rescan safe.
- Operational Bronze reads (core / stream-worker) go through the Trino lift view
  `brain_bronze.collector_events_connect_lifted` (created by `run-trino-views.sh` — it applies
  cleanly only AFTER the Connect table exists, i.e. after the first commit).
- Prod posture: `kafkaConnect.enabled=true`; `sparkBronze` is maintenance-only
  (`bronze_maintenance.py` / raw-retention / erasure crons — no landing job).

## Rollback (git revert — NOT an env flip)

The Spark landing code is deleted from the tree, so rolling back means restoring it from git
history:

1. `git revert` the ADR-0010 removal commits (restores `bronze_landing.py`,
   `tools/dev/dev-bronze-streaming.sh`, the run scripts, and the `BRONZE_LANDING`/`BRONZE_SOURCE`
   seams) and redeploy.
2. Restart the Spark sink and let it replay the Kafka topics. Loss-free ONLY within the **7-day
   topic retention window** (`failOnDataLoss=false` skips aged-out offsets silently — do not let
   a broken state sit for a week before deciding).
3. Re-baseline Silver once per re-pointed job: `FULL_REFRESH=1` on
   `run-silver-collector-event.sh` (+ any raw-normalize job) — MERGEs are idempotent, no
   double-count.
4. Connect keeps writing its own `*_connect` tables harmlessly in the meantime;
   `docker compose stop kafka-connect` to silence it.

## Ops notes

- **Update a connector config**: edit `infra/kafka-connect/<name>.json`, then
  `python3 -c "import json;print(json.dumps(json.load(open('infra/kafka-connect/<name>.json'))['config']))" | curl -X PUT -H 'Content-Type: application/json' --data @- localhost:8083/connectors/<name>/config`
  (the compose one-shot `kafka-connect-init` only CREATEs — 409 means "exists, unchanged").
- **Restart a FAILED task**: `curl -X POST localhost:8083/connectors/<name>/tasks/0/restart`
- **Freshness**: commits every 30s (`iceberg.control.commit.interval-ms`). Raising it reduces
  small files; `bronze_maintenance.py` compaction absorbs the rest.
- **Alerts**: `BronzeConnectTaskFailed` (kafka_connect_connector_task_status{status="failed"}) and
  Connect consumer-group lag via kafka-exporter (`kafka_consumergroup_lag{consumergroup=~"connect-.*"}`).
- **Lane tables are lazy**: a lane's `brain_bronze.<lane>_raw_connect` table is auto-created by
  the sink on that lane's FIRST record — until then the table does not exist, and the Silver
  raw-normalize jobs skip it cleanly (expected, not a failure).
- **RTBF / erasure posture**: per-subject erasure is `erasure_raw_delete.py` — column-equality
  DELETEs on the `*_raw_connect` lanes (`RAW_TABLE_IDENTIFIER_COLS`), and PAYLOAD-PATH PREDICATE
  DELETEs on `collector_events_connect` (`PAYLOAD_PATH_TABLES`): the table is payload-only (no
  lifted identifier columns), so the subject predicates are `get_json_object(payload, …)` reads
  on the envelope's identifier paths (`$.properties.brain_anon_id` / `$.properties.device_id` /
  the pre-hashed `hashed_customer_email|phone` fields), tenant-scoped on the envelope's
  `$.brand_id`. Iceberg DELETE is a copy-on-write/positional delete — rows leave current table
  state immediately, but the pre-delete snapshots still hold them until
  `bronze_maintenance.py` `expire_snapshots` ages them out: **erasure is physically complete
  after snapshot expiry** (same posture as the D4 raw window). The 7-day row TTL
  (`bronze_raw_retention.py`) covers only the `*_raw_connect` lanes — `collector_events_connect`
  is the system-of-record stream and is never row-TTL'd. Guard:
  `python3 db/iceberg/spark/erasure_payload_path_guard_test.py`.
- **Known failure modes**: (1) required-column NPE if a connector is ever pointed at a
  Spark-written table — Connect tables are always its own `*_connect` tables; (2) SQLite catalog
  lock contention (`database table is locked`) — CATALOG_CLIENTS=1 serializes, watch during bake;
  (3) `control-iceberg` topic must exist (kafka-init creates it; broker auto-create is OFF).
