# RB-4 — Local lakehouse (Iceberg REST catalog + MinIO)

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
db/iceberg/spark/run-bronze-spike.sh     # one-shot Spark container, trigger=availableNow (drains + exits)
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

**Job modes** (`db/iceberg/spark/bronze_materialize.py`): `TRIGGER_MODE=availableNow` (default —
drain+exit, the periodic CronWorkflow shape) vs `continuous` (long-lived stream, the post-cutover
real-time shape). Prod sets a durable `CHECKPOINT_LOCATION=s3a://…`.

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
db/iceberg/spark/run-bronze-spike.sh            # pull them into Iceberg
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

## Related

- ADR-0002 — `docs/adr/0002-iceberg-bronze-spark-streaming.md` (the Bronze→Iceberg flip plan)
- RB-3 — StarRocks rebuild-from-Iceberg
