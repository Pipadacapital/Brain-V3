# Runbook — ADR-0010: Kafka Connect Bronze landing (parallel run → cutover → rollback)

The Kafka Connect Iceberg sink replaces the host Spark-SS Bronze landing (`bronze_landing.py`).
Writers NEVER share a table: Connect writes `brain_bronze.collector_events_connect` + the nine
`brain_bronze.<lane>_raw_connect`; Spark keeps `brain_bronze.events`. One flag pair drives the swap:

| Flag | `spark` posture (default) | `connect` posture (post-cutover) |
|---|---|---|
| `BRONZE_LANDING` | dev-bronze-streaming.sh runs the 7g Spark container | Spark sink NOT started (the saving) |
| `BRONZE_SOURCE`  | `events` (refresh loop default)                      | `connect` (auto-defaulted by the loop when `BRONZE_LANDING=connect`) |

## Phase 1 — parallel run (bake, both writers on)

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

## Phase 2 — cutover (one env)

```bash
pkill -f bronze_landing.py         # stop the Spark sink supervisor loop
export BRONZE_LANDING=connect      # add to your shell profile / .env used by dev-up
pnpm dev:up                        # step 5 now skips the Spark sink; refresh loop → BRONZE_SOURCE=connect
```
Then, ONCE, re-baseline Silver (source-table switch ⇒ watermark gotcha — rows below the old
watermark are silently skipped otherwise):
```bash
BRONZE_SOURCE=connect FULL_REFRESH=1 db/iceberg/spark/silver/run-silver-collector-event.sh
# (idempotent MERGEs make the rescan safe; repeat for any raw-normalize job you cut over)
```
App/BFF/stream-worker: set `BRONZE_SOURCE=connect` where the serving env is defined (core /
stream-worker env) so operational Bronze reads hit the lift view
`brain_bronze.collector_events_connect_lifted` (created by `run-trino-views.sh` — applies cleanly
only AFTER the Connect table exists, i.e. after the first commit).

Prod: enable `kafkaConnect.enabled=true` and set `sparkBronze.enabled=false` in
`infra/helm/cronworkflows/values.yaml` (+ the kafka-connect chart values) in the SAME release.

## Rollback (any time)

```bash
export BRONZE_LANDING=spark BRONZE_SOURCE=events
pnpm dev:up                        # Spark sink restarts on its preserved checkpoint
```
- Loss-free ONLY within the 7-day topic retention (`failOnDataLoss=false` skips aged-out offsets
  silently — do not let a broken state sit for a week before rolling back).
- If Silver ran against the connect tables in between, one `FULL_REFRESH=1` per flipped job
  re-baselines it back (MERGEs are idempotent — no double-count).
- Connect keeps writing its own tables harmlessly; `docker compose stop kafka-connect` to silence.

## Ops notes

- **Update a connector config**: edit `infra/kafka-connect/<name>.json`, then
  `python3 -c "import json;print(json.dumps(json.load(open('infra/kafka-connect/<name>.json'))['config']))" | curl -X PUT -H 'Content-Type: application/json' --data @- localhost:8083/connectors/<name>/config`
  (the compose one-shot `kafka-connect-init` only CREATEs — 409 means "exists, unchanged").
- **Restart a FAILED task**: `curl -X POST localhost:8083/connectors/<name>/tasks/0/restart`
- **Freshness**: commits every 30s (`iceberg.control.commit.interval-ms`). Raising it reduces
  small files; `bronze_maintenance.py` compaction absorbs the rest.
- **Alerts**: `BronzeConnectTaskFailed` (kafka_connect_connector_task_status{status="failed"}) and
  Connect consumer-group lag via kafka-exporter (`kafka_consumergroup_lag{consumergroup=~"connect-.*"}`).
- **Known failure modes**: (1) required-column NPE if a connector is ever pointed at a
  Spark-written table — Connect tables are always its own `*_connect` tables; (2) SQLite catalog
  lock contention (`database table is locked`) — CATALOG_CLIENTS=1 serializes, watch during bake;
  (3) `control-iceberg` topic must exist (kafka-init creates it; broker auto-create is OFF).
