"""
silver_inventory_level.py — GAP canonical Silver `inventory_level` entity (Brain V4 Phase 1b, GROUP storefront).

GAP table (matrix §1: product.upsert.v1 / inventory → silver_inventory_level — "per-variant stock"). The
point-in-time stock-level grain — one row per variant per catalogue state, so a reader can answer "what was
the on-hand stock for this variant at this moment" (powers stockout/replenishment recommendations) without
re-reading the whole product mart. Built as a Spark→Iceberg Silver job reading raw Iceberg Bronze, dual-run
BESIDE the dbt brain_silver (additive, non-breaking — no reader/dbt repoint).

SOURCE  : rest.brain_bronze.collector_events WHERE event_type = 'product.upsert.v1'
          SAME multi-storefront payload as silver_product_variant:
            - SHOPIFY: properties.variants[] = [{ variant_id, inventory_quantity }] — explode.
            - WOOCOMMERCE: FLAT top-level stock_quantity (the product is its single variant) — synthesize one.
          inventory_quantity is honest-null when the source omits it (the mapper passes null through, NOT 0).
GRAIN   : 1 row per (brand_id, product_id, variant_id, observed_at) — POINT-IN-TIME. observed_at = the
          product.upsert.v1 occurred_at (the catalogue-state timestamp). A NEW catalogue state (new updated_at)
          is a distinct Bronze row → a distinct inventory observation, so the table is an append-style stock
          history (latest-ingested-wins MERGE on the full grain keeps a re-pull idempotent per observation).
MONEY   : none — stock is a count (a bigint quantity), never money.
PII     : none — catalogue/stock metadata only.
ISOLATION: brand_id first column + the bucket() partition anchor (tenant key on every row).

DATA AVAILABILITY (this session): current Bronze has ZERO product.upsert.v1 rows (the product resource is
unsynced), so this writes a correct EMPTY table over current Bronze. Schema + transform are the deliverable;
a Shopify/Woo product repull populates it with no code change. Parity status=NEW (no dbt/StarRocks baseline).

STAGE-1 GATE (Brain V4 two-stage): after typing each stock observation but BEFORE the canonical MERGE,
  every row is run through the Stage-1 DQ gate _silver_technical.dq_check (via dq_violations_udf) on its
  observed_at (future / unparseable timestamp). observed_at is a NOT-NULL grain key, so an unparseable or
  implausibly-future stock timestamp is diverted to brain_silver.silver_quarantine (stage='dq', threading
  the source event_id + a JSON of the observation for a replayable quarantine row) and EXCLUDED from
  silver_inventory_level; Bronze keeps the original (replay-safe). The OTHER dq rules are N/A here: there
  is NO money (stock is a count, never money) so the money/currency gate does not apply; and
  inventory_quantity can be legitimately NEGATIVE (oversold/backorder) so impossible_quantity must not
  divert it; product_id/variant_id are structurally non-null (base filters product_id, variant_id
  coalesces to product_id). Good rows are byte-identical to before.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)
from pyspark.sql.functions import array_join, col, lit, size, struct, to_json  # noqa: E402
from _silver_technical import dq_violations_udf, write_quarantine  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{os.environ.get('SILVER_NAMESPACE', 'brain_silver')}.silver_collector_event"  # ADR-0006 P3: gated source (R2/R3 now in Silver)
TABLE_NAME = "silver_inventory_level"

_COLUMNS = """
          brand_id            string    NOT NULL,
          product_id          string    NOT NULL,
          variant_id          string    NOT NULL,
          observed_at         timestamp NOT NULL,
          source              string,
          sku                 string,
          inventory_quantity  bigint,
          ingested_at         timestamp
