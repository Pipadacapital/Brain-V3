"""
silver_product_variant.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_product_variant.py.

The per-variant catalogue grain — variant id / sku / price / inventory, one row per sellable variant —
distinct from silver_product (the per-(brand,product_key) sales rollup). Folds product.upsert.v1 events
out of the gated collector lane (rest.brain_silver.silver_collector_event, ADR-0006 P3; the Spark job's
BRONZE_TABLE resolves to the same gated keystone) into rest.brain_silver.silver_product_variant, via an
idempotent MERGE on (brand_id, product_id, variant_id).

MULTI-STOREFRONT (mappers emit DIFFERENT shapes onto the SAME event_name):
  - SHOPIFY: properties.variants[] = [{ variant_id, sku, title, price_minor, inventory_quantity }] — a
    true variant array → EXPLODE into one row per variant.
  - WOOCOMMERCE: FLAT shape — top-level { sku, price_minor, stock_quantity } and NO variants[] → the
    product itself is its single variant (variant_id := product_id).
  This job handles BOTH: explode variants[] when present; otherwise synthesize one variant row from the
  product-level sku/price/stock so every storefront normalizes to the variant grain.

GRAIN : 1 row per (brand_id, product_id, variant_id). variant_id = storefront variant id when present,
        else product_id (woo flat → variant_id == product_id).
MONEY : price_minor is bigint MINOR units. product.upsert.v1 carries NO currency_code on the payload
        (catalogue price is in the store's currency); currency_code is honest-NULL (resolved downstream),
        not fabricated. brand_id is the tenant key, first column + bucket() partition anchor.
PII   : none — catalogue metadata only.

DATA AVAILABILITY: Bronze may hold ZERO product.upsert.v1 rows (product resource unsynced) — this job
then writes a correct EMPTY table over the current keystone; a Shopify/Woo product repull populates it
with no code change. Parity status=NEW (no dbt/StarRocks product_variant baseline).

STAGE-1 GATE (Brain V4): the Spark job runs a Stage-1 DQ gate over occurred_at (future/unparseable),
  diverting failures to brain_silver.silver_quarantine (stage='dq') and NOT writing them; the other dq
  rules are N/A by design (price_minor has NO sibling currency_code → the money gate would false-positive;
  inventory can be legitimately NEGATIVE → the quantity gate must not divert it; product_id/variant_id are
  structurally non-null). This DuckDB port has no _silver_technical analogue, so — matching the framework's
  other ports — it does NOT write the quarantine side-table and does NOT re-implement the dq drop; Bronze
  keeps the originals (replay-safe) for a separate rebuild. The mart's own admission (product_id present;
  shopify variants exploded / woo flat requires a flat_sku) is preserved. Good rows are identical.

Parity target: brain_silver.silver_product_variant.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_product_variant_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_product_variant{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

PRODUCT_EVENT = "product.upsert.v1"

_COLUMNS_SQL = """
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

COLUMNS = [
    "brand_id", "product_id", "variant_id", "source", "sku", "title",
    "price_minor", "inventory_quantity", "currency_code", "occurred_at", "ingested_at",
]


def _item(path: str) -> str:
    """Leaf field of the per-variant item JSON (the unnested variants[] element) as a string —
    DuckDB equivalent of Spark get_json_object(item, '$.<path>')."""
    return f"json_extract_string(item, '$.{path}')"


