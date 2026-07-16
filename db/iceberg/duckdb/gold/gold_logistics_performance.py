"""
gold_logistics_performance.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_logistics_performance.py.

NET-NEW gap Gold `logistics_performance` mart (Brain V4 Phase 2, GROUP "NEW gap Gold"). NO dbt predecessor.
The materialized delivery/RTO performance surface — one row per (brand_id, courier) holding the delivery +
RTO outcome counts and integer-bps rates over the brand's shipments, read DIRECTLY from the sibling Silver
Iceberg table {CATALOG}.brain_silver.silver_shipment (the latest-state-per-order shipment grain, folded
through the @brain/logistics-status terminal_class authority). Gold rollup of the TS computeShipmentOutcomes
signal, materialized per courier.

SOURCE : {CATALOG}.brain_silver.silver_shipment read DIRECTLY (not the gated keystone). Reuses the framework's
  ensure_table / merge_on_pk / run_job.

GRAIN  : exactly 1 row per (brand_id, courier) — the mart PK. No money (delivery outcomes are counts;
  registered money_columns=[]). brand_id first column + partition anchor. A '' / NULL courier folds to
  'unknown' so every shipment is attributed to a courier cohort.

COLUMNS :
  shipments         — total shipments for this courier.
  delivered         — terminal_class='delivered'.
  rto               — terminal_class='rto'.
  other_terminal    — terminal_class='other' (a resolved-but-neither outcome).
  in_transit        — non-terminal (is_terminal=false OR terminal_class IS NULL / 'none' / '').
  resolved          — delivered + rto (the rate base).
  delivery_rate_bps — delivered * 10000 / resolved (INTEGER bps; NULL when resolved=0).
  rto_rate_bps      — rto       * 10000 / resolved (INTEGER bps; NULL when resolved=0).

RATE PARITY (no-float, integer bps — the metric-engine ratePct discipline): the RTO% denominator is the
  RESOLVED base delivered+rto (in-transit / other reported but EXCLUDED from the rate base), exactly as the
  TS. Spark computes `CAST(delivered AS bigint) * 10000 / (delivered+rto)` where integer `/` TRUNCATES toward
  zero; DuckDB `/` is float division, so we use integer division `//` to reproduce the truncation byte-exact.

REPLAY-SAFE : full recompute from Silver each run, idempotent MERGE-UPDATE on the (brand_id, courier) PK — a
  re-run over the same Silver restates every group.

ORPHAN CAVEAT : the Spark job passes delete_orphans=True (per-brand entity-incremental recompute sheds a
  (brand_id, courier) group that has disappeared from Silver). The DuckDB framework merge_on_pk is
  UPDATE/INSERT-only (no DELETE), so a courier cohort that vanishes from Silver between runs would leave a
  stale row. Immaterial for a full-scan recompute over a stable corpus (the parity target is 2 rows); flagged
  for exact behavioral fidelity.

QUARANTINE : none — the Spark job has NO Stage-1/quarantine side-write (this is a pure Silver→Gold rollup over
  already-gated Silver). No watermark table is read (source is a Silver mart, not the gated keystone) —
  run_job's best-effort watermark advance over the gated keystone is a harmless non-fatal no-op here.

Parity target: brain_gold.gold_logistics_performance (Spark) = 2 rows.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_logistics_performance_duckdb_test
# instead of the live Spark-owned mart (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_logistics_performance{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_shipment"

# Mirrors the Spark _COLUMNS order/types (NO money column, NO currency_code — pure delivery-outcome counts).
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

COLUMNS = [
    "brand_id", "courier", "shipments", "delivered", "rto", "other_terminal",
    "in_transit", "resolved", "delivery_rate_bps", "rto_rate_bps", "updated_at",
]


def build(con):
    # brand-first tenant partitioning (mirrors the Spark bucket(64, brand_id) hidden partitioning).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD (Phase 1b) ────────────────
    #   GRAIN = entity_fold: MANY silver_shipment rows aggregate into ONE (brand_id, courier) cohort row
    #   whose counts + integer-bps rates depend on the cohort's FULL shipment set — including rows BELOW the
    #   watermark. Windowing the aggregate input directly would silently drop shipments → wrong counts/rates.
    #   So we window ONLY to DISCOVER which cohorts changed (a shipment row got a fresh write clock since the
    #   last run), then re-fold each changed cohort over its FULL, UNWINDOWED shipment set. The MERGE on the
    #   PK (brand_id, courier) upserts exactly those restated rollups.
    #   CLOCK: silver_shipment has NO ingested_at (see its COLUMNS_SQL — only first_event_at + a now()-stamped
    #   run-clock updated_at); its physical arrival/change key is `updated_at` (every re-landed/changed
    #   shipment row gets a fresh now() on write) → ts_col='updated_at' tracks "which rows changed since last
    #   run". This flips on GOLD_INCREMENTAL (Gold tier gate), INDEPENDENTLY of SILVER_INCREMENTAL.
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below is
    #   BYTE-IDENTICAL to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-logistics-performance", SOURCE, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # the shipment mart's write clock otherwise. Same entity-key guard as the fold (brand_id NOT NULL).
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    ship_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: cohorts whose shipment set changed within [lo, hi], using the SAME derived courier key
    # (COALESCE(NULLIF(courier,''), 'unknown')) + brand_id-NOT-NULL guard the fold uses. Built ONLY when
    # incremental (lo not None).
    changed = f"""
      SELECT DISTINCT brand_id, COALESCE(NULLIF(courier, ''), 'unknown') AS courier
      FROM {SOURCE}
      WHERE brand_id IS NOT NULL{ship_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed cohorts so each
    # re-folds over its ENTIRE shipment set. EMPTY when lo is None → unwindowed full recompute. Applied on the
    # SAME derived courier key so it matches the GROUP BY grain exactly.
    refold_filter = (
        "              AND (brand_id, COALESCE(NULLIF(courier, ''), 'unknown')) IN "
        f"(SELECT brand_id, courier FROM ({changed}))\n"
        if lo is not None else ""
    )

    staged = f"""
        WITH agg AS (
            SELECT
                brand_id,
                COALESCE(NULLIF(courier, ''), 'unknown')                              AS courier,
                CAST(COUNT(*) AS BIGINT)                                              AS shipments,
                CAST(SUM(CASE WHEN terminal_class = 'delivered' THEN 1 ELSE 0 END) AS BIGINT) AS delivered,
                CAST(SUM(CASE WHEN terminal_class = 'rto'       THEN 1 ELSE 0 END) AS BIGINT) AS rto,
                CAST(SUM(CASE WHEN terminal_class = 'other'     THEN 1 ELSE 0 END) AS BIGINT) AS other_terminal,
                -- In-transit = not resolved to a terminal class (the TS in_transit / 'none' bucket).
                CAST(SUM(CASE WHEN COALESCE(is_terminal, false) = false
                               OR terminal_class IS NULL
                               OR terminal_class IN ('none', '') THEN 1 ELSE 0 END) AS BIGINT) AS in_transit
            FROM {SOURCE}
            WHERE brand_id IS NOT NULL
{refold_filter}            GROUP BY brand_id, COALESCE(NULLIF(courier, ''), 'unknown')
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
            -- integer bps (// = truncating integer division, matching Spark's CAST-int `/`); NULL base guard.
            CASE WHEN (delivered + rto) > 0
                 THEN CAST(delivered AS BIGINT) * 10000 // (delivered + rto)
                 ELSE NULL END                                                       AS delivery_rate_bps,
            CASE WHEN (delivered + rto) > 0
                 THEN CAST(rto AS BIGINT) * 10000 // (delivered + rto)
                 ELSE NULL END                                                       AS rto_rate_bps,
            now() AT TIME ZONE 'UTC'                                                 AS updated_at
        FROM agg
    """

    # Idempotent MERGE on the (brand_id, courier) PK. staged is already 1 row per PK (a GROUP BY upstream),
    # so order_by_desc = updated_at is a stable, deterministic no-op tie-break.
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "courier"],
                       order_by_desc=["updated_at"])


if __name__ == "__main__":
    # The watermark tracks the shipment mart's write clock (silver_shipment.updated_at — it has no
    # ingested_at), NOT the gated-keystone default: this Gold job re-folds a sibling Silver mart.
    run_job("gold-logistics-performance", build, target_table="gold_logistics_performance",
            source_table=SOURCE, ts_col="updated_at")
