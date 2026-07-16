# duckdb-serving

The Trino-replacement serving tier (ADR-0014, plan §A): a stateless Python HTTP service —
FastAPI + **one DuckDB per replica**, attached **read-only** to the Iceberg REST catalog as
`iceberg` — that serves the app/BFF/metric-engine's `brain_serving.mv_*` reads in a single
round-trip (`POST /v1/query`, no `/v1/statement` polling).

## How a replica works

1. **Epoch build** (`engine.py`): `_catalog.connect(read_only=True)` (the SAME seam the
   transform tier uses; `READ_ONLY` on the ATTACH so the catalog itself rejects writes) →
   resource pragmas (`memory_limit` / `threads` / spill `temp_directory` + cap) →
   `views.py` applies every `../views/*.sql` into **local** `brain_serving` / `brain_bronze`
   schemas. Unqualified `brain_serving.mv_x` resolves to the LOCAL view while its body's
   `iceberg.brain_gold.*` refs reach the catalog (local-views-shadow-catalog, spike gate d).
2. **Requests** run on `con.cursor()` — cursors share the parent's attach + local views and
   are concurrency-safe (spike gate a) — behind the `DUCKDB_SERVING_MAX_CONCURRENT`
   admission semaphore, with a `threading.Timer → cursor.interrupt()` watchdog at
   `STATEMENT_TIMEOUT_MS` (25s, under the TS adapter's 30s abort). Only **SELECT/WITH**,
   single statement; anything else is a 400.
3. **Epoch rotation** every `DUCKDB_SERVING_CATALOG_REFRESH_S` (default **900s**) is
   **self-heal only** — a live attach already sees new Iceberg commits on plain re-query
   (spike gate b). Rotation re-applies views skipped because a Gold mart didn't exist yet
   (continue-on-error parity with the old `run-trino-views.sh`) and recovers a poisoned
   attach; the old epoch drains in-flight cursors before closing.

Freshness = Iceberg snapshot freshness; brand isolation (`${BRAND_PREDICATE}`) and param
substitution happen upstream in the TS adapter; money stays BIGINT minor units — sums above
2^53 serialize as **strings** so paise never round through a JSON double (`serialize.py`).

## Endpoints

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/query` `{"sql": "SELECT …"}` | `200 {"columns":[{name,type}], "data":[[…]]}` · `400` guard · `503` not-ready/saturated · `504` timeout · `500` engine (`{"error":{"message"}}`) |
| `GET /healthz` | process liveness — 200 even while the catalog attach self-heals |
| `GET /readyz` | 200 + `{views_applied, views_skipped}` once an epoch is live; 503 before. Empty views dir ⇒ still ready (0 applied) |
| `GET /metrics` | Prometheus text (`duckdb_serving_*` counters/gauges) |

## Env

| Key | Default | Meaning |
| --- | --- | --- |
| `DUCKDB_SERVING_MEMORY_LIMIT` | `3GB` | per-replica DuckDB `memory_limit` (compose pod is 4g) |
| `DUCKDB_SERVING_THREADS` | `4` | DuckDB threads |
| `DUCKDB_SERVING_TEMP_DIRECTORY` | `/tmp/duckdb-serving-spill` | spill dir |
| `DUCKDB_SERVING_MAX_TEMP_DIRECTORY_SIZE` | `5GB` | spill cap |
| `DUCKDB_SERVING_MAX_CONCURRENT` | `8` | admission semaphore width |
| `STATEMENT_TIMEOUT_MS` | `25000` | interrupt watchdog (< TS 30s abort) |
| `DUCKDB_SERVING_CATALOG_REFRESH_S` | `900` | epoch rotation (self-heal cadence) |
| `ICEBERG_CATALOG` | `rest` | attach name — serving sets **`iceberg`** so view bodies' 3-part refs resolve |
| + the `_catalog.py` family | | `ICEBERG_REST_URI`, `ICEBERG_WAREHOUSE`, `S3_ENDPOINT` (empty ⇒ IRSA), `AWS_*` |

## Run / test

```bash
# local (against the compose stack):
ICEBERG_CATALOG=iceberg ICEBERG_REST_URI=http://localhost:8181 S3_ENDPOINT=http://localhost:9000 \
  python -m uvicorn server:app --port 8091 --app-dir db/iceberg/duckdb/serving

# tests (pure-unit; engine's live tests auto-skip when the REST catalog is unreachable):
python -m pytest db/iceberg/duckdb/serving/
```

Image: `serving/Dockerfile` with **build context `db/iceberg/duckdb`** (needs `_catalog.py` +
`views/`, which the views workstream populates). Extensions are baked at build; uid 10001.
