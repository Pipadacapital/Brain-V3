"""
silver_order_line.py — Brain V4 Phase 1 (Spark Silver, dual-run). GROUP=orders.

Reimplements db/dbt/models/marts/silver_order_line.sql (a thin pass-through over
stg_order_line_events.sql) as a Spark job reading Iceberg Bronze and writing
Iceberg brain_silver.silver_order_line — BESIDE the dbt→StarRocks copy (dual-run, NON-BREAKING).

FOLDED TRANSFORM (stg_order_line_events.sql, the bronze_source='iceberg' branch — the prod path):
  1. From Bronze collector_events WHERE event_type LIKE 'order.%' AND line_items array non-empty,
     pick the LATEST order event per (brand_id, order_id) (occurred_at desc, event_id desc).
  2. UNNEST its payload.properties.line_items array → one row per line.
  3. line_index = a DETERMINISTIC content-ordered row_number (StarRocks has no WITH ORDINALITY):
     order by sku, variant_id, unit_price_minor, quantity, title, <full item json>. 1..N, stable.
  4. Type money + quantity to BIGINT minor units with a regexp guard (non-numeric → 0, never float).
  5. Defensive dedup on (brand_id, order_id, line_index), occurred_at desc.

GRAIN: 1 row per (brand_id, order_id, line_index). MONEY: unit_price_minor / line_total_minor /
line_discount_minor are BIGINT minor units + currency_code. brand_id is the tenant key, first column.
IDEMPOTENT: MERGE on the (brand_id, order_id, line_index) PK.

NOTE on line_index parity (engine difference, documented): StarRocks `cast(item as string)` serializes
the JSON item with StarRocks' canonical key order/spacing; Spark `to_json(item)` uses Spark's. When two
lines tie on (sku, variant_id, unit_price_minor, quantity, title) the FINAL tiebreak (the serialized
item) can order differently between engines → line_index 1↔2 may swap for byte-identical-on-the-leading-
keys lines. line_index is a grain disambiguator, never a business value (dbt's own header says so), so
the line CONTENT is identical; only the index label may differ on exact-tie lines.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession

from iceberg_base import (  # noqa: E402
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.collector_events"
TABLE_NAME = "silver_order_line"

_COLUMNS = """
          brand_id             string    NOT NULL,
          order_id             string    NOT NULL,
          line_index           bigint    NOT NULL,
          sku                  string,
          title                string,
          quantity             bigint,
          unit_price_minor     bigint,
          line_total_minor     bigint,
          line_discount_minor  bigint,
          product_id           string,
          variant_id           string,
          currency_code        string,
          occurred_at          timestamp
""".strip("\n")


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(256, brand_id)",
    )

    spark.read.table(BRONZE_TABLE).createOrReplaceTempView("bronze_events")

    # ── latest order.* event per (brand_id, order_id) with a non-empty line_items array ──
    latest_order = """
        select brand_id, event_id, occurred_at, order_id, currency_code, line_items_json
        from (
            select
                brand_id, event_id, occurred_at,
                coalesce(get_json_object(payload, '$.properties.order_id'),
                         get_json_object(payload, '$.order_id'))               as order_id,
                get_json_object(payload, '$.properties.currency_code')         as currency_code,
                get_json_object(payload, '$.properties.line_items')            as line_items_json,
                row_number() over (
                    partition by brand_id,
                                 coalesce(get_json_object(payload, '$.properties.order_id'),
                                          get_json_object(payload, '$.order_id'))
                    order by occurred_at desc, event_id desc
                ) as rn
            from bronze_events
            where event_type like 'order.%'
              and get_json_object(payload, '$.properties.line_items') is not null
              and size(from_json(get_json_object(payload, '$.properties.line_items'),
                                 'array<string>')) > 0
        ) l
        where l.rn = 1
    """
    spark.sql(latest_order).createOrReplaceTempView("latest_order")

    # ── unnest line_items → one row per line; content-ordered deterministic line_index ──
    # Each array element is parsed as a JSON string item; get_json_object extracts the leaf fields.
    unnest_sql = """
        with exploded as (
            select
                l.brand_id, l.order_id, l.currency_code, l.occurred_at,
                item
            from latest_order l
            lateral view explode(from_json(l.line_items_json, 'array<string>')) e as item
        )
        select
            brand_id, order_id, currency_code, occurred_at,
            row_number() over (
                partition by brand_id, order_id
                order by get_json_object(item, '$.sku'),
                         get_json_object(item, '$.variant_id'),
                         get_json_object(item, '$.unit_price_minor'),
                         get_json_object(item, '$.quantity'),
                         get_json_object(item, '$.title'),
                         item
            ) as line_index,
            get_json_object(item, '$.sku')                              as sku,
            get_json_object(item, '$.title')                            as title,
            coalesce(get_json_object(item, '$.quantity'), '0')          as quantity_raw,
            coalesce(get_json_object(item, '$.unit_price_minor'), '0')  as unit_price_minor_raw,
            coalesce(get_json_object(item, '$.line_total_minor'), '0')  as line_total_minor_raw,
            coalesce(get_json_object(item, '$.line_discount_minor'), '0') as line_discount_minor_raw,
            get_json_object(item, '$.product_id')                       as product_id,
            get_json_object(item, '$.variant_id')                       as variant_id
        from exploded
    """
    spark.sql(unnest_sql).createOrReplaceTempView("lines_raw")

    # ── type (regexp-guarded BIGINT, never float/fail) + defensive dedup on the grain key ──
    typed_sql = """
        with typed as (
            select
                brand_id, order_id, line_index, sku, title,
                case when quantity_raw            rlike '^[0-9]+$'   then cast(quantity_raw as bigint)            else 0 end as quantity,
                case when unit_price_minor_raw    rlike '^-?[0-9]+$' then cast(unit_price_minor_raw as bigint)    else 0 end as unit_price_minor,
                case when line_total_minor_raw    rlike '^-?[0-9]+$' then cast(line_total_minor_raw as bigint)    else 0 end as line_total_minor,
                case when line_discount_minor_raw rlike '^-?[0-9]+$' then cast(line_discount_minor_raw as bigint) else 0 end as line_discount_minor,
                product_id, variant_id, currency_code,
                cast(occurred_at as timestamp) as occurred_at
            from lines_raw
        ),
        deduped as (
            select *,
                row_number() over (
                    partition by brand_id, order_id, line_index
                    order by occurred_at desc
                ) as _dedup_rn
            from typed
        )
        select
            brand_id, order_id, line_index, sku, title, quantity,
            unit_price_minor, line_total_minor, line_discount_minor,
            product_id, variant_id, currency_code, occurred_at
        from deduped
        where _dedup_rn = 1
    """
    spark.sql(typed_sql).createOrReplaceTempView("silver_order_line_new")

    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING silver_order_line_new s
        ON t.brand_id = s.brand_id AND t.order_id = s.order_id AND t.line_index = s.line_index
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[silver_order_line] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("silver-order-line")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)


if __name__ == "__main__":
    main()
