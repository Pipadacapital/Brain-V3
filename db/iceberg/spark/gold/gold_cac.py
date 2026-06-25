"""
gold_cac.py — Brain V4 Phase 2 (Spark Gold, dual-run). GROUP=executive+cac.

Reimplements the dbt model db/dbt/models/marts/gold_cac.sql as a Spark job that READS Iceberg
brain_silver.silver_customer (newly-acquired customers, first_seen_at) + brain_silver.silver_marketing_spend
(acquisition spend, stat_date/spend_minor) — both built by the Phase-1 Spark jobs — and WRITES Iceberg
brain_gold.gold_cac via an idempotent MERGE on the mart PK. It runs BESIDE the live dbt→StarRocks
brain_gold.gold_cac (dual-run, NON-BREAKING): repoints no reader, changes no dbt model, changes no app
code. ADDITIVE only.

THE dbt TRANSFORM (reproduced byte/minor-unit exact):
  new_customers = from silver_customer where first_seen_at is not null and currency_code is not null
                  group by brand_id, date_format(first_seen_at,'%Y-%m') as acquisition_month, currency_code
                    → count(*) as new_customers
  spend         = from silver_marketing_spend where stat_date is not null and currency_code is not null
                  group by brand_id, date_format(stat_date,'%Y-%m') as acquisition_month, currency_code
                    → sum(spend_minor) as acquisition_spend_minor
  result        = new_customers FULL OUTER JOIN spend on (brand_id, acquisition_month, currency_code):
                  coalesce keys; coalesce(new_customers,0); coalesce(acquisition_spend_minor,0);
                  data_source='live'; updated_at=current_timestamp()

GRAIN / PK: exactly one row per (brand_id, acquisition_month, currency_code) — the mart PK.
MONEY: acquisition_spend_minor = Σ(spend_minor) as bigint MINOR units, per (brand, month, currency) —
  NEVER blended across currencies (currency_code is in the GROUP BY + join key). Paired with currency_code
  on-row. brand_id is the tenant key, FIRST column.
ADDITIVE ONLY (ADR-004): exposes new_customers (COUNT) + acquisition_spend_minor (SUM). The CAC RATIO
  (spend ÷ new_customers, honest-null when new_customers=0) is NON-additive and is derived at READ by the
  metric-engine — NEVER precomputed here. We mirror that: no cac_minor / ratio computed in this job.
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, acquisition_month, currency_code) — re-running over the same
  Silver restates the same rows (UPDATE *) and inserts new (brand, month, currency) cells.

NOTE on the FULL OUTER JOIN: dbt date_format(x,'%Y-%m') → Spark date_format(x,'yyyy-MM') (identical
  zero-padded year-month string). The full outer join keeps months that have ONLY spend (no new customer)
  and months that have ONLY new customers (no spend) — the coalesce on each side gives 0 for the missing
  measure, exactly as the dbt model does.

Run via run-gold-executive-cac.sh (pure Iceberg read+write; no Kafka / no PG JDBC).
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import (  # noqa: E402 — sys.path tweak above
    CATALOG,
    GOLD_NAMESPACE,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

TABLE_NAME = "gold_cac"

# Sources: the Phase-1 Spark→Iceberg siblings (the dual-run tables the dbt path also reads).
SILVER_CUSTOMER = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"
SILVER_MARKETING_SPEND = f"{CATALOG}.{SILVER_NAMESPACE}.silver_marketing_spend"

# Column contract — byte-for-byte the dbt mart's output projection (verified against the live StarRocks
# DESC brain_gold.gold_cac). brand_id tenant key first; money = bigint minor + currency.
_COLUMNS = """
          brand_id                string    NOT NULL,
          acquisition_month       string    NOT NULL,
          currency_code           string    NOT NULL,
          new_customers           bigint,
          acquisition_spend_minor bigint,
          data_source             string    NOT NULL,
          updated_at              timestamp NOT NULL
""".strip("\n")


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        GOLD_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(8, brand_id)",
    )

    spark.read.table(SILVER_CUSTOMER).createOrReplaceTempView("silver_customer")
    spark.read.table(SILVER_MARKETING_SPEND).createOrReplaceTempView("silver_marketing_spend")

    # ── new_customers CTE: newly-acquired customers per brand × acquisition_month × currency ──
    spark.sql(
        """
        select
            brand_id,
            date_format(first_seen_at, 'yyyy-MM')  as acquisition_month,
            currency_code,
            count(*)                               as new_customers
        from silver_customer
        where first_seen_at is not null
          and currency_code is not null
        group by 1, 2, 3
        """
    ).createOrReplaceTempView("new_customers")

    # ── spend CTE: acquisition spend per brand × acquisition_month × currency (money = Σ minor) ──
    spark.sql(
        """
        select
            brand_id,
            date_format(stat_date, 'yyyy-MM')      as acquisition_month,
            currency_code,
            sum(spend_minor)                       as acquisition_spend_minor
        from silver_marketing_spend
        where stat_date is not null
          and currency_code is not null
        group by 1, 2, 3
        """
    ).createOrReplaceTempView("spend")

    # ── full outer join + coalesce (mirrors the dbt final select EXACTLY) ──
    result = spark.sql(
        """
        select
            coalesce(n.brand_id, s.brand_id)                          as brand_id,
            coalesce(n.acquisition_month, s.acquisition_month)        as acquisition_month,
            coalesce(n.currency_code, s.currency_code)                as currency_code,
            coalesce(n.new_customers, 0)                              as new_customers,
            coalesce(s.acquisition_spend_minor, 0)                    as acquisition_spend_minor,
            cast('live' as string)                                    as data_source,
            current_timestamp()                                       as updated_at
        from new_customers n
        full outer join spend s
            on  n.brand_id          = s.brand_id
            and n.acquisition_month = s.acquisition_month
            and n.currency_code     = s.currency_code
        """
    )
    result.createOrReplaceTempView("gold_cac_new")

    # Idempotent MERGE on the (brand_id, acquisition_month, currency_code) PK — replay-safe restatement.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING gold_cac_new s
        ON t.brand_id = s.brand_id
           AND t.acquisition_month = s.acquisition_month
           AND t.currency_code = s.currency_code
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[gold_cac] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("gold-cac")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)
    print("[gold_cac] DONE ✓", flush=True)


if __name__ == "__main__":
    main()
