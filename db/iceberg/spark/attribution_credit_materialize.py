"""
attribution_credit_materialize.py — Spark batch: PG billing.attribution_credit_ledger → Iceberg Bronze.

DB-AUDIT H2 (second mart). Sibling of revenue_ledger_materialize.py: lands the worker-written
attribution credit/clawback ledger into the lakehouse as brain_bronze.attribution_credit so
gold_marketing_attribution can be served from Iceberg instead of a live JDBC read of Postgres.

Idempotent: MERGE ON (brand_id, credit_id) WHEN NOT MATCHED THEN INSERT — append-only; the credit row
is immutable per deterministic credit_id. (attribution_credit_ledger is currently data-starved — 0 rows —
so this proves the mechanism + establishes the table; parity is trivially 0==0 until journeys flow.)

Run via db/iceberg/spark/run-revenue-ledger-materialize.sh with MATERIALIZE_SCRIPT overridden, or its
sibling run-attribution-credit-materialize.sh.
"""
import os

from pyspark.sql import SparkSession

CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")
NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
TABLE = f"{CATALOG}.{NAMESPACE}.attribution_credit"

PG_JDBC_URL = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("BRONZE_PG_USER", "brain")
PG_PASSWORD = os.environ.get("BRONZE_PG_PASSWORD", "brain")

# Cast uuid → text (parity with the JDBC read-shim gold_attribution_credit_src); column set mirrors
# gold_marketing_attribution exactly.
CREDIT_QUERY = """
  (SELECT
     brand_id::text          AS brand_id,
     credit_id,
     order_id,
     brain_anon_id,
     touch_seq,
     channel,
     campaign_id,
     model_id,
     row_kind,
     credited_revenue_minor,
     currency_code,
     realized_revenue_minor,
     reversed_of_credit_id,
     confidence_grade,
     attribution_confidence,
     model_version,
     occurred_at,
     economic_effective_at,
     billing_posted_period,
     created_at
   FROM billing.attribution_credit_ledger) AS acl
"""


def build_spark() -> SparkSession:
    return (
        SparkSession.builder.appName("attribution-credit-materialize")
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
          brand_id               string        NOT NULL,
          credit_id              string        NOT NULL,
          order_id               string        NOT NULL,
          brain_anon_id          string,
          touch_seq              int           NOT NULL,
          channel                string        NOT NULL,
          campaign_id            string,
          model_id               string        NOT NULL,
          row_kind               string        NOT NULL,
          credited_revenue_minor bigint        NOT NULL,
          currency_code          string        NOT NULL,
          realized_revenue_minor bigint        NOT NULL,
          reversed_of_credit_id  string,
          confidence_grade       string        NOT NULL,
          attribution_confidence decimal(4,3)  NOT NULL,
          model_version          string        NOT NULL,
          occurred_at            timestamp     NOT NULL,
          economic_effective_at  timestamp     NOT NULL,
          billing_posted_period  string        NOT NULL,
          created_at             timestamp     NOT NULL
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
        .option("dbtable", CREDIT_QUERY)
        .load()
    )
    src.createOrReplaceTempView("credit_src")

    spark.sql(
        f"""
        MERGE INTO {TABLE} t
        USING credit_src s
        ON t.brand_id = s.brand_id AND t.credit_id = s.credit_id
        WHEN NOT MATCHED THEN INSERT *
        """
    )

    total = spark.sql(f"SELECT count(*) AS n FROM {TABLE}").collect()[0]["n"]
    print(f"[attribution-credit-materialize] Iceberg {TABLE} now has {total} rows")
    spark.stop()


if __name__ == "__main__":
    main()
