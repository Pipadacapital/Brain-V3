# RB-4 — Local lakehouse (Iceberg REST catalog + MinIO)

> **HISTORICAL FRAMING (pre-Brain-V4).** This runbook was written during the Iceberg-Bronze flip and
> describes the **then-live** local stack: `StarRocks` (serving), `dbt` (Silver/Gold compute),
> `Redpanda` (broker), with Bronze still on Postgres. **None of those are live under Brain V4:**
> StarRocks and dbt are **REMOVED** (serving is **duckdb-serving** + Redis via `brain_serving.mv_*`
> views — Trino briefly held this seat and is removed too, ADR-0014; DuckDB-on-Iceberg is the **sole**
> compute), and Redpanda was replaced by **Apache Kafka
> (KRaft)** (the compose DNS name `redpanda` was kept). The Iceberg REST catalog + MinIO substrate
> below is still accurate and Bronze is now Iceberg sole-SoR. To stand up + refresh the local medallion
> today use `pnpm dev:up` + `tools/dev/duckdb-refresh.sh` (DuckDB Silver→Gold) — **not**
> the `dbt` / `StarRocks` steps in the Slice sections below. Read those sections for catalog/object-store
> wiring only. **Further (ADR-0010, 2026-07-05):** the Spark-SS Bronze landing this runbook exercised
> (`bronze_materialize.py`, `run-bronze-spike.sh`) is REMOVED — Bronze landing is the always-on
> `kafka-connect` compose service. Wherever a slice says "run the spike to materialize into Iceberg",
> today you just produce to Kafka and the Connect sink lands it (~30s commit interval), into
> `brain_bronze.collector_events_connect` / `<lane>_raw_connect`.

The local stand-in for the production Bronze substrate (AWS Glue + S3). Used to develop and
verify the Iceberg Bronze flip (ADR-0002) without AWS. **Optional infra** — not part of the
default `pnpm dev` loop, because the live ingest path still writes Bronze to Postgres until the
flip completes.

## Components

| Service | Image | Port | Role |
|---|---|---|---|
| `iceberg-rest` | `apache/iceberg-rest-fixture:1.9.2` | `8181` | Iceberg REST catalog (local equivalent of AWS Glue Data Catalog) |
| `minio` | `minio/minio` | `9000` / `9001` | S3-compatible object store; warehouse = `s3://brain-bronze/` |

Catalog → object-store wiring (compose env on `iceberg-rest`): `CATALOG_WAREHOUSE=s3://brain-bronze/`,
`CATALOG_S3_ENDPOINT=http://minio:9000`, path-style access, creds `brain` / `brainbrain`.

