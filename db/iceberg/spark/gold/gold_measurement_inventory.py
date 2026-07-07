"""
gold_measurement_inventory.py — SPEC:C.2.6 OPTIONAL inventory-MOVEMENT fact (Brain V4 Wave C).

Inventory MOVEMENT events derived from the point-in-time level history in brain_silver.silver_inventory_level
(product.upsert.v1 → per-variant stock observations). A movement = the delta between consecutive stock
observations for a (product, variant): movement_qty = quantity − prev_quantity. Append-only fact + derived
current-state Trino view (mv_gold_measurement_inventory).

FLAG-GATED PER BRAND (§0.5 / SPEC:C.2.6): OPTIONAL — emitted ONLY for brands whose `measurement.inventory_movement`
flag is ON (default OFF, fail-closed via _platform_flags.is_flag_enabled). A brand with the flag OFF
contributes ZERO movement rows (byte-identical to pre-wave). No money (stock is a count, never money).

GRAIN/KEY: (brand_id, product_id, variant_id, event_id) where event_id = sha2(brand, product, variant,
observed_at) — deterministic per observation, idempotent MERGE. The FIRST observation of a variant has
prev_quantity = NULL and movement_qty = NULL (no prior baseline — honest, not fabricated as the full stock).

DATA NOTE: silver_inventory_level is EMPTY live (product resource unsynced) → this writes a correct EMPTY
fact; it populates once a product/inventory sync lands AND the flag is enabled for the brand.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver, silver_exists  # noqa: E402
from _platform_flags import FLAG_MEASUREMENT_INVENTORY_MOVEMENT, is_flag_enabled  # noqa: E402

TABLE = "gold_measurement_inventory"

COLUMNS_SQL = """
          brand_id         string    NOT NULL,
          product_id       string    NOT NULL,
          variant_id       string    NOT NULL,
          event_id         string    NOT NULL,
          observed_at      timestamp NOT NULL,
          prev_quantity    bigint,
          quantity         bigint,
          movement_qty     bigint,
          source           string,
          source_event_id  string,
          updated_at       timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), days(observed_at)")

    if not silver_exists(spark, "silver_inventory_level"):
        return fqtn, spark.table(fqtn).count()

    # Flag gate (driver-side): only brands with measurement.inventory_movement ON participate.
    src = spark.sql(f"SELECT DISTINCT brand_id FROM {silver('silver_inventory_level')}")
    brands = [r["brand_id"] for r in src.collect() if r["brand_id"]]
    enabled = [b for b in brands if is_flag_enabled(b, FLAG_MEASUREMENT_INVENTORY_MOVEMENT)]
    if not enabled:
        print("[gold_measurement_inventory] no brand has measurement.inventory_movement ON → empty fact", flush=True)
        return fqtn, spark.table(fqtn).count()

    in_list = ", ".join("'" + b.replace("'", "''") + "'" for b in enabled)
    staged = spark.sql(
        f"""
        WITH lvl AS (
            SELECT brand_id, product_id, variant_id, observed_at,
                   cast(inventory_quantity AS bigint) AS quantity, source,
                   lag(cast(inventory_quantity AS bigint)) OVER (
                       partition by brand_id, product_id, variant_id ORDER BY observed_at
                   ) AS prev_quantity
            FROM {silver('silver_inventory_level')}
            WHERE brand_id IN ({in_list})
        )
        SELECT
            brand_id, product_id, variant_id,
            sha2(concat_ws('\\0', brand_id, product_id, variant_id, cast(observed_at as string)), 256) AS event_id,
            observed_at, prev_quantity, quantity,
            CASE WHEN prev_quantity IS NULL THEN NULL ELSE quantity - prev_quantity END AS movement_qty,
            source,
            sha2(concat_ws('\\0', brand_id, product_id, variant_id, cast(observed_at as string)), 256) AS source_event_id,
            current_timestamp() AS updated_at
        FROM lvl
        """
    )
    merge_on_pk(spark, fqtn, staged, ["brand_id", "product_id", "variant_id", "event_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-measurement-inventory", build)
