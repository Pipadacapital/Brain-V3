# Brain data-freshness SLA exporter

A standalone, **dependency-free** Prometheus exporter (Python stdlib only) that measures how
stale each Gold serving mart is and exposes `brain_data_freshness_seconds` on `/metrics`.

It is the serving-side complement to `infra/observe/alerts/brain-slo.rules.yml` (which covers
Bronze-spine ingest freshness). Iceberg is the system of record, so "freshness" is the age of
each mart's **latest successful Iceberg snapshot** (`max(timestamp_ms)` from the DuckDB
`iceberg_snapshots()` metadata function), read through duckdb-serving — the sole serving
engine (ADR-0014) — via the same `iceberg` catalog attach the app uses.

## Metrics

| metric | type | labels | meaning |
| --- | --- | --- | --- |
| `brain_data_freshness_seconds` | gauge | `mart,schema,sla_class` | age (s) since the latest successful Gold snapshot |
| `brain_data_freshness_last_snapshot_timestamp_seconds` | gauge | `mart,schema,sla_class` | unix time of that snapshot |
| `brain_data_freshness_query_success` | gauge | `mart,schema,sla_class` | 1 if a snapshot was read, 0 if the mart is unreachable/empty |
| `medallion_freshness_seconds` | gauge | — | end-to-end freshness: `now − max(ingested_at)` over the Silver spine serving view — the whole Bronze→Silver→serving latency (ADR-0016 NRT SLO) |
| `medallion_freshness_query_success` | gauge | — | 1 if the end-to-end query returned a value, 0 if serving unreachable / spine empty |
| `brain_data_freshness_scrape_duration_seconds` | gauge | — | wall time of the last background scrape |
| `brain_data_freshness_last_scrape_timestamp_seconds` | gauge | — | unix time of the last scrape |
| `brain_data_freshness_scrape_total` | counter | — | completed scrapes |
| `brain_data_freshness_up` | gauge | — | 1 if duckdb-serving was reachable last scrape |

`sla_class` is `executive` (15m SLA) or `segment` (1h SLA). The thresholds live in the alert
rules, not here — see `infra/observe/alerts/freshness.rules.yml`. Adding a mart is a one-line
registry change (no rule edit): see `DEFAULT_MARTS` in `freshness_exporter.py` or supply your
own `FRESHNESS_MARTS_FILE` JSON.

## Anti-fantasy

If a mart's snapshot query fails or returns NULL (table missing / never written), the exporter
does **not** emit a fabricated freshness number — it emits `brain_data_freshness_query_success 0`,
and `BrainMartSnapshotMissing` alerts on that. This is the same C2 "no alert that silently never
fires" doctrine documented in `brain-slo.rules.yml`.

## Run (no Dockerfile required)

It is a single stdlib script — run it with stock Python 3.11+ (no `pip install`):

```sh
# Local dev against the docker-compose stack (duckdb-serving host port is 8091):
FRESHNESS_SERVING_URL=http://localhost:8091 \
  python3 tools/observability/freshness-exporter/freshness_exporter.py
# → serves http://localhost:9095/metrics

# One-shot (print exposition and exit — handy for CI / a CronJob+Pushgateway):
FRESHNESS_SERVING_URL=http://localhost:8091 \
  python3 tools/observability/freshness-exporter/freshness_exporter.py --once
```

In-cluster / inside the compose network the default `FRESHNESS_SERVING_URL=http://duckdb-serving:8091`
is correct. To run on the stock image without baking a Dockerfile:

```sh
docker run --rm --network brain_default -p 9095:9095 \
  -e FRESHNESS_SERVING_URL=http://duckdb-serving:8091 \
  -v "$PWD/tools/observability/freshness-exporter:/app:ro" \
  python:3.13-slim python3 /app/freshness_exporter.py
```

### Config (env)

| var | default | meaning |
| --- | --- | --- |
| `FRESHNESS_SERVING_URL` | `http://duckdb-serving:8091` | duckdb-serving base URL (POST /v1/query) |
| `FRESHNESS_ICEBERG_CATALOG` | `iceberg` | attached Iceberg catalog name |
| `FRESHNESS_GOLD_SCHEMA` | `brain_gold` | Iceberg Gold schema |
| `FRESHNESS_LISTEN_ADDR` / `FRESHNESS_LISTEN_PORT` | `0.0.0.0` / `9095` | `/metrics` bind |
| `FRESHNESS_REFRESH_SEC` | `60` | background refresh interval |
| `FRESHNESS_QUERY_TIMEOUT_SEC` | `20` | per-HTTP-request timeout |
| `FRESHNESS_MARTS_FILE` | (built-in) | path to a JSON mart-registry override |

## Wire into Prometheus

The rule file is auto-loaded (`prometheus.yml` already globs `alerts/*.rules.yml`). Add a scrape
job so the metric is actually collected — local dev:

```yaml
  - job_name: 'brain-freshness-exporter'
    static_configs:
      - targets: ['host.docker.internal:9095']
```

In Kubernetes, apply `infra/observe/k8s/freshness-exporter.yaml` (Deployment + Service with
`prometheus.io/scrape` annotations — same annotation-based discovery as the Kafka exporters).

## Verify

```sh
python3 -m py_compile tools/observability/freshness-exporter/freshness_exporter.py
promtool check rules infra/observe/alerts/freshness.rules.yml   # if promtool is installed
```