> Replaces the previously-broken `projectnessie/nessie:0.90.2` (unpullable tag, PR #72).

## Start

```bash
pnpm dev:lakehouse        # docker compose --profile lakehouse up -d  (brings up minio + iceberg-rest)
```

## Verify

```bash
# catalog config (proves the REST catalog is up)
curl -s http://localhost:8181/v1/config | jq .

# container health
docker compose ps | grep -E 'iceberg-rest|minio'      # both should be (healthy)

# MinIO console: http://localhost:9001  (brain / brainbrain) — warehouse bucket: brain-bronze
```

Expected: `GET /v1/config` → HTTP 200 with the endpoint list; `iceberg-rest` and `minio` both
`(healthy)`.

## StarRocks → Iceberg catalog (read path; wired in a later slice)

`db/starrocks/external_iceberg_catalog.sql` and `db/starrocks/bootstrap.sql` define the
`brain_bronze_local` external catalog pointing at `http://iceberg-rest:8181`. This is exercised
when the analytics reader flip lands (ADR-0002, Slice 4) — not in the default dev loop.

## Stop / reset

```bash
docker compose --profile lakehouse down          # stop (keep volumes)
docker compose --profile lakehouse down -v       # wipe the local warehouse + catalog state
```

## Troubleshooting

- **`iceberg-rest` unhealthy / `:8181` refused:** check `minio` is healthy first (the catalog
  `depends_on` it); `docker compose logs iceberg-rest`.
- **Image pull fails:** confirm the pinned tag `apache/iceberg-rest-fixture:1.9.2` is reachable;
  do not fall back to `:latest` in committed compose (reproducibility).
- **`brand-bronze` bucket missing:** `minio-init` creates `brain-bronze` + `brain-audit` on first
  boot; re-run `docker compose --profile lakehouse up -d` if it was skipped.

## Slice 2 — Spark Bronze write spike

Validates the Slice-3 writer (Spark Structured Streaming → Iceberg) against the local lakehouse:
read the live Redpanda topic, MERGE into `brain_bronze.collector_events` (idempotent on
`(brand_id, event_id)`), partitioned `bucket(16, brand_id) + days(occurred_at)`.

```bash
pnpm dev:lakehouse                       # ensure iceberg-rest + minio are up
db/iceberg/spark/run-bronze-spike.sh     # (HISTORICAL — script removed with ADR-0010; today: produce to
                                         #  Kafka and the kafka-connect sink lands it within ~30s)
```

The runner joins Redpanda's network namespace (`--network container:brainv3-redpanda-1`) so the
broker's `localhost:9092` advertised listener is reachable while `iceberg-rest`/`minio` DNS still
resolves. Inspect the result with `db/iceberg/spark/validate_bronze.py` (row count, distinct
event_type, Iceberg `.partitions` metadata, `DESCRIBE` spec, sample row).

Re-running drains the same backlog (fresh container checkpoint) and the row count is unchanged —
the MERGE is append-only/idempotent (I-E02 replay invariant). Verified: 888 `order.live.v1` rows,
partitions `{brand_id_bucket, occurred_at_day}`, parquet/zstd/format-v2 under `s3://brain-bronze/`.

## Slice 3 — dual-sink + the PG ⇄ Iceberg parity gate

The cautious migration model: both Bronze sinks run in parallel — the live `stream-worker → Postgres
bronze_events` write (untouched) and the Spark `→ Iceberg` materializer — both consuming the same
`collector.event.v1` topic. The **parity oracle** proves they hold the same `(brand_id, event_id)`
identity set per brand and **gates** every reader cut-over (Slices 4-6): no reader moves to Iceberg
until parity is green and stable.

```bash
db/iceberg/spark/run-bronze-parity.sh    # PG⇄Iceberg reconciliation; exits non-zero on drift
```

Parity is IDENTITY-based, not payload-byte-based (the two writers serialize JSON differently; the
idempotency key is what must match). Verified locally: real brand `124e6af5` showed **887 PG = 887
Iceberg, delta 0**; the oracle also correctly CLOSED the gate on a 1-event divergence (a test
fixture), proving drift detection.

**Job modes** (`db/iceberg/spark/bronze_materialize.py` — HISTORICAL, removed with ADR-0010):
`TRIGGER_MODE=availableNow` (default — drain+exit, the periodic CronWorkflow shape) vs `continuous`
(long-lived stream, the post-cutover real-time shape). Prod set a durable
`CHECKPOINT_LOCATION=s3a://…`. Today's landing writer (kafka-connect) is always-on with no
checkpoint — offsets live in the Iceberg snapshot metadata.

**Deploy** (`docs/audit`/B3): image `db/iceberg/spark/Dockerfile` (jars baked in) → ECR; CronWorkflows
in `infra/helm/cronworkflows/templates/spark-bronze.yaml`, **gated off** by `sparkBronze.enabled`
(flip per env to start the dual-sink; flip back to stop). Needs the `brain-jobs` IRSA role (S3
per-brand prefix + Glue) and the env secret (KAFKA/ICEBERG/CHECKPOINT/AWS). Not yet cluster-applied.

## Slice 4 — StarRocks reads Bronze from Iceberg (read-path cut-over)

The analytics read path graduates from the Postgres JDBC catalog to the Iceberg external catalog.
The `brain_bronze_local` catalog (`db/starrocks/{bootstrap,external_iceberg_catalog}.sql`) was fixed
to actually work — three things the scaffolding lacked, all required:
1. **underscore** property names (`aws.s3.access_key`, not `access-key` — the hyphen form is silently
   ignored, so StarRocks falls back to the default AWS chain),
2. `aws.s3.region`,
3. `client.factory=com.starrocks.connector.iceberg.IcebergAwsClientFactory`.

Without these the read fails with `Region must be specified`. Smoke (verified — 888 rows):

```bash
docker exec brainv3-starrocks-1 mysql -h127.0.0.1 -P9030 -uroot \
  -e "SELECT count(*) FROM brain_bronze_local.brain_bronze.collector_events;"
```

If the running StarRocks bootstrapped an older catalog (comment says "Nessie"), `DROP CATALOG
brain_bronze_local;` and re-run the corrected `CREATE EXTERNAL CATALOG` from `external_iceberg_catalog.sql`.

**Remaining Slice 4 work (gated):** flip the dbt Bronze-derived sources (`bronze_touchpoint_src`,
`bronze_order_line_src`) in `_sources.yml` to the Iceberg catalog and move the PG read-shim transforms
(event-type filter, `line_items` unnest, JSON extraction) into the staging models — the ledger + stitch
map stay on JDBC (they're derived, not raw Bronze). Gated on the parity oracle being green.

### Slice 4b enablement (done — dev prerequisites)

**Touchpoint events in both Bronze sinks** — generate realistic journey events through the real ingest
path (POST /collect → pixel consumer → PG bronze, AND Spark → Iceberg):

```bash
node tools/pixel-fixture/seed-touchpoints.mjs   # uses brand 124e6af5 + its install_token + consent
db/iceberg/spark/run-bronze-spike.sh            # (HISTORICAL — removed with ADR-0010; the Connect
                                                #  sink lands the produced events itself, ~30s)
```

Verified: `page.viewed`/`cart.viewed`/`cart.item_added` land in PG `bronze_events` AND Iceberg
`collector_events` (same counts → parity).

**Stand up dbt** (the Makefile expects `.dbt-venv`; gitignored):

```bash
python3 -m venv .dbt-venv && .dbt-venv/bin/pip install dbt-starrocks
cd db/dbt && DBT_PROFILES_DIR=profiles ../../.dbt-venv/bin/dbt debug   # → All checks passed
```

dbt-core 1.11 + dbt-starrocks 1.12 connect to local StarRocks (`localhost:9030`, root, `default_catalog`,
schema `brain_silver`); `dbt parse` compiles the 8 models. With these in place, Slice 4b (flip the
Bronze sources to Iceberg + move shim transforms into staging + mart parity) is unblocked.

### Slice 4b — touchpoint Bronze source flipped to Iceberg (PROVEN)

`stg_touchpoint_events` reads its Bronze source via a reversible dbt var `bronze_source` (default `pg`):
- `pg` → the JDBC read-shim view `oltp.bronze_touchpoint_src` (PG bronze_events, pre-filtered/cast)
- `iceberg` → the raw `bronze_iceberg.collector_events` catalog + the journey event-type filter applied
  in staging (the shim's `WHERE` moves into the model). Both expose `payload.properties.*` identically.

Stand up both catalogs, then build + diff:

```bash
# both catalogs (JDBC baseline + Iceberg) and the PG shim views:
docker exec -i brainv3-postgres-1 psql -U brain -d brain < db/starrocks/bronze_touchpoint_src.sql
docker exec -i brainv3-starrocks-1 mysql -h127.0.0.1 -P9030 -uroot < db/starrocks/oltp_jdbc_catalog.sql
cd db/dbt
DBT_PROFILES_DIR=profiles dbt run  --select stg_touchpoint_events+                          # PG baseline
DBT_PROFILES_DIR=profiles dbt run  --select stg_touchpoint_events+ --vars '{bronze_source: iceberg}'
DBT_PROFILES_DIR=profiles dbt test --select silver_touchpoint+    --vars '{bronze_source: iceberg}'
```

VERIFIED: `silver_touchpoint` built from Iceberg is **byte-for-byte identical** to the PG-sourced mart
(42 rows), and all 12 dbt tests (grain, replay-idempotency, not-null, accepted-values) pass under the
Iceberg source. The reader flip is correct.

### Slice 4b — order-line Bronze source flipped to Iceberg (PROVEN)

`stg_order_line_events` now carries the same reversible `bronze_source` var as the touchpoint model:
- `pg` → the JDBC read-shim view `oltp.bronze_order_line_src` (latest-order pick + `line_items` unnest
  done in the Postgres view via `jsonb_array_elements WITH ORDINALITY`).
- `iceberg` → the raw `bronze_iceberg.collector_events` catalog; the latest-order pick (`row_number`)
  and the `line_items` **array unnest move into staging**, done NATIVELY in StarRocks:
  `cross join unnest(cast(parse_json(get_json_string(payload,'$.properties.line_items')) as array<json>))`.

Dev `order.live.v1` re-pulls carry NO `line_items`, so a synthetic line-item order is seeded through the
REAL ingest path (one inject → both sinks: PG via the bridge, Iceberg via Spark):

```bash
node tools/seed/seed-line-item-order.mjs        # order.live.v1 + properties.line_items → dev.collector.event.v1
db/iceberg/spark/run-bronze-spike.sh            # (HISTORICAL — removed with ADR-0010; the Connect
                                                #  sink lands it itself, ~30s)
docker exec brainv3-starrocks-1 mysql -h127.0.0.1 -P9030 -uroot \
  -e "REFRESH EXTERNAL TABLE brain_bronze_local.brain_bronze.collector_events;"
cd db/dbt
DBT_PROFILES_DIR=profiles dbt run  --select stg_order_line_events+                          # PG baseline
DBT_PROFILES_DIR=profiles dbt run  --select stg_order_line_events+ --vars '{bronze_source: iceberg}'
DBT_PROFILES_DIR=profiles dbt test --select silver_order_line     --vars '{bronze_source: iceberg}'
```

VERIFIED: two-way `EXCEPT` on the line content (`sku, quantity, unit_price_minor, line_total_minor,
line_discount_minor, product_id, variant_id, currency_code`) → **pg_rows=3, iceberg_rows=3, pg_only=0,
iceberg_only=0 (CONTENT PARITY)**; all 9 dbt tests pass under the Iceberg source (grain + replay included).

**ONE documented difference:** `line_index`. StarRocks unnest has no `WITH ORDINALITY` and `array_generate`
needs literal bounds, so the Iceberg path assigns `line_index` as a DETERMINISTIC `row_number` over the
line's own content (sku, variant_id, unit_price_minor) — 1..N, stable, replay-safe — rather than the PG
shim's array position. `line_index` is a grain disambiguator, never a business value, so this is benign and
the line CONTENT is byte-identical. With this, **all raw-Bronze reader sources are flipped** — the ledger +
stitch-map sources stay on JDBC by design (derived, not raw Bronze).

## Slice 7 — Iceberg maintenance: compaction, 24-mo TTL, erasure-aware compaction

`db/iceberg/spark/bronze_maintenance.py` (image-baked; CronWorkflow `bronze-maintenance`, daily 03:00):

```bash
db/iceberg/spark/run-bronze-maintenance.sh                                  # MODE=maintain (default)
MODE=erase ERASE_BRAND_ID=<uuid> db/iceberg/spark/run-bronze-maintenance.sh # D13 right-to-erasure
```

- **maintain**: `rewrite_data_files` (compact the many small streaming files) + `expire_snapshots`
  (drop snapshots older than 24 months + delete the files only they referenced — the I-E02 TTL).
- **erase** (the D13 / I-S05 right-to-erasure companion, invoked on-demand after a brand's DEK is
  crypto-shredded): `DELETE FROM … WHERE brand_id=<x>` → `rewrite_data_files` (rows gone from live
  files) → `expire_snapshots` (purge pre-deletion snapshots so time-travel can't read the erased
  rows). VERIFIED: erasing test brand `b9f10030` → Spark `rows_after=0`; after `REFRESH EXTERNAL
  TABLE` StarRocks confirms 0 (physically removed from the open Bronze Parquet).

This closes the I-S05 erasure-aware-compaction gap that was deferred while Bronze was Postgres.

## Related

- ADR-0002 — `docs/adr/0002-iceberg-bronze-spark-streaming.md` (the Bronze→Iceberg flip plan)
- RB-3 — StarRocks rebuild-from-Iceberg
