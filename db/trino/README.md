# Trino — ad-hoc / federated exploration

## Purpose

Trino is an **additive, read-only** query layer over the Brain Iceberg lakehouse (Bronze / Silver / Gold).

It is for **ad-hoc exploration and federated debugging ONLY** — not an app serving path.

## Prime directive

| Layer | Serving path |
|---|---|
| App / BFF / metric-engine | StarRocks `brain_serving.mv_*` ONLY |
| Trino | Ad-hoc / exploration ONLY — never a known-metric serving dependency |

A cache-miss on a known metric goes to **StarRocks**, never Trino.
The AI/model path is registered DISABLED (NotImplementedYet) — Trino SQL is never AI-emitted.

## How it fits

Trino reads the **same** Iceberg REST catalog (`iceberg-rest:8181`) and the **same** MinIO object store that Spark and StarRocks use. No data is duplicated; the catalog and storage are shared read-only surfaces.

```
Spark (write)   ──► Iceberg REST catalog ◄── Trino (read, exploration)
StarRocks (MV)  ──►       └── MinIO S3   ◄── StarRocks (serving)
```

## Starting Trino (local dev)

Trino is part of the `lakehouse` profile:

```bash
docker compose --profile lakehouse up -d trino
```

Connect via the Trino CLI or any JDBC tool:

- HTTP UI: http://localhost:8090
- JDBC: `jdbc:trino://localhost:8090/iceberg`
- Default user: `brain` (no auth in dev)

## Catalog

`catalog/iceberg.properties` — Iceberg REST connector pointing at `iceberg-rest:8181` + MinIO S3 FileIO.

The catalog name exposed to Trino is `iceberg`. Query example:

```sql
SHOW SCHEMAS IN iceberg;
SELECT * FROM iceberg.brain_bronze.collector_events LIMIT 100;
```

## Constraints

- Read-only. Do not route app writes through Trino.
- Never add Trino as a dependency of core / collector / stream-worker / web.
- Never expose Trino port (8090) in production infrastructure.
