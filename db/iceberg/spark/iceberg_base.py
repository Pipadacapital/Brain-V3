"""
iceberg_base.py — the shared Spark + Iceberg-REST + MinIO foundation (Brain V4 Phase 0, Area B).

This is the ADDITIVE, factored-out base that lets ANY Spark job (Bronze, and now the new Silver
and Gold jobs) talk to the SAME local lakehouse (Iceberg REST catalog over MinIO S3) with one
identical catalog config. It is the seam Phase 1+ Silver and Phase 2+ Gold jobs reuse so the
Iceberg-REST/MinIO wiring lives in exactly ONE place.

Why a separate module (non-breaking): `bronze_materialize.build_spark` already encodes this exact
catalog config, but it is bound to the Bronze appName and lives next to the Bronze streaming logic.
Re-deriving the catalog config here (rather than importing build_spark) keeps Bronze untouched —
this file imports NOTHING from bronze_materialize, so adding/changing it can never break the proven
Bronze path. `bronze_materialize.build_spark` stays the canonical Bronze factory; new Silver/Gold
jobs call `iceberg_base.build_spark(...)`.

Parity of config with bronze_materialize.build_spark (intentional — same catalog, same warehouse):
  - REST catalog (org.apache.iceberg.spark.SparkCatalog, type=rest) at ICEBERG_REST_URI
  - S3FileIO over MinIO (path-style, brain/brainbrain creds, us-east-1)
  - the deprecated-offset-fetching flag (harmless for batch; matches the Bronze session so a job that
    ALSO reads Kafka — e.g. a future streaming Silver — behaves identically)

Local substrate note: the single local Iceberg REST catalog (`rest`) has one physical warehouse
(s3://brain-bronze/ in compose), but Iceberg NAMESPACES are logical — brain_silver and brain_gold
are created as additional namespaces in that same catalog, so Spark can CREATE + MERGE Silver/Gold
tables in local-prod with no new bucket. In production the Terraform-provisioned Glue catalog gives
each medallion layer its own S3 bucket; the catalog/namespace names stay identical, so job code that
uses {CATALOG}.{namespace}.{table} is environment-portable.
"""
from __future__ import annotations  # PEP 563: the Spark image ships Python 3.8 — defer annotation
# evaluation so `str | None`, `list[str]`, `dict[str, str]` parse on 3.8 (they'd otherwise TypeError
# at import time). Pure type-hint sugar; no runtime behaviour change.

import os

from pyspark.sql import SparkSession

# The single REST catalog the local lakehouse exposes (compose `iceberg-rest`). Same catalog handle
# Bronze uses — namespaces (brain_bronze / brain_silver / brain_gold) live side-by-side inside it.
CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")

# Medallion namespaces. Bronze already exists; Phase 0 provisions Silver + Gold (provision_silver_gold.py).
SILVER_NAMESPACE = os.environ.get("SILVER_NAMESPACE", "brain_silver")
GOLD_NAMESPACE = os.environ.get("GOLD_NAMESPACE", "brain_gold")


def build_spark(app_name: str = "brain-iceberg") -> SparkSession:
    """A SparkSession wired to the local Iceberg REST catalog over MinIO — the SAME catalog config
    as bronze_materialize.build_spark, factored out so Silver/Gold jobs share one definition.

    All wiring is env-overridable; dev defaults target the compose service names (iceberg-rest:8181,
    minio:9000). Pass a job-specific app_name for log/UI attribution.
    """
    return (
        SparkSession.builder.appName(app_name)
        # Match the Bronze session: consumer-based offset fetching (harmless for pure-batch jobs;
        # keeps a future Kafka-reading Silver job behaving exactly like the proven Bronze sink).
        .config("spark.sql.streaming.kafka.useDeprecatedOffsetFetching", "true")
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config(f"spark.sql.catalog.{CATALOG}", "org.apache.iceberg.spark.SparkCatalog")
        .config(f"spark.sql.catalog.{CATALOG}.type", "rest")
        .config(f"spark.sql.catalog.{CATALOG}.uri", os.environ.get("ICEBERG_REST_URI", "http://iceberg-rest:8181"))
        # One physical warehouse backs the local REST catalog; Silver/Gold are namespaces within it.
        # Overridable so a Glue-backed prod catalog (per-layer buckets) can point elsewhere.
        .config(f"spark.sql.catalog.{CATALOG}.warehouse", os.environ.get("ICEBERG_WAREHOUSE", os.environ.get("BRONZE_WAREHOUSE", "s3://brain-bronze/")))
        .config(f"spark.sql.catalog.{CATALOG}.io-impl", "org.apache.iceberg.aws.s3.S3FileIO")
        .config(f"spark.sql.catalog.{CATALOG}.s3.endpoint", os.environ.get("S3_ENDPOINT", "http://minio:9000"))
        .config(f"spark.sql.catalog.{CATALOG}.s3.path-style-access", "true")
        .config(f"spark.sql.catalog.{CATALOG}.s3.access-key-id", os.environ.get("AWS_ACCESS_KEY_ID", "brain"))
        .config(f"spark.sql.catalog.{CATALOG}.s3.secret-access-key", os.environ.get("AWS_SECRET_ACCESS_KEY", "brainbrain"))
        .getOrCreate()
    )


def ensure_namespace(spark: SparkSession, namespace: str, catalog: str = CATALOG) -> str:
    """Idempotently create an Iceberg namespace in the REST catalog and return its qualified name.

    Mirrors the Bronze `CREATE NAMESPACE IF NOT EXISTS` discipline — safe to re-run. Returns
    `{catalog}.{namespace}` so callers can compose table identifiers.
    """
    qualified = f"{catalog}.{namespace}"
    spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {qualified}")
    return qualified


def create_iceberg_table(
    spark: SparkSession,
    namespace: str,
    table: str,
    columns_sql: str,
    *,
    partitioned_by: str | None = None,
    catalog: str = CATALOG,
    tblproperties: dict[str, str] | None = None,
) -> str:
    """Idempotently create a format-v2 Iceberg table — the shared DDL helper Silver/Gold jobs reuse.

    Mirrors the Bronze ensure_table contract (CREATE TABLE IF NOT EXISTS ... USING iceberg, format-v2,
    zstd parquet, upsert disabled so the MERGE path is append-only-on-no-match like Bronze). The
    caller supplies the column list and (optionally) a hidden-partitioning spec; brand_id-first
    tenant partitioning is the convention (e.g. "bucket(256, brand_id), days(occurred_at)").

    Returns the fully-qualified table name `{catalog}.{namespace}.{table}` for MERGE/INSERT callers.
    """
    ensure_namespace(spark, namespace, catalog)
    fqtn = f"{catalog}.{namespace}.{table}"

    props = {
        "format-version": "2",
        "write.format.default": "parquet",
        "write.parquet.compression-codec": "zstd",
        # Append-only-on-no-match, exactly like Bronze: idempotent MERGE WHEN NOT MATCHED, never an
        # in-place row rewrite via the upsert fast-path. Silver/Gold jobs that need updates issue an
        # explicit MERGE ... WHEN MATCHED THEN UPDATE.
        "write.upsert.enabled": "false",
    }
    if tblproperties:
        props.update(tblproperties)
    props_sql = ",\n          ".join(f"'{k}' = '{v}'" for k, v in props.items())

    partition_clause = f"\n        PARTITIONED BY ({partitioned_by})" if partitioned_by else ""

    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {fqtn} (
          {columns_sql}
        )
        USING iceberg{partition_clause}
        TBLPROPERTIES (
          {props_sql}
        )
        """
    )
    return fqtn
