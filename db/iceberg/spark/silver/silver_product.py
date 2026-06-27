"""
silver_product.py — Brain V4 Phase 1 (Spark Silver, dual-run). GROUP=orders.

Reimplements db/dbt/models/marts/silver_product.sql as a Spark job that reads the Iceberg
brain_silver.silver_order_line mart (built by silver_order_line.py) and writes
Iceberg brain_silver.silver_product — BESIDE the dbt→StarRocks copy (dual-run, NON-BREAKING).

THE TRANSFORM (silver_product.sql, exact):
  product_key = coalesce(nullif(product_id,''), nullif(sku,''), 'unknown')
  filter currency_code is not null
  group by (brand_id, product_key, currency_code):
    sku = max(sku), title = max(title), order_count = count(distinct order_id),
    units_sold = sum(quantity), gross_revenue_minor = sum(line_total_minor),
    discount_minor = sum(line_discount_minor), first_sold_at = min(occurred_at),
    last_sold_at = max(occurred_at), updated_at = current_timestamp()

GRAIN: 1 row per (brand_id, product_key, currency_code). MONEY: gross_revenue_minor / discount_minor
are BIGINT minor units + currency_code (non-null, in the PK). brand_id is the tenant key, first column.
IDEMPOTENT: MERGE on the (brand_id, product_key, currency_code) PK.

DUAL-RUN SOURCE NOTE: dbt's silver_product reads ref('silver_order_line') = the StarRocks dbt copy;
this Spark job reads the ICEBERG silver_order_line it builds, so the whole Spark Silver lane is
self-consistent (Iceberg → Iceberg). Both lanes derive from the SAME Bronze, so parity holds.

STAGE-1 GATE (Brain V4 two-stage): this is a per-(brand, product_key, currency) AGGREGATE, so it runs
  the same currency-only DQ gate as the silver_customer aggregate: a rolled-up product row whose
  currency_code is not ISO-4217 alpha-3 is diverted to brain_silver.silver_quarantine (stage='dq') and
  NOT written to silver_product. The amount-sign DQ rule is intentionally NOT applied at this grain — a
  product's gross_revenue_minor / discount_minor are sums that can be legitimately net-negative once
  returns/refund-adjusted line items net out; and units_sold is a sum that can legitimately exceed the
  per-record absurd-quantity ceiling, so impossible_quantity is N/A here too. clean_string is NOT applied
  to sku/title — they are parity-faithful max() passthroughs (mutating them would break dbt parity).
  Good rows are byte-identical to before (parity-faithful); the upstream line-grain DQ already gated the
  per-line money/quantity that feed these sums.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession

from iceberg_base import (  # noqa: E402
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)
from pyspark.sql.functions import array_join, col, lit, size, struct, to_json  # noqa: E402
from _silver_technical import dq_violations_udf, write_quarantine  # noqa: E402

ORDER_LINE_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line"
TABLE_NAME = "silver_product"

_COLUMNS = """
          brand_id             string    NOT NULL,
          product_key          string    NOT NULL,
          currency_code        string    NOT NULL,
          sku                  string,
          title                string,
          order_count          bigint    NOT NULL,
          units_sold           bigint,
          gross_revenue_minor  bigint,
          discount_minor       bigint,
          first_sold_at        timestamp,
          last_sold_at         timestamp,
          updated_at           timestamp NOT NULL
""".strip("\n")


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(256, brand_id)",
    )

    spark.read.table(ORDER_LINE_TABLE).createOrReplaceTempView("silver_order_line")

    agg_sql = """
        with lines as (
            select
                *,
                coalesce(nullif(product_id, ''), nullif(sku, ''), 'unknown') as product_key
            from silver_order_line
            where currency_code is not null
        )
        select
            brand_id,
            product_key,
            currency_code,
            max(sku)                    as sku,
            max(title)                  as title,
            count(distinct order_id)    as order_count,
            sum(quantity)               as units_sold,
            sum(line_total_minor)       as gross_revenue_minor,
            sum(line_discount_minor)    as discount_minor,
            min(occurred_at)            as first_sold_at,
            max(occurred_at)            as last_sold_at,
            current_timestamp()         as updated_at
        from lines
        group by brand_id, product_key, currency_code
    """
    # ── Stage-1 DQ gate (currency only — see module docstring): non-ISO-4217 currency → quarantine ────
    gated = spark.sql(agg_sql).withColumn(
        "_dq",
        dq_violations_udf()(lit(None).cast("bigint"), col("currency_code"), lit(None).cast("string")),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            lit("silver_order_line").alias("source"),
            col("product_key").alias("bronze_event_id"),
            lit(TABLE_NAME).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            to_json(struct("brand_id", "product_key", "currency_code", "gross_revenue_minor")).alias("payload"),
        ),
        stage="dq",
    )
    gated.where(size(col("_dq")) == 0).drop("_dq").createOrReplaceTempView("silver_product_new")

    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING silver_product_new s
        ON t.brand_id = s.brand_id AND t.product_key = s.product_key AND t.currency_code = s.currency_code
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[silver_product] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("silver-product")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)


if __name__ == "__main__":
    main()
