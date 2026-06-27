"""
silver_product_variant.py — GAP canonical Silver `product_variant` entity (Brain V4 Phase 1b, GROUP storefront).

GAP table (matrix §1: product.upsert.v1 variants → silver_product_variant). The per-variant catalogue
grain — variant id / sku / price / inventory — one row per sellable variant, distinct from silver_product
(the per-(brand,product_key) sales rollup). Built as a Spark→Iceberg Silver job reading raw Iceberg Bronze,
dual-run BESIDE the dbt brain_silver (additive, non-breaking — no reader/dbt repoint).

SOURCE  : rest.brain_bronze.collector_events WHERE event_type = 'product.upsert.v1'
          MULTI-STOREFRONT payload (mappers emit DIFFERENT shapes onto the SAME event_name):
            - SHOPIFY (@brain/shopify-mapper resources.ts::mapProductToDraft): properties.variants[] =
              [{ variant_id, sku, title, price_minor, inventory_quantity }] — a true variant array.
            - WOOCOMMERCE (@brain/woocommerce-mapper resources.ts::mapWooProductToDraft): FLAT shape —
              top-level { sku, price_minor, stock_quantity } and NO variants[] (the wc/v3 list endpoint
              returns variation IDs only), so the product itself is its single variant.
          This job handles BOTH: explode variants[] when present; otherwise synthesize one variant row
          from the product-level sku/price/stock so every storefront is normalized to the variant grain.
GRAIN   : 1 row per (brand_id, product_id, variant_id). variant_id = the storefront variant id when present,
          else the product_id (woo flat → variant_id == product_id, one variant per product).
MONEY   : price_minor is bigint MINOR units + currency_code. NOTE: product.upsert.v1 does NOT carry a
          currency_code on the payload (catalogue price is in the store's currency); we record price_minor
          honestly and set currency_code = NULL (a downstream join to the brand's primary currency resolves
          it) rather than fabricate one. brand_id is the tenant key, first column + bucket() partition anchor.
PII     : none — catalogue metadata only (no contact/financial identifier).

DATA AVAILABILITY (this session): current Bronze has ZERO product.upsert.v1 rows (the product resource is
unsynced; orders carry inline line_items but not the catalogue), so this writes a correct EMPTY table over
current Bronze. Schema + transform are the deliverable; a Shopify/Woo product repull populates it with no
code change. Parity status=NEW (no dbt/StarRocks product_variant baseline).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{os.environ.get('SILVER_NAMESPACE', 'brain_silver')}.silver_collector_event"  # ADR-0006 P3: gated source (R2/R3 now in Silver)
TABLE_NAME = "silver_product_variant"

_COLUMNS = """
          brand_id            string    NOT NULL,
          product_id          string    NOT NULL,
          variant_id          string    NOT NULL,
          source              string,
          sku                 string,
          title               string,
          price_minor         bigint,
          inventory_quantity  bigint,
          currency_code       string,
          occurred_at         timestamp,
          ingested_at         timestamp
""".strip("\n")


def build(spark: SparkSession) -> tuple:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(256, brand_id)",
    )

    spark.read.table(BRONZE_TABLE).createOrReplaceTempView("bronze_events")

    # ── latest product.upsert.v1 event per (brand_id, product_id) — distinct catalogue states are
    # distinct Bronze rows (updated_at folded into the dedup id); keep the most-recent state. ──
    latest_product = """
        select brand_id, event_id, occurred_at, ingested_at, source, product_id,
               variants_json, flat_sku, flat_price_minor, flat_stock
        from (
            select
                brand_id, event_id, occurred_at, ingested_at,
                get_json_object(payload, '$.properties.source')            as source,
                get_json_object(payload, '$.properties.product_id')        as product_id,
                get_json_object(payload, '$.properties.variants')          as variants_json,
                get_json_object(payload, '$.properties.sku')               as flat_sku,
                get_json_object(payload, '$.properties.price_minor')       as flat_price_minor,
                get_json_object(payload, '$.properties.stock_quantity')    as flat_stock,
                row_number() over (
                    partition by brand_id, get_json_object(payload, '$.properties.product_id')
                    order by occurred_at desc, event_id desc
                ) as rn
            from bronze_events
            where event_type = 'product.upsert.v1'
              and get_json_object(payload, '$.properties.product_id') is not null
        ) p
        where p.rn = 1
    """
    spark.sql(latest_product).createOrReplaceTempView("latest_product")

    # ── SHOPIFY branch: explode the variants[] array into one row per variant ──
    shopify_variants = """
        with exploded as (
            select
                p.brand_id, p.source, p.product_id, p.occurred_at, p.ingested_at, item
            from latest_product p
            lateral view explode(
                from_json(coalesce(p.variants_json, '[]'), 'array<string>')
            ) e as item
        )
        select
            brand_id, product_id,
            coalesce(get_json_object(item, '$.variant_id'), product_id)     as variant_id,
            source,
            get_json_object(item, '$.sku')                                  as sku,
            get_json_object(item, '$.title')                                as title,
            get_json_object(item, '$.price_minor')                          as price_minor_raw,
            get_json_object(item, '$.inventory_quantity')                   as inventory_quantity_raw,
            occurred_at, ingested_at
        from exploded
    """
    spark.sql(shopify_variants).createOrReplaceTempView("variants_shopify")

    # ── WOOCOMMERCE (flat) branch: no variants[] → synthesize ONE variant from product-level fields.
    # variant_id := product_id (one variant per product). Guard: only products WITHOUT a variants array. ──
    woo_flat = """
        select
            brand_id, product_id,
            product_id                                                      as variant_id,
            source,
            flat_sku                                                        as sku,
            cast(null as string)                                            as title,
            flat_price_minor                                                as price_minor_raw,
            flat_stock                                                      as inventory_quantity_raw,
            occurred_at, ingested_at
        from latest_product
        where (variants_json is null
               or size(from_json(coalesce(variants_json, '[]'), 'array<string>')) = 0)
          and flat_sku is not null
    """
    spark.sql(woo_flat).createOrReplaceTempView("variants_woo_flat")

    # ── union + regexp-guarded BIGINT typing (never float/fail) + dedup on the variant grain ──
    typed_sql = """
        with unioned as (
            select * from variants_shopify
            union all
            select * from variants_woo_flat
        ),
        typed as (
            select
                brand_id, product_id, variant_id, source, sku, title,
                case when price_minor_raw        rlike '^-?[0-9]+$' then cast(price_minor_raw as bigint)        else null end as price_minor,
                case when inventory_quantity_raw rlike '^-?[0-9]+$' then cast(inventory_quantity_raw as bigint) else null end as inventory_quantity,
                cast(null as string)            as currency_code,
                cast(occurred_at as timestamp)  as occurred_at,
                cast(ingested_at as timestamp)  as ingested_at
            from unioned
        ),
        deduped as (
            select *,
                row_number() over (
                    partition by brand_id, product_id, variant_id
                    order by occurred_at desc, ingested_at desc
                ) as _rn
            from typed
        )
        select brand_id, product_id, variant_id, source, sku, title,
               price_minor, inventory_quantity, currency_code, occurred_at, ingested_at
        from deduped
        where _rn = 1
    """
    spark.sql(typed_sql).createOrReplaceTempView("silver_product_variant_new")

    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING silver_product_variant_new s
        ON t.brand_id = s.brand_id AND t.product_id = s.product_id AND t.variant_id = s.variant_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[silver_product_variant] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn, n


def main() -> None:
    spark = build_spark("silver-product-variant")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)


if __name__ == "__main__":
    main()