def build(con):
    ensure_table(con, TARGET, _COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

    # ── latest product.upsert.v1 event per (brand_id, product_id) — distinct catalogue states are distinct
    # Bronze rows (updated_at folded into the dedup id); keep the most-recent (occurred_at DESC, event_id DESC). ──
    latest_product = f"""
      SELECT brand_id, event_id, occurred_at, ingested_at, source, product_id,
             variants_json, flat_sku, flat_price_minor, flat_stock
      FROM (
        SELECT
          brand_id, event_id, occurred_at, ingested_at,
          {prop('pj','source')}         AS source,
          {prop('pj','product_id')}     AS product_id,
          {prop('pj','variants')}       AS variants_json,
          {prop('pj','sku')}            AS flat_sku,
          {prop('pj','price_minor')}    AS flat_price_minor,
          {prop('pj','stock_quantity')} AS flat_stock,
          row_number() OVER (
            PARTITION BY brand_id, {prop('pj','product_id')}
            ORDER BY occurred_at DESC, event_id DESC
          ) AS rn
        FROM ({read_gated_events_sql([PRODUCT_EVENT])})
        WHERE {prop('pj','product_id')} IS NOT NULL
      ) p
      WHERE p.rn = 1
    """

    # ── SHOPIFY branch: explode the variants[] array into one row per variant. unnest(from_json(json,
    # '["json"]')) yields one `item` per element — DuckDB analogue of lateral view explode(from_json(..)). ──
    shopify_exploded = f"""
      SELECT brand_id, event_id, source, product_id, occurred_at, ingested_at,
             unnest(from_json(CAST(coalesce(variants_json, '[]') AS JSON), '["json"]')) AS item
      FROM ({latest_product})
    """
    shopify_variants = f"""
      SELECT
        brand_id, event_id, product_id,
        coalesce({_item('variant_id')}, product_id) AS variant_id,
        source,
        {_item('sku')}                AS sku,
        {_item('title')}              AS title,
        {_item('price_minor')}        AS price_minor_raw,
        {_item('inventory_quantity')} AS inventory_quantity_raw,
        occurred_at, ingested_at
      FROM ({shopify_exploded})
    """

    # ── WOOCOMMERCE (flat) branch: no variants[] → synthesize ONE variant from product-level fields.
    # variant_id := product_id. Guard: only products WITHOUT a non-empty variants array AND with a flat_sku. ──
    woo_flat = f"""
      SELECT
        brand_id, event_id, product_id,
        product_id                    AS variant_id,
        source,
        flat_sku                      AS sku,
        CAST(NULL AS VARCHAR)         AS title,
        flat_price_minor              AS price_minor_raw,
        flat_stock                    AS inventory_quantity_raw,
        occurred_at, ingested_at
      FROM ({latest_product})
      WHERE (variants_json IS NULL
             OR json_array_length(CAST(coalesce(variants_json, '[]') AS JSON)) = 0)
        AND flat_sku IS NOT NULL
    """

    # ── union + regexp-guarded BIGINT typing (never float/fail; price signed, inventory signed — both
    # rlike '^-?[0-9]+$' verbatim) + dedup on the variant grain (occurred_at DESC, ingested_at DESC). ──
    typed = f"""
      SELECT
        brand_id, product_id, variant_id, source, sku, title,
        CASE WHEN regexp_full_match(price_minor_raw,        '^-?[0-9]+$') THEN CAST(price_minor_raw AS BIGINT)        ELSE NULL END AS price_minor,
        CASE WHEN regexp_full_match(inventory_quantity_raw, '^-?[0-9]+$') THEN CAST(inventory_quantity_raw AS BIGINT) ELSE NULL END AS inventory_quantity,
        CAST(NULL AS VARCHAR)           AS currency_code,
        CAST(occurred_at AS TIMESTAMP)  AS occurred_at,
        CAST(ingested_at AS TIMESTAMP)  AS ingested_at
      FROM (
        ({shopify_variants})
        UNION ALL BY NAME
        ({woo_flat})
      )
    """

    # PK (brand_id, product_id, variant_id). merge_on_pk folds the Spark defensive dedup
    # (partition by grain, order by occurred_at DESC, ingested_at DESC) into its in-batch dedup.
    return merge_on_pk(con, TARGET, typed, COLUMNS, ["brand_id", "product_id", "variant_id"],
                       order_by_desc=["occurred_at", "ingested_at"])


if __name__ == "__main__":
    run_job("silver-product-variant", build, target_table="silver_product_variant")
