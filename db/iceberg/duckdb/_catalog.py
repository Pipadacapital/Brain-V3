"""
_catalog.py — the shared DuckDB ⇄ Iceberg-REST-catalog seam (Spark→DuckDB migration).

This began as the DuckDB analogue of the (now-deleted) db/iceberg/spark/iceberg_base.py:
the ONE place that wires a DuckDB connection to the shared Iceberg REST catalog, so a
DuckDB job writes tables that duckdb-serving reads and Kafka Connect's Bronze lands into
— one catalog, one warehouse, identical {catalog}.{namespace}.{table} identifiers.

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

# CRITICAL: the REST-catalog ATTACH first-arg must be the warehouse NAME the catalog
# knows, NOT the s3:// URI. Passing the URI makes DuckDB attach the catalog READ-ONLY
# (path-mode); passing the bare name (bucket) attaches it READ-WRITE through the REST
# catalog. Default = the s3 URI with scheme+trailing-slash stripped (s3://brain-bronze/
# → brain-bronze); override explicitly with ICEBERG_REST_WAREHOUSE if they differ.
WAREHOUSE_NAME = os.environ.get(
    "ICEBERG_REST_WAREHOUSE",
    WAREHOUSE.replace("s3://", "").replace("s3a://", "").rstrip("/"),
)

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


def connect(read_only: bool = False):
    """
    Return a DuckDB connection attached to the Brain Iceberg REST catalog as `CATALOG`.

    The attached catalog exposes brain_bronze / brain_silver / brain_gold / brain_serving
    as schemas, so a job reads `rest.brain_bronze.<table>` and writes
    `rest.brain_silver.<table>` — the SAME identifiers Spark uses.

    `read_only=True` (additive; duckdb-serving) appends READ_ONLY to the ATTACH options so
    the catalog attach itself rejects writes (InvalidInputException on INSERT/DDL) — the
    serving tier's defense-in-depth beneath its SELECT/WITH statement guard. Verified on
    duckdb 1.5.4 (Phase-0 spike gate c). Transform jobs keep the default (read-write).
    """
    import duckdb  # imported lazily so the module imports even where duckdb isn't installed

    _assert_version(duckdb)

    con = duckdb.connect(database=":memory:", read_only=False)
    # Operate in UTC to match Spark's UTC-instant convention: the medallion stores timestamps as
    # Iceberg timestamptz (UTC instants), so a fixed UTC session makes reads/writes and rendering
    # deterministic and TZ-artifact-free (otherwise a session-local TZ shifts wall-clocks + breaks
    # cross-engine checksum comparison). Every ported job inherits this.
    con.execute("SET TimeZone='UTC';")
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
    # so duckdb-serving + Kafka Connect see the same metadata.
    #   ICEBERG_REST_AUTH: 'none'   → local iceberg-rest-fixture (no auth)   [default]
    #                      'sigv4'  → AWS-signed (e.g. S3 Tables / Glue REST in prod)
    #                      'oauth2' → token server (set ICEBERG_REST_TOKEN or client id/secret)
    # DuckDB defaults REST auth to oauth2, which errors against the unauthenticated local
    # fixture — so we set it explicitly.
    auth = os.environ.get("ICEBERG_REST_AUTH", "none").lower()
    opts = ["TYPE iceberg", f"ENDPOINT '{REST_URI}'", f"AUTHORIZATION_TYPE '{auth}'"]
    if auth == "oauth2":
        token = os.environ.get("ICEBERG_REST_TOKEN", "")
        if token:
            opts.append(f"TOKEN '{token}'")
    if read_only:
        opts.append("READ_ONLY")
    con.execute(f"ATTACH IF NOT EXISTS '{WAREHOUSE_NAME}' AS {CATALOG} ({', '.join(opts)});")
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
