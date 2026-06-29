"""
gold_logistics_performance.py — NET-NEW gap Gold `logistics_performance` mart (Brain V4 Phase 2, GROUP "NEW gap Gold").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized delivery/RTO performance surface —
one row per (brand_id, courier) holding the delivery + RTO outcome counts and integer-bps rates over the
brand's shipments, read from Iceberg brain_silver.silver_shipment (the latest-state-per-order shipment
grain folded through the @brain/logistics-status terminal_class authority). This is the Gold rollup of the
TS computeShipmentOutcomes signal (shipment-outcomes.ts), materialized per courier.

Rates are integer basis points (no float — the metric-engine ratePct discipline): the RTO% denominator is
the RESOLVED base delivered+rto (in-transit / other are reported but excluded from the rate base), exactly
as the TS. A '' / NULL courier folds to 'unknown' so every shipment is attributed to a courier cohort.

GRAIN   : 1 row per (brand_id, courier). No money (delivery outcomes are counts — registered money_columns=[]).
          brand_id first column + partition anchor.
COLUMNS :
  shipments      — total shipments for this courier.
  delivered      — terminal_class='delivered'.
  rto            — terminal_class='rto'.
  other_terminal — terminal_class='other' (a resolved-but-neither outcome).
  in_transit     — non-terminal (terminal_class IS NULL / 'none' / is_terminal=false).
  resolved       — delivered + rto (the rate base).
  delivery_rate_bps — delivered * 10000 / resolved (integer bps; NULL when resolved=0).
  rto_rate_bps      — rto       * 10000 / resolved (integer bps; NULL when resolved=0).
REPLAY-SAFE: full recompute from Silver, MERGE-UPDATE'd on (brand_id, courier).
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_logistics_performance"

COLUMNS_SQL = """
          brand_id           string    NOT NULL,
          courier            string    NOT NULL,
          shipments          bigint    NOT NULL,
          delivered          bigint    NOT NULL,
          rto                bigint    NOT NULL,
          other_terminal     bigint    NOT NULL,
          in_transit         bigint    NOT NULL,
          resolved           bigint    NOT NULL,
          delivery_rate_bps  bigint,
          rto_rate_bps       bigint,
          updated_at         timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    staged = spark.sql(
        f"""
        WITH agg AS (
            SELECT
                brand_id,
                COALESCE(NULLIF(courier, ''), 'unknown')                              AS courier,
                COUNT(*)                                                              AS shipments,
                SUM(CASE WHEN terminal_class = 'delivered' THEN 1 ELSE 0 END)         AS delivered,
                SUM(CASE WHEN terminal_class = 'rto'       THEN 1 ELSE 0 END)         AS rto,
                SUM(CASE WHEN terminal_class = 'other'     THEN 1 ELSE 0 END)         AS other_terminal,
                -- In-transit = not resolved to a terminal class (the TS in_transit / 'none' bucket).
                SUM(CASE WHEN COALESCE(is_terminal, false) = false
                          OR terminal_class IS NULL
                          OR terminal_class IN ('none', '') THEN 1 ELSE 0 END)        AS in_transit
            FROM {silver('silver_shipment')}
            WHERE brand_id IS NOT NULL
            GROUP BY brand_id, COALESCE(NULLIF(courier, ''), 'unknown')
        )
        SELECT
            brand_id,
            courier,
            shipments,
            delivered,
            rto,
            other_terminal,
            in_transit,
            (delivered + rto)                                                        AS resolved,
            CASE WHEN (delivered + rto) > 0
                 THEN CAST(delivered AS bigint) * 10000 / (delivered + rto)
                 ELSE NULL END                                                       AS delivery_rate_bps,
            CASE WHEN (delivered + rto) > 0
                 THEN CAST(rto AS bigint) * 10000 / (delivered + rto)
                 ELSE NULL END                                                       AS rto_rate_bps,
            current_timestamp()                                                      AS updated_at
        FROM agg
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "courier"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-logistics-performance", build, entity_incremental={
        "table_name": "gold_logistics_performance", "source_tables": ["silver_shipment"],
    })
