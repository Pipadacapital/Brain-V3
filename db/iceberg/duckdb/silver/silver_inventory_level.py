"""
silver_inventory_level.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_inventory_level.py.

The point-in-time stock-level grain — one row per (brand_id, product_id, variant_id, observed_at). Folds
product.upsert.v1 out of the gated keystone; each catalogue state (a new occurred_at) is its own stock
observation, so this is an append-style stock HISTORY (NOT collapsed to latest — the grain KEY includes
observed_at). Multi-storefront, mirroring silver_product_variant:
  - SHOPIFY: properties.variants[] = [{ variant_id, inventory_quantity }] → EXPLODE one row per variant.
  - WOOCOMMERCE: FLAT top-level stock_quantity (product is its single variant) → synthesize one, guarded by
    a non-empty variants array being absent AND a flat_sku present.

GRAIN : (brand_id, product_id, variant_id, observed_at). observed_at = the product.upsert.v1 occurred_at.
        variant_id = storefront variant id when present, else product_id.
MONEY : none — stock is a count. inventory_quantity is regexp-guarded BIGINT ('^-?[0-9]+$' — oversold/
        backorder can be legitimately negative), honest-NULL when the source omits it (never 0).
PII   : none. ISOLATION: brand_id first + bucket() anchor.

QUARANTINE SKIPPED: the Spark job runs a Stage-1 DQ timestamp gate over observed_at → silver_quarantine
  (stage='dq') before the MERGE (the money/quantity rules are N/A: no money; inventory can be negative).
  The migration framework has no quarantine seam, so — matching the other ports — this port does NOT write
  the side-table and does NOT re-implement the dq drop; Bronze keeps the originals (replay-safe). Mart
  admission (product_id present; shopify exploded / woo requires flat_sku) is preserved. Good rows identical.

DATA AVAILABILITY: Bronze holds ZERO product.upsert.v1 today (product resource unsynced), so this writes a
  correct EMPTY table; a Shopify/Woo product repull populates it with no code change.

Parity target: brain_silver.silver_inventory_level (NEW — no dbt/StarRocks baseline).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import (  # noqa: E402
    GATED_SOURCE,
    ensure_table,
    incremental_window,
    merge_on_pk,
    prop,
    read_gated_events_sql,
    run_job,
)
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_inventory_level_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_inventory_level{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

PRODUCT_EVENT = "product.upsert.v1"

COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  product_id          string    NOT NULL,
  variant_id          string    NOT NULL,
  observed_at         timestamp NOT NULL,
  source              string,
  sku                 string,
  inventory_quantity  bigint,
  ingested_at         timestamp
""".strip("\n")

COLUMNS = [
    "brand_id", "product_id", "variant_id", "observed_at", "source", "sku",
    "inventory_quantity", "ingested_at",
]


def _item(path: str) -> str:
    """Leaf field of the per-variant item JSON (the unnested variants[] element) as a string."""
    return f"json_extract_string(item, '$.{path}')"


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(observed_at)")

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1). Default OFF → (None, None) → full scan. Per-event
    #    grain (each product.upsert.v1 is its own observation via the idempotent MERGE), so windowing the
    #    gated-keystone read on ingested_at is safe. read_gated_events_sql omits the [lo,hi) predicate when
    #    lo/hi are None → the default-OFF SQL is byte-identical. ─────────────────────────────────────────
    lo, hi = incremental_window(con, "silver-inventory-level", GATED_SOURCE, ts_col="ingested_at")

    # ── base: every product.upsert.v1 is a point-in-time observation — do NOT collapse to latest here. ──
    base = f"""
      SELECT
        brand_id, event_id, occurred_at, ingested_at,
        {prop('pj','source')}         AS source,
        {prop('pj','product_id')}     AS product_id,
        {prop('pj','variants')}       AS variants_json,
        {prop('pj','sku')}            AS flat_sku,
        {prop('pj','stock_quantity')} AS flat_stock
      FROM ({read_gated_events_sql([PRODUCT_EVENT], lo=lo, hi=hi)})
      WHERE {prop('pj','product_id')} IS NOT NULL
    """

    # ── SHOPIFY: explode variants[] → one stock observation per variant. ──
    shopify_exploded = f"""
      SELECT brand_id, event_id, source, product_id, occurred_at, ingested_at,
             unnest(from_json(CAST(coalesce(variants_json, '[]') AS JSON), '["json"]')) AS item
      FROM ({base})
    """
    shopify_inv = f"""
      SELECT
        brand_id, event_id, product_id,
        coalesce({_item('variant_id')}, product_id) AS variant_id,
        source,
        {_item('sku')}                               AS sku,
        {_item('inventory_quantity')}                AS inventory_quantity_raw,
        occurred_at, ingested_at
      FROM ({shopify_exploded})
    """

    # ── WOOCOMMERCE (flat): synthesize one stock observation from product-level stock_quantity. ──
    woo_inv = f"""
      SELECT
        brand_id, event_id, product_id,
        product_id                                   AS variant_id,
        source,
        flat_sku                                     AS sku,
        flat_stock                                   AS inventory_quantity_raw,
        occurred_at, ingested_at
      FROM ({base})
      WHERE (variants_json IS NULL
             OR json_array_length(CAST(coalesce(variants_json, '[]') AS JSON)) = 0)
        AND flat_sku IS NOT NULL
    """

    # ── union → regexp-guarded BIGINT typing (never float/fail; inventory signed, '^-?[0-9]+$' verbatim) →
    # dedup latest-ingested on the full point-in-time grain. ──
    typed = f"""
      SELECT
        brand_id, product_id, variant_id,
        CAST(occurred_at AS TIMESTAMP)  AS observed_at,
        source, sku,
        CASE WHEN regexp_full_match(inventory_quantity_raw, '^-?[0-9]+$')
             THEN CAST(inventory_quantity_raw AS BIGINT) ELSE NULL END AS inventory_quantity,
        CAST(ingested_at AS TIMESTAMP)  AS ingested_at,
        event_id
      FROM (({shopify_inv}) UNION ALL BY NAME ({woo_inv}))
    """
    deduped = f"""
      SELECT {', '.join(COLUMNS)} FROM (
        SELECT *, row_number() OVER (
          PARTITION BY brand_id, product_id, variant_id, observed_at
          ORDER BY ingested_at DESC) AS _rn
        FROM ({typed})
      ) WHERE _rn = 1
    """

    return merge_on_pk(con, TARGET, deduped, COLUMNS,
                       ["brand_id", "product_id", "variant_id", "observed_at"],
                       order_by_desc=["ingested_at"])


if __name__ == "__main__":
    run_job("silver-inventory-level", build, target_table="silver_inventory_level")
