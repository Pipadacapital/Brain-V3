# Brain V4 — Load-test harness (k6)

Two [k6](https://k6.io) scripts that exercise the two hot paths of the platform and a set of
**operator post-run assertions** for the things k6 cannot see directly (Spark/Trino/Prometheus).

| Script | Targets | Path / port |
| --- | --- | --- |
| `ingest.js` | Collector accept-before-validate ingest | `POST /collect`, `/v1/events`, `/batch` on **:8787** |
| `serving.js` | BFF analytics reads (session-auth, Trino-over-Iceberg + Redis cache) | `/api/v1/analytics/*`, `/api/v1/dashboard/*` on **:3000** |

> These hit the **shared local dev stack**. Keep `VUS`/`DURATION` modest there. Run a real soak
> against a dedicated/isolated environment. Do **not** point high VUs at a stack others are using.

## Install k6

```sh
brew install k6            # macOS
# or: https://grafana.com/docs/k6/latest/set-up/install-k6/
k6 version
```

## Run — ingest

```sh
# defaults: COLLECTOR_URL=http://localhost:8787, 50 VUs, 5m sustained, 20% /batch
k6 run tools/load-test/ingest.js

# tuned soak
k6 run \
  -e COLLECTOR_URL=http://localhost:8787 \
  -e BRAND_ID=<brand-uuid> \
  -e INSTALL_TOKEN=<pixel-install-token> \
  -e VUS=100 -e DURATION=10m \
  -e BATCH_RATIO=0.3 -e BATCH_SIZE=40 \
  tools/load-test/ingest.js
```

### Ingest env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `COLLECTOR_URL` | `http://localhost:8787` | Collector base URL. |
| `BRAND_ID` | `00000000-…-0001` | Top-level `brand_id` (partitioning only; untrusted). |
| `INSTALL_TOKEN` | `00000000-…-0001` | `properties.install_token` — the server derives the real `brand_id` from this (R2). **Must resolve to a `pixel.pixel_installation` row** or the drainer quarantines the events and the Bronze count will be `< events_sent`. |
| `VUS` | `50` | Peak virtual users. |
| `DURATION` | `5m` | Sustained-phase duration (plus 1m ramp-up + 30s ramp-down). |
| `BATCH_RATIO` | `0.2` | Fraction of iterations that POST `/batch` instead of a single event. |
| `BATCH_SIZE` | `25` | Events per `/batch` (capped at `MAX_BATCH=50`). |

The envelope is a realistic `CollectorEventV1` (see
`packages/contracts/src/events/sample.collector.event.v1.ts`): `consent_flags.analytics:true` is
always sent so events are **not** quarantined at ingest routing (R3), and `install_token` rides in
`properties` so the brand resolves server-side.

## Run — serving

The analytics routes are session-protected and resolve the brand from the session, **never** from
the request. Authenticate by replaying a real `brain_session` cookie:

1. Log into the web app, open DevTools → Application → Cookies, copy the **`brain_session`** value.
2. Pass it as `AUTH_COOKIE`:

```sh
k6 run \
  -e BASE_URL=http://localhost:3000 \
  -e AUTH_COOKIE="brain_session=<paste-jwt-here>" \
  -e VUS=20 -e DURATION=3m \
  tools/load-test/serving.js
```

### Serving env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | Core/BFF base URL. |
| `AUTH_COOKIE` | _(empty)_ | The `brain_session=…` cookie. Empty ⇒ every request 401s (the script warns loudly). |
| `VUS` | `20` | Peak virtual users (steady phase). |
| `DURATION` | `3m` | Steady-phase duration. |

`serving.js` runs in two phases so the cache-hit vs cache-miss budgets are measured separately:

- **warmup** (first 2m, cold cache) — one pass per endpoint per VU → exercises the **cache-MISS**
  path (Trino scan). Threshold: `p95 < 3s`.
- **steady** (after warmup, hot cache) — sustained random reads → exercises the **cache-HIT** path
  (Redis serving cache). Threshold: `p95 < 500ms`.

## Pass/fail thresholds (enforced by k6 — non-zero exit on breach)

| Metric | Budget | Where |
| --- | --- | --- |
| API p95, cache HIT | `< 500ms` | `serving.js` `http_req_duration{phase:steady}` |
| API p95, cache MISS | `< 3s` | `serving.js` `http_req_duration{phase:warmup}` |
| HTTP error rate | `< 1%` | both scripts `http_req_failed` |
| Check pass rate | `> 99%` | both scripts `checks` |
| Ingest accept p95 (`/collect`) | `< 250ms` | `ingest.js` `http_req_duration{endpoint:collect}` |
| Ingest accept p95 (`/batch`) | `< 1.5s` | `ingest.js` `http_req_duration{endpoint:batch}` |

A breached threshold makes `k6 run` exit non-zero, so these scripts are CI/gate-friendly.

## Operator post-run assertions (k6 cannot read these — run them yourself)

k6 only sees HTTP. The asynchronous drainer → Kafka → Spark-SS → Iceberg Bronze pipeline and the
JVM heap of Spark/Trino are **out of band**. After each soak, run these.

### 1. Soak-count — Bronze count == events_sent (no event loss)

`ingest.js` prints `events_sent` (a 200-ACK == a durable spool commit, so this is the truth set) and
echoes the query below. **Record the UTC start time of the run.** Then in Trino:

```sql
-- Must equal the events_sent printed by k6 (allow only for events still in flight if you query
-- before the pipeline drains — re-query until stable).
SELECT count(*) AS bronze_count
FROM iceberg.brain_bronze.collector_events
WHERE brand_id = '<BRAND_ID>'
  AND ingested_at >= TIMESTAMP '<test-start-utc>';   -- e.g. 2026-06-30 12:00:00
```

If `bronze_count < events_sent`, inspect the quarantine/DLQ lanes
(`prod.collector.event.v1.quarantine`, `…dlq`) — the usual cause is an `install_token` that does
not resolve to a `pixel.pixel_installation` row (R2) or absent `consent_flags` (R3).

### 2. Streaming lag — Kafka-ts → Bronze land time < 30s

The Bronze table carries ingestion-metadata columns set by the Spark sink: `kafka_timestamp`
(broker record time) and `written_at` (wall-clock at the Iceberg MERGE). Their delta is the true
land latency:

```sql
SELECT
  max(date_diff('second', kafka_timestamp, written_at)) AS max_land_lag_s,
  approx_percentile(date_diff('second', kafka_timestamp, written_at), 0.95) AS p95_land_lag_s
FROM iceberg.brain_bronze.collector_events
WHERE brand_id = '<BRAND_ID>'
  AND written_at >= TIMESTAMP '<test-start-utc>';
-- PASS: p95_land_lag_s < 30  (and max within a small multiple — watch for a long tail under ramp).
```

Cross-check the consumer side in Prometheus (Kafka JMX exporter — see the SLO/dashboard wiring):

```promql
# Spark-SS sink consumer lag on the collector topic should drain toward 0 after ramp-down.
max(kafka_consumergroup_lag{topic="prod.collector.event.v1"})
```

### 3. Zero-OOM — no Spark or Trino OutOfMemory during the run

Trino is the **sole serving engine** and has been OOM-killed under refresh before (bounded heap fix:
`jvm.config` RAMPercentage 70 + `mem_limit 7g` + `restart:unless-stopped`). Confirm nothing
restarted or OOM'd during the soak:

```sh
# No container should show a restart bump or OOMKilled during the window.
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'trino|spark'
docker inspect trino  --format '{{.RestartCount}} {{.State.OOMKilled}}'
docker inspect <spark-sink-container> --format '{{.RestartCount}} {{.State.OOMKilled}}'

# Grep the logs for the smoking gun.
docker logs trino 2>&1 | grep -iE 'OutOfMemory|GC overhead|Query exceeded.*memory' || echo "trino: clean"
docker logs <spark-sink-container> 2>&1 | grep -iE 'OutOfMemoryError|java.lang.OutOfMemory' || echo "spark: clean"
```

Prometheus heap watch (if JVM metrics are scraped):

```promql
# Trino heap utilization should stay below ~85% of max throughout the run.
max(jvm_memory_used_bytes{area="heap",job="trino"}) / max(jvm_memory_max_bytes{area="heap",job="trino"})
```

**PASS** = `RestartCount` unchanged, `OOMKilled=false`, no OOM log lines, heap < ~85%.

## Output artifacts

Each script writes a machine-readable summary to the CWD:
`load-test-ingest-summary.json` / `load-test-serving-summary.json` (full k6 metrics for trend
tracking / CI archival).
