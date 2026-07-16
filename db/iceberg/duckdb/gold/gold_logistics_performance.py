"""
gold_logistics_performance.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_logistics_performance.py.

NET-NEW gap Gold `logistics_performance` mart (Brain V4 Phase 2, GROUP "NEW gap Gold"). NO dbt predecessor.
The materialized delivery/RTO performance surface — one row per (brand_id, courier) holding the delivery +
RTO outcome counts and integer-bps rates over the brand's shipments, read DIRECTLY from the sibling Silver
Iceberg table {CATALOG}.brain_silver.silver_shipment (the latest-state-per-order shipment grain, folded
through the @brain/logistics-status terminal_class authority), UNIONED with a per-order fallback over
{CATALOG}.brain_silver.silver_fulfillment (storefront-side outcomes — see SOURCE below). Gold rollup of the
TS computeShipmentOutcomes signal, materialized per courier.

SOURCE : {CATALOG}.brain_silver.silver_shipment read DIRECTLY (not the gated keystone), UNIONED with a
  FALLBACK lane over {CATALOG}.brain_silver.silver_fulfillment (GAP-B, 2026-07-16). silver_shipment is the
  COURIER-side lane (Shiprocket) — for Shopify-native brands it is EMPTY, which left this mart empty even
  though the storefront-side fulfillment mart holds the delivery outcomes. The fallback lane admits a
  silver_fulfillment row ONLY when its (brand_id, order_id) has NO silver_shipment row (NOT EXISTS
  anti-join), so:
    - brands fully covered by courier data are BYTE-UNAFFECTED (every order is anti-joined away);
    - Shopify-only brands get their full fulfillment corpus;
    - mixed brands prefer the courier row per order (never double-counted).
  Reuses the framework's ensure_table / merge_on_pk / run_job.

FALLBACK STATUS MAP (Shopify fulfillment.shipment_status → this mart's outcome buckets):
    'delivered'                                   → terminal_class 'delivered' (is_terminal=true)
    'failure'                                     → terminal_class 'other'     (is_terminal=true)
    everything else — 'in_transit', 'out_for_delivery', 'confirmed', 'attempted_delivery',
    'label_printed', 'ready_for_pickup', NULL, …  → non-terminal (in_transit bucket)
  courier = COALESCE(NULLIF(tracking_company, ''), 'unknown') — same '' / NULL folding as the primary lane.
  RTO CAVEAT: Shopify has NO RTO concept — the fallback lane contributes rto=0 by construction, so for a
  cohort built purely from fulfillments resolved = delivered, delivery_rate_bps = 10000 and rto_rate_bps = 0.
  A true RTO rate REQUIRES courier-side data (silver_shipment); this is honest, not fabricated.

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

WATERMARK CLOCK (dual-source): the incremental clock must cover BOTH lanes — if it tracked only
  silver_shipment.updated_at, a Shopify-only estate (silver_shipment frozen) would pin `hi` below fresh
  fulfillment arrivals and the changed-set would never see them. So the watermark source is the UNION of
  silver_shipment.updated_at and silver_fulfillment.ingested_at (the fulfillment mart's arrival clock — it
  has no updated_at; ingested_at is refreshed by the latest-ingested-wins MERGE on every state change).

ORPHAN CAVEAT : the Spark job passes delete_orphans=True (per-brand entity-incremental recompute sheds a
  (brand_id, courier) group that has disappeared from Silver). The DuckDB framework merge_on_pk is
  UPDATE/INSERT-only (no DELETE), so a courier cohort that vanishes from Silver between runs would leave a
  stale row. Immaterial for a full-scan recompute over a stable corpus (the parity target is 2 rows); flagged
  for exact behavioral fidelity. GAP-B extends the same caveat to the fallback lane: if EVERY fulfillment of
  a cohort is displaced by newly-landed courier shipments (the NOT EXISTS flips for all its orders), the
  refold emits zero rows for that cohort and its stale row persists; a cohort displaced PARTIALLY restates
  correctly (the changed-set's displacement branch re-discovers it).

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
# FALLBACK lane (GAP-B): storefront-side fulfillments — admitted per-order only where SOURCE has no row.
FULFILLMENT_SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_fulfillment"
# The dual-source watermark clock (see docstring): max over BOTH lanes' arrival columns so `hi` can never
# lag behind fresh fulfillment writes on a courier-quiet estate. Passed to run_job/incremental_window as a
# derived table — both only ever do `SELECT max(<ts_col>) FROM {source}`.
CLOCK_SOURCE = (
    f"(SELECT updated_at FROM {SOURCE} "
    f"UNION ALL SELECT ingested_at AS updated_at FROM {FULFILLMENT_SOURCE}) _clk"
)

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
    #   CLOCK (dual-source): the primary lane's arrival/change key is silver_shipment.updated_at (a fresh
    #   now() on every write; the mart has no ingested_at) and the fallback lane's is
    #   silver_fulfillment.ingested_at (refreshed by its latest-ingested-wins MERGE on every state change).
    #   The watermark tracks max() over BOTH (CLOCK_SOURCE) so a courier-quiet estate can't pin `hi` below
    #   fresh fulfillment arrivals. This flips on GOLD_INCREMENTAL (Gold tier gate), INDEPENDENTLY of
    #   SILVER_INCREMENTAL. Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join
    #   → the SQL below is BYTE-IDENTICAL to the full recompute.
    lo, hi = incremental_window(con, "gold-logistics-performance", CLOCK_SOURCE, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicates as EMPTY strings when lo is None (byte-identical full scan); a [lo, hi] range over
    # each lane's arrival clock otherwise (ship = updated_at, ful = ingested_at, disp = the qualified
    # shipment clock inside the displacement join). Same entity-key guard as the fold (brand_id NOT NULL).
    def _win(col: str) -> str:
        w = []
        if lo is not None:
            w.append(f"{col} >= '{lo}'")
        if hi is not None:
            w.append(f"{col} <= '{hi}'")
        return f" AND {' AND '.join(w)}" if w else ""

    ship_window = _win("updated_at")
    ful_window = _win("ingested_at")
    disp_window = _win("s.updated_at")

    # CHANGED-KEY set: cohorts whose input set changed within [lo, hi], using the SAME derived courier keys
    # + brand_id-NOT-NULL guards the fold uses. THREE branches (built ONLY when incremental, lo not None):
    #   1. shipment lane   — a shipment row was (re-)written → its (brand, courier) cohort restates.
    #   2. fulfillment lane — a fulfillment row was (re-)landed → its (brand, tracking_company) cohort
    #      restates.
    #   3. DISPLACEMENT — a FRESH shipment row EVICTS the same (brand, order)'s fulfillment rows from the
    #      fallback lane (the NOT EXISTS flips), and the evicted rows may live under a DIFFERENT courier
    #      string (tracking_company ≠ courier), so that fulfillment-derived cohort must refold too or it
    #      would keep the displaced counts.
    changed = f"""
      SELECT DISTINCT brand_id, COALESCE(NULLIF(courier, ''), 'unknown') AS courier
      FROM {SOURCE}
      WHERE brand_id IS NOT NULL{ship_window}
      UNION
      SELECT DISTINCT brand_id, COALESCE(NULLIF(tracking_company, ''), 'unknown') AS courier
      FROM {FULFILLMENT_SOURCE}
      WHERE brand_id IS NOT NULL{ful_window}
      UNION
      SELECT DISTINCT f.brand_id, COALESCE(NULLIF(f.tracking_company, ''), 'unknown') AS courier
      FROM {FULFILLMENT_SOURCE} f
      JOIN {SOURCE} s
        ON s.brand_id = f.brand_id AND s.order_id = f.order_id{disp_window}
      WHERE f.brand_id IS NOT NULL
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed cohorts so each
    # re-folds over its ENTIRE (unioned) input set. EMPTY when lo is None → unwindowed full recompute.
    # Applied on the union CTE's already-derived courier key, so it matches the GROUP BY grain exactly.
    refold_filter = (
        "              AND (brand_id, courier) IN "
        f"(SELECT brand_id, courier FROM ({changed}))\n"
        if lo is not None else ""
    )

    staged = f"""
        WITH unioned AS (
            -- PRIMARY lane: courier-side shipment state (already folded through the terminal_class
            -- authority in Silver). Byte-identical to the pre-GAP-B read.
            SELECT
                brand_id,
                COALESCE(NULLIF(courier, ''), 'unknown')  AS courier,
                terminal_class,
                is_terminal
            FROM {SOURCE}
            WHERE brand_id IS NOT NULL

            UNION ALL

            -- FALLBACK lane (GAP-B): storefront fulfillments for orders with NO courier shipment row.
            -- Status map (see module docstring): delivered→'delivered', failure→'other' (terminal);
            -- everything else (in_transit/out_for_delivery/confirmed/attempted_delivery/NULL/…) is
            -- non-terminal → NULL class + is_terminal=false → the agg's in_transit bucket. Shopify has NO
            -- RTO concept: this lane contributes rto=0 by construction (courier data required for RTO).
            SELECT
                f.brand_id,
                COALESCE(NULLIF(f.tracking_company, ''), 'unknown') AS courier,
                CASE WHEN lower(f.shipment_status) = 'delivered' THEN 'delivered'
                     WHEN lower(f.shipment_status) = 'failure'   THEN 'other'
                     ELSE CAST(NULL AS VARCHAR) END                 AS terminal_class,
                CASE WHEN lower(f.shipment_status) IN ('delivered', 'failure') THEN TRUE
                     ELSE FALSE END                                 AS is_terminal
            FROM {FULFILLMENT_SOURCE} f
            WHERE f.brand_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM {SOURCE} s
                              WHERE s.brand_id = f.brand_id AND s.order_id = f.order_id)
        ),
        agg AS (
            SELECT
                brand_id,
                courier,
                CAST(COUNT(*) AS BIGINT)                                              AS shipments,
                CAST(SUM(CASE WHEN terminal_class = 'delivered' THEN 1 ELSE 0 END) AS BIGINT) AS delivered,
                CAST(SUM(CASE WHEN terminal_class = 'rto'       THEN 1 ELSE 0 END) AS BIGINT) AS rto,
                CAST(SUM(CASE WHEN terminal_class = 'other'     THEN 1 ELSE 0 END) AS BIGINT) AS other_terminal,
                -- In-transit = not resolved to a terminal class (the TS in_transit / 'none' bucket).
                CAST(SUM(CASE WHEN COALESCE(is_terminal, false) = false
                               OR terminal_class IS NULL
                               OR terminal_class IN ('none', '') THEN 1 ELSE 0 END) AS BIGINT) AS in_transit
            FROM unioned
            WHERE brand_id IS NOT NULL
{refold_filter}            GROUP BY brand_id, courier
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
    # The watermark tracks the DUAL-SOURCE clock (silver_shipment.updated_at ∪ silver_fulfillment.
    # ingested_at — see CLOCK_SOURCE), NOT the gated-keystone default: this Gold job re-folds two sibling
    # Silver marts and `hi` must cover fresh writes on EITHER lane.
    run_job("gold-logistics-performance", build, target_table="gold_logistics_performance",
            source_table=CLOCK_SOURCE, ts_col="updated_at")
