"""
revenue_ledger_materialize.py — Spark batch: PG billing.realized_revenue_ledger → Iceberg Bronze.

DB-AUDIT H2. The realized-revenue ledger is worker-written into Postgres (the transactional write SoR).
This job lands it into the Iceberg lakehouse as brain_bronze.revenue_ledger so the ANALYTICAL marts
(gold_revenue_ledger, and downstream the money metric-engine reads) can be served from Iceberg instead
of a live JDBC read of Postgres — i.e. PG stops being the analytical source of truth (the audit goal).

Idempotent: MERGE INTO ... ON (brand_id, ledger_event_id) WHEN NOT MATCHED THEN INSERT — append-only
ledger semantics preserved; re-running over the same rows never double-writes (I-E02). The ledger row is
immutable per (brand_id, ledger_event_id), so a plain MERGE-insert is exact.

Run shape: a periodic batch (Argo CronWorkflow), the same operational shape as bronze_maintenance — it
re-materializes new ledger rows each run (watermark on created_at). For the dev validation it does a full
MERGE (idempotent). The continuous event-sourced path (worker → ledger.event.v1 → Spark stream) is the
later evolution; this batch materializer is the reversible first step (gold reads stay PG-default until
the parity bake flips bronze_source=iceberg).

Run via db/iceberg/spark/run-revenue-ledger-materialize.sh (mirrors run-bronze-spike.sh wiring).
"""
import os

from pyspark.sql import SparkSession
from pyspark.sql.functions import col

CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")
NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
TABLE = f"{CATALOG}.{NAMESPACE}.revenue_ledger"

PG_JDBC_URL = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("BRONZE_PG_USER", "brain")
PG_PASSWORD = os.environ.get("BRONZE_PG_PASSWORD", "brain")

# Read the canonical (partitioned) ledger; cast uuid → text (parity with the JDBC read-shim). The
# query mirrors silver_order_ledger_src / gold_revenue_ledger's column set exactly.
LEDGER_QUERY = """
  (SELECT
     brand_id::text          AS brand_id,
     ledger_event_id,
     order_id,
     brain_id::text          AS brain_id,
     event_type,
     amount_minor,
     currency_code,
     COALESCE(fee_minor, 0)  AS fee_minor,
     occurred_at,
     economic_effective_at,
     recognition_label,
     billing_posted_period,
     created_at
   FROM billing.realized_revenue_ledger) AS rrl
"""


def build_spark() -> SparkSession:
    return (
        SparkSession.builder.appName("revenue-ledger-materialize")
        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")
        .config(f"spark.sql.catalog.{CATALOG}", "org.apache.iceberg.spark.SparkCatalog")
        .config(f"spark.sql.catalog.{CATALOG}.type", "rest")
        .config(f"spark.sql.catalog.{CATALOG}.uri", os.environ.get("ICEBERG_REST_URI", "http://iceberg-rest:8181"))
        .config(f"spark.sql.catalog.{CATALOG}.warehouse", os.environ.get("BRONZE_WAREHOUSE", "s3://brain-bronze/"))
        .config(f"spark.sql.catalog.{CATALOG}.io-impl", "org.apache.iceberg.aws.s3.S3FileIO")
        .config(f"spark.sql.catalog.{CATALOG}.s3.endpoint", os.environ.get("S3_ENDPOINT", "http://minio:9000"))
        .config(f"spark.sql.catalog.{CATALOG}.s3.path-style-access", "true")
        .config(f"spark.sql.catalog.{CATALOG}.s3.access-key-id", os.environ.get("AWS_ACCESS_KEY_ID", "brain"))
        .config(f"spark.sql.catalog.{CATALOG}.s3.secret-access-key", os.environ.get("AWS_SECRET_ACCESS_KEY", "brainbrain"))
        .getOrCreate()
    )


def ensure_table(spark: SparkSession) -> None:
    spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {CATALOG}.{NAMESPACE}")
    spark.sql(
        f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
          brand_id              string    NOT NULL,
          ledger_event_id       string    NOT NULL,
          order_id              string    NOT NULL,
          brain_id              string,
          event_type            string    NOT NULL,
          amount_minor          bigint    NOT NULL,
          currency_code         string    NOT NULL,
          fee_minor             bigint    NOT NULL,
          occurred_at           timestamp NOT NULL,
          economic_effective_at timestamp NOT NULL,
          recognition_label     string    NOT NULL,
          billing_posted_period string    NOT NULL,
          created_at            timestamp NOT NULL
        )
        USING iceberg
        PARTITIONED BY (bucket(16, brand_id), days(occurred_at))
        TBLPROPERTIES (
          'format-version'                  = '2',
          'write.format.default'            = 'parquet',
          'write.parquet.compression-codec' = 'zstd',
          'write.upsert.enabled'            = 'false'
        )
        """
    )


def main() -> None:
    spark = build_spark()
    ensure_table(spark)

    src = (
        spark.read.format("jdbc")
        .option("url", PG_JDBC_URL)
        .option("user", PG_USER)
        .option("password", PG_PASSWORD)
        .option("driver", "org.postgresql.Driver")
        .option("dbtable", LEDGER_QUERY)
        .load()
    )
    src.createOrReplaceTempView("ledger_src")

    # Idempotent append: insert only ledger_event_ids not already present (immutable rows).
    spark.sql(
        f"""
        MERGE INTO {TABLE} t
        USING ledger_src s
        ON t.brand_id = s.brand_id AND t.ledger_event_id = s.ledger_event_id
        WHEN NOT MATCHED THEN INSERT *
        """
    )

    total = spark.sql(f"SELECT count(*) AS n FROM {TABLE}").collect()[0]["n"]
    print(f"[revenue-ledger-materialize] Iceberg {TABLE} now has {total} rows")
    spark.stop()


if __name__ == "__main__":
    main()
