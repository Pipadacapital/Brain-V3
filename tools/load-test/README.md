# Brain V4 — Load-test harness (k6)

Two [k6](https://k6.io) scripts that exercise the two hot paths of the platform and a set of
**operator post-run assertions** for the things k6 cannot see directly (Connect/duckdb-serving/Prometheus).

| Script | Targets | Path / port |
| --- | --- | --- |
| `ingest.js` | Collector accept-before-validate ingest | `POST /collect`, `/v1/events`, `/batch` on **:8787** |
| `serving.js` | BFF analytics reads (session-auth, duckdb-serving-over-Iceberg + Redis cache) | `/api/v1/analytics/*`, `/api/v1/dashboard/*` on **:3000** |

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
  path (duckdb-serving scan). Threshold: `p95 < 3s`.
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

k6 only sees HTTP. The asynchronous drainer → Kafka → Kafka Connect Iceberg sink → Bronze pipeline
(ADR-0010: the Connect sink is the SOLE Bronze writer; Bronze is **append-only**, no dedup — the
effectively-once dedup lives in Silver, see `DEDUP-GUARANTEE.md`) and the memory posture of
Connect (JVM heap) / duckdb-serving (`DUCKDB_SERVING_MEMORY_LIMIT`) are **out of band**. After each
soak, run these.

### 1. Soak-count — Bronze count >= events_sent (no event loss)

`ingest.js` prints `events_sent` (a 200-ACK == a durable spool commit, so this is the truth set) and
echoes the query below. **Record the UTC start time of the run.** Then over duckdb-serving
(`POST :8091/v1/query`, or the duckdb CLI attached to the catalog):

```sql
-- ADR-0010: Bronze is APPEND-ONLY under the Connect sink, so re-deliveries land as EXTRA rows —
-- bronze_count >= events_sent means no loss (allow for events still in flight if you query before
-- the sink's ~30s commit drains — re-query until stable). A count ABOVE events_sent is duplicates
-- from at-least-once delivery — fine at Bronze; Silver collapses them.
SELECT count(*) AS bronze_count
FROM iceberg.brain_bronze.collector_events_connect_lifted
WHERE brand_id = '<BRAND_ID>'
  AND ingested_at >= TIMESTAMP '<test-start-utc>';   -- e.g. 2026-06-30 12:00:00
```

If `bronze_count < events_sent`, inspect the Connect sink (`docker logs kafka-connect`, connector
status via the Connect REST API) — under ADR-0010 the R2 install-token / R3 consent gate runs at
SILVER admission (`silver_collector_event.py` → `silver_quarantine`), not in front of Bronze, so a
missing Bronze row is a sink/broker problem, never a gate rejection. The business-level
no-double-count assertion is on Silver (after a refresh pass — `ONESHOT=1 pnpm dev:v4-refresh`):

```sql
-- Effectively-once per business event: one Silver row per (brand_id, event_id).
SELECT count(*) AS dupes
FROM (SELECT event_id FROM iceberg.brain_silver.silver_collector_event
      WHERE brand_id = '<BRAND_ID>' GROUP BY event_id HAVING count(*) > 1);
-- PASS: dupes = 0.
```

### 2. Streaming lag — Kafka-ts → Bronze land time bounded by the commit interval

The raw Connect table (`collector_events_connect`) carries `kafka_timestamp` (broker record time),
but the Connect sink writes no per-row wall-clock (`written_at` was a Spark-sink column — gone).
Land latency under the Connect sink is bounded by its **~30s Iceberg commit interval**; verify the
commit cadence held under load via the Iceberg snapshots metadata table:

```sql
SELECT committed_at,
       date_diff('second',
                 lag(committed_at) OVER (ORDER BY committed_at),
                 committed_at) AS commit_gap_s
FROM iceberg.brain_bronze."collector_events_connect$snapshots"
ORDER BY committed_at DESC
LIMIT 20;
-- PASS: steady commit_gap_s ≈ 30 through the run window — a growing gap means the sink is falling
-- behind; effective land latency (kafka_timestamp → next commit) should stay ≤ ~60s.
```

Cross-check the consumer side in Prometheus (Kafka JMX exporter — see the SLO/dashboard wiring):

```promql
# Connect sink consumer lag on the collector topic should drain toward 0 after ramp-down.
max(kafka_consumergroup_lag{topic="prod.collector.event.v1"})
```

### 3. Zero-OOM — no Kafka Connect or duckdb-serving OutOfMemory during the run

duckdb-serving is the **sole serving engine**; its memory posture is bounded by design
(`DUCKDB_SERVING_MEMORY_LIMIT=3GB` under a `mem_limit: 4g` container + spill `temp_directory` +
`restart: unless-stopped` — a pathological query degrades to a clean 504, never an OOM-killed
container). The Connect sink is the sole Bronze writer. Confirm neither restarted or OOM'd during
the soak:

```sh
# No container should show a restart bump or OOMKilled during the window.
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'duckdb-serving|kafka-connect'
docker inspect duckdb-serving --format '{{.RestartCount}} {{.State.OOMKilled}}'
docker inspect kafka-connect  --format '{{.RestartCount}} {{.State.OOMKilled}}'

# Grep the logs for the smoking gun.
docker logs duckdb-serving 2>&1 | grep -iE 'OutOfMemory|memory limit|killed' || echo "duckdb-serving: clean"
docker logs kafka-connect 2>&1 | grep -iE 'OutOfMemoryError|java.lang.OutOfMemory' || echo "kafka-connect: clean"
```

Prometheus memory watch (if the serving `/metrics` is scraped):

```promql
# duckdb-serving resident memory should stay below ~85% of the 4g container bound.
max(process_resident_memory_bytes{job="duckdb-serving"}) / (4 * 1024 * 1024 * 1024)
```

**PASS** = `RestartCount` unchanged, `OOMKilled=false`, no OOM log lines, resident memory < ~85%.

## Output artifacts

Each script writes a machine-readable summary to the CWD:
`load-test-ingest-summary.json` / `load-test-serving-summary.json` (full k6 metrics for trend
tracking / CI archival).