""".strip("\n")


def build(spark: SparkSession) -> tuple:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(256, brand_id), days(observed_at)",
    )

    spark.read.table(BRONZE_TABLE).createOrReplaceTempView("bronze_events")

    # Every product.upsert.v1 is a point-in-time observation — do NOT collapse to latest here (this mart
    # is the stock HISTORY); the grain key includes observed_at so each catalogue state is its own row.
    base = """
        select
            brand_id, event_id, occurred_at, ingested_at,
            get_json_object(payload, '$.properties.source')          as source,
            get_json_object(payload, '$.properties.product_id')      as product_id,
            get_json_object(payload, '$.properties.variants')        as variants_json,
            get_json_object(payload, '$.properties.sku')             as flat_sku,
            get_json_object(payload, '$.properties.stock_quantity')  as flat_stock
        from bronze_events
        where event_type = 'product.upsert.v1'
          and get_json_object(payload, '$.properties.product_id') is not null
    """
    spark.sql(base).createOrReplaceTempView("inv_base")

    # ── SHOPIFY: explode variants[] → one stock observation per variant ──
    shopify_inv = """
        with exploded as (
            select b.brand_id, b.event_id, b.source, b.product_id, b.occurred_at, b.ingested_at, item
            from inv_base b
            lateral view explode(from_json(coalesce(b.variants_json, '[]'), 'array<string>')) e as item
        )
        select
            brand_id, event_id, product_id,
            coalesce(get_json_object(item, '$.variant_id'), product_id)  as variant_id,
            source,
            get_json_object(item, '$.sku')                               as sku,
            get_json_object(item, '$.inventory_quantity')                as inventory_quantity_raw,
            occurred_at, ingested_at
        from exploded
    """
    spark.sql(shopify_inv).createOrReplaceTempView("inv_shopify")

    # ── WOOCOMMERCE (flat): synthesize one stock observation from product-level stock_quantity ──
    woo_inv = """
        select
            brand_id, event_id, product_id,
            product_id                                                   as variant_id,
            source,
            flat_sku                                                     as sku,
            flat_stock                                                   as inventory_quantity_raw,
            occurred_at, ingested_at
        from inv_base
        where (variants_json is null
               or size(from_json(coalesce(variants_json, '[]'), 'array<string>')) = 0)
          and flat_sku is not null
    """
    spark.sql(woo_inv).createOrReplaceTempView("inv_woo_flat")

    typed_sql = """
        with unioned as (
            select * from inv_shopify
            union all
            select * from inv_woo_flat
        ),
        typed as (
            select
                brand_id, event_id, product_id, variant_id,
                cast(occurred_at as timestamp)  as observed_at,
                source, sku,
                case when inventory_quantity_raw rlike '^-?[0-9]+$' then cast(inventory_quantity_raw as bigint) else null end as inventory_quantity,
                cast(ingested_at as timestamp)  as ingested_at
            from unioned
        ),
        deduped as (
            select *,
                row_number() over (
                    partition by brand_id, product_id, variant_id, observed_at
                    order by ingested_at desc
                ) as _rn
            from typed
        )
        select brand_id, product_id, variant_id, observed_at, source, sku, inventory_quantity, ingested_at, event_id
        from deduped
        where _rn = 1
    """
    # ── Stage-1 DQ gate: observed_at validity (future / unparseable) — see module docstring ───────────
    typed_df = spark.sql(typed_sql).withColumn(
        "_dq",
        dq_violations_udf()(lit(None).cast("bigint"), lit(None).cast("string"), col("observed_at").cast("string")),
    )
    write_quarantine(
        spark,
        typed_df.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            lit("product.upsert.v1").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE_NAME).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            to_json(struct("brand_id", "product_id", "variant_id", "observed_at", "inventory_quantity")).alias("payload"),
        ),
        stage="dq",
    )
    typed_df.where(size(col("_dq")) == 0).drop("_dq", "event_id").createOrReplaceTempView(
        "silver_inventory_level_new"
    )

    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING silver_inventory_level_new s
        ON t.brand_id = s.brand_id AND t.product_id = s.product_id
           AND t.variant_id = s.variant_id AND t.observed_at = s.observed_at
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[silver_inventory_level] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn, n


def main() -> None:
    spark = build_spark("silver-inventory-level")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)


if __name__ == "__main__":
    main()
