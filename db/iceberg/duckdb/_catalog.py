"""
_catalog.py — the shared DuckDB ⇄ Iceberg-REST-catalog seam (Spark→DuckDB migration).

This is the DuckDB analogue of db/iceberg/spark/iceberg_base.py: the ONE place that
wires a DuckDB connection to the SAME Iceberg REST catalog every Spark job uses, so a
DuckDB job writes tables that Trino reads and Kafka Connect's Bronze lands into — one
catalog, one warehouse, identical {catalog}.{namespace}.{table} identifiers.

Env parity with iceberg_base.py (intentionally the same variables):
  ICEBERG_CATALOG    catalog handle                      (default "rest")
  ICEBERG_REST_URI   REST catalog endpoint               (default http://iceberg-rest:8181)
  ICEBERG_WAREHOUSE  warehouse root (or BRONZE_WAREHOUSE) (default s3://brain-bronze/)
  S3_ENDPOINT        MinIO endpoint for local/dev; EMPTY in prod → IRSA credential chain
  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   static keys for MinIO only
  AWS_REGION         (default ap-south-1)

Prod (S3_ENDPOINT empty): uses the default AWS credential chain (WebIdentity/IRSA) —
NO static keys, NO endpoint override — exactly like the Spark S3FileIO conditional.

Requires: duckdb >= 1.5.3 (MERGE INTO + REST-catalog writes). See the Phase-0 gate doc.
"""
from __future__ import annotations

import os

CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")
REST_URI = os.environ.get("ICEBERG_REST_URI", "http://iceberg-rest:8181")
WAREHOUSE = os.environ.get("ICEBERG_WAREHOUSE", os.environ.get("BRONZE_WAREHOUSE", "s3://brain-bronze/"))
REGION = os.environ.get("AWS_REGION", "ap-south-1")

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
SILVER_NAMESPACE = os.environ.get("SILVER_NAMESPACE", "brain_silver")
GOLD_NAMESPACE = os.environ.get("GOLD_NAMESPACE", "brain_gold")
SERVING_NAMESPACE = os.environ.get("SERVING_NAMESPACE", "brain_serving")

# The DuckDB extension floor. MERGE INTO + REST-catalog writes landed in 1.5.3 (2026-05).
MIN_DUCKDB_VERSION = (1, 5, 3)


def _strip_scheme(endpoint: str) -> tuple[str, bool]:
    """DuckDB's S3 secret wants host:port WITHOUT a scheme, plus USE_SSL as a flag."""
    use_ssl = not endpoint.startswith("http://")
    host = endpoint.replace("https://", "").replace("http://", "").rstrip("/")
    return host, use_ssl


def connect():
    """
    Return a DuckDB connection attached to the Brain Iceberg REST catalog as `CATALOG`.

    The attached catalog exposes brain_bronze / brain_silver / brain_gold / brain_serving
    as schemas, so a job reads `rest.brain_bronze.<table>` and writes
    `rest.brain_silver.<table>` — the SAME identifiers Spark uses.
    """
    import duckdb  # imported lazily so the module imports even where duckdb isn't installed

    _assert_version(duckdb)

    con = duckdb.connect(database=":memory:", read_only=False)
    con.execute("INSTALL iceberg; LOAD iceberg;")
    con.execute("INSTALL httpfs; LOAD httpfs;")

    s3_endpoint = (os.environ.get("S3_ENDPOINT") or "").strip()
    if s3_endpoint:
        # Local/dev against MinIO: explicit endpoint + path-style + static keys (mirrors
        # iceberg_base.py's S3_ENDPOINT-set branch).
        host, use_ssl = _strip_scheme(s3_endpoint)
        con.execute(
            """
            CREATE OR REPLACE SECRET brain_s3 (
              TYPE s3,
              KEY_ID  ?,
              SECRET  ?,
              ENDPOINT ?,
              REGION  ?,
              URL_STYLE 'path',
              USE_SSL ?
            );
            """,
            [
                os.environ.get("AWS_ACCESS_KEY_ID", "brain"),
                os.environ.get("AWS_SECRET_ACCESS_KEY", "brainbrain"),
                host,
                REGION,
                use_ssl,
            ],
        )
    else:
        # Prod: no endpoint, no static keys — default AWS credential chain (IRSA/WebIdentity),
        # identical posture to the Spark S3FileIO fallback under EKS CronWorkflows.
        con.execute(
            "CREATE OR REPLACE SECRET brain_s3 (TYPE s3, PROVIDER credential_chain, REGION ?);",
            [REGION],
        )

    # REST-catalog attach. All writes commit as new Iceberg snapshots through this endpoint,
    # so Trino + Kafka Connect see the same metadata. read_only guards accidental writes on
    # a job that should only read (Phase-0 probes flip it off to test writes).
    attach_opts = f"TYPE iceberg, ENDPOINT '{REST_URI}'"
    con.execute(f"ATTACH IF NOT EXISTS '{WAREHOUSE}' AS {CATALOG} ({attach_opts});")
    return con


def _assert_version(duckdb_module) -> None:
    raw = duckdb_module.__version__.split("-")[0]
    parts = tuple(int(x) for x in raw.split(".")[:3])
    parts = parts + (0,) * (3 - len(parts))
    if parts < MIN_DUCKDB_VERSION:
        need = ".".join(map(str, MIN_DUCKDB_VERSION))
        raise RuntimeError(
            f"duckdb {raw} < {need}: MERGE INTO + REST-catalog Iceberg writes require "
            f">= {need} (2026-05). Upgrade: pip install -U 'duckdb>={need}'."
        )


def fqtn(namespace: str, table: str) -> str:
    """Fully-qualified table name in the attached catalog: rest.brain_silver.silver_order_state."""
    return f"{CATALOG}.{namespace}.{table}"
