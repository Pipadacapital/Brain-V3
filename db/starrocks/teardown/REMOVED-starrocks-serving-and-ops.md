# BRAIN V4 — FINAL TEARDOWN: StarRocks removed entirely

StarRocks is no longer part of Brain. Serving is now **Trino-over-Iceberg + Redis cache**
(the `mv_*` views live in `db/trino/views/`), and operational state lives in the
**PostgreSQL `ops` schema** (migration `0116`). Iceberg remains the system of record.

## What was deleted (and what replaced it)

All of the following StarRocks-specific assets were removed from `db/starrocks/` in this wave.
They are recorded here for provenance; recover from git history if ever needed.

| Removed | Purpose (StarRocks) | Replacement (V4 final) |
| --- | --- | --- |
| `mv/mv_*.sql` (35 files) | StarRocks async materialized views = serving layer | `db/trino/views/mv_*.sql` (Trino views over Iceberg), applied via `db/trino/views/run-trino-views.sh` |
| `mv/run-mv.sh`, `mv/run_mvs.sh`, `mv/run_mv_group_*.sh` | MV apply/refresh runners | `db/trino/views/run-trino-views.sh` |
| `bootstrap.sql` | StarRocks DB/role bootstrap | n/a (no StarRocks) |
| `external_iceberg_catalog.sql`, `external_iceberg_silver_gold_catalog.sql` | StarRocks → Iceberg external catalog registration | Trino `iceberg` catalog (`db/trino/catalog/iceberg.properties`) |
| `analytics_grants.sql` | StarRocks analytics-role grants | n/a |
| `oltp_jdbc_catalog.sql`, `oltp_pg_read_shim.sql` | StarRocks → Postgres JDBC read shim | n/a |
| `row_policy_template.sql` | StarRocks row-access policy (`${BRAND_PREDICATE}` seam) | enforced in serving via the `${BRAND_PREDICATE}` seam at query time |
| `bronze_order_line_src.sql`, `bronze_touchpoint_src.sql` | StarRocks Bronze source defs | Spark reads Iceberg Bronze directly |
| `ops/ops_*.sql` (7 files) + `ops/run_ops.sh` | StarRocks-native operational state | PostgreSQL `ops` schema, migration `0116` |

## Kept in this directory

- `drop_dbt_internal_dbs.sql` — drops the retired dbt-internal `brain_gold` / `brain_silver` DBs.
- `drop_dead_feature_db.sql` — drops the dead `brain_feature` precompute DB.

Both are pre-existing destructive teardown scripts retained for the historical StarRocks instance.
After this wave nothing in app/serving code references StarRocks, `brain_serving.mv_*`, or
`brain_ops`-on-StarRocks.
