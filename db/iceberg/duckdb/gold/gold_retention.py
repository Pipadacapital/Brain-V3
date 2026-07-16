"""
gold_retention.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_retention.py.

NET-NEW gap Gold `retention` mart (NO dbt predecessor, parity status=NEW). One row per
(brand_id, cohort_month) holding, FOR THE CUSTOMERS ACQUIRED IN THAT MONTH, the deterministic
repeat-purchase / returning-customer / orders-per-customer roll-up. Same acquisition-cohort grain
as gold_cohorts so a retention curve and a cohort-value curve line up row-for-row.

GRAIN  : exactly 1 row per (brand_id, cohort_month). cohort_month = the acquisition period
         formatted 'yyyy-MM' from first_seen_at. currency_code is an AGGREGATE (max) inside the
         group, NOT a grouping key — EXACTLY the Spark MERGE key (brand_id, cohort_month).
SOURCE : Iceberg brain_silver.silver_customer — the brain_id-keyed additive customer rollup
         (lifetime_orders + first_seen_at + currency_code, one row per (brand_id, brain_id)),
         read DIRECTLY as {CATALOG}.brain_silver.silver_customer (a sibling Silver mart, not the
         gated collector keystone). Mirror of gold_cohorts.

COLUMNS (all additive components + integer-bps rates — NO money, NO float):
  cohort_customers            — customers acquired in the cohort (COUNT of brain_id rows).
  repeat_customers            — of those, the ones with lifetime_orders >= 2.
  total_orders                — Σ lifetime_orders across the cohort's customers.
  repeat_orders               — GREATEST(total_orders − cohort_customers, 0): orders beyond each
                                customer's first (acquiring) order = the returning purchases.
  repeat_purchase_rate_bps    — repeat_customers * 10000 / cohort_customers  (customer-weighted bps).
  returning_customer_rate_bps — repeat_orders   * 10000 / total_orders       (order-weighted bps;
                                NULL when total_orders = 0).
  avg_orders_per_customer_bps — total_orders    * 10000 / cohort_customers   (÷10000 at the read seam).

WHY bps not a ratio (V4 no-float rule): every rate is an EXACT integer basis-point (×10000 then
  truncate-to-bigint). The non-additive ratio is reconstituted at the metric-engine read seam,
  NEVER stored as a float. cohort_customers is a group COUNT (always >= 1 → no div-by-zero on the
  customer-weighted rates); the order-weighted rate guards total_orders > 0.

INTEGER-BPS SEMANTICS (parity — CRITICAL): Spark computes `CAST(a * 10000 / b AS bigint)`, where `/`
  yields a decimal and `CAST(... AS bigint)` TRUNCATES toward zero. DuckDB's `CAST(double AS BIGINT)`
  instead ROUNDS to nearest (12*10000/17 = 7058.8 → Spark 7058, DuckDB CAST 7059), which produced 16
  off-by-one bps mismatches. All operands here are non-negative counts, so Spark's truncate-toward-zero
  is exactly integer FLOOR division — reproduced with DuckDB's integer `//` operator (`a * 10000 // b`),
  which stays in integer arithmetic and matches Spark bit-for-bit on every non-negative input.

DATE FORMAT (parity): Spark `date_format(first_seen_at, 'yyyy-MM')` → DuckDB `strftime(ts, '%Y-%m')`.
  silver_customer.first_seen_at is a naive `timestamp` (Iceberg parity with the Spark UTC instants),
  so strftime renders the UTC wall-clock month directly — no TZ shift, checksum-safe.

NO MONEY: a retention mart is purely behavioral counts + integer-bps rates. currency_code is carried
  (max per cohort) only so a brand's cohort stays per-currency-consistent with gold_cohorts; it is a
  descriptor, never blended into a money sum.

NO QUARANTINE SIDE-WRITE: the Spark job has no Stage-1 quarantine divert for this mart (it reads an
  already-gated Silver rollup); there is nothing to skip. Consistent with the framework invariant
  (the DuckDB framework never writes a quarantine table).

REPLAY-SAFE: full recompute from Silver each run, MERGE-UPDATE'd on the (brand_id, cohort_month) PK.
  A full-overwrite in Spark is equivalent to an idempotent MERGE on the PK here (1 staged row per PK
  from the GROUP BY → re-run over the same Silver yields identical rows).

Parity target: brain_gold.gold_retention (30 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import (  # noqa: E402
    GOLD_INCREMENTAL,
    ensure_table,
    incremental_window,
    merge_on_pk,
    run_job,
)
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_retention_duckdb_test
# instead of the live table (parallel run -> compare -> cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_retention{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"

# Mirrors the Spark _gold_base COLUMNS_SQL order/types (bigint counts + integer-bps; no money column).
COLUMNS_SQL = """
  brand_id                       string    NOT NULL,
  cohort_month                   string    NOT NULL,
  currency_code                  string,
  cohort_customers               bigint    NOT NULL,
  repeat_customers               bigint    NOT NULL,
  total_orders                   bigint    NOT NULL,
  repeat_orders                  bigint    NOT NULL,
  repeat_purchase_rate_bps       bigint,
  returning_customer_rate_bps    bigint,
  avg_orders_per_customer_bps    bigint,
  updated_at                     timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "cohort_month", "currency_code", "cohort_customers", "repeat_customers",
    "total_orders", "repeat_orders", "repeat_purchase_rate_bps", "returning_customer_rate_bps",
    "avg_orders_per_customer_bps", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(4, brand_id)")

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1 — Gold tier, INDEPENDENT of SILVER_INCREMENTAL) ──
    #   GRAIN = entity_fold: MANY silver_customer rows aggregate into ONE (brand_id, cohort_month) cohort
    #   row whose counts/bps depend on the cohort's FULL customer membership — including customers whose
    #   silver_customer row sits BELOW the watermark. Windowing the fold input directly would drop cohort
    #   members → wrong cohort_customers / total_orders / rates. So we window ONLY to DISCOVER which cohorts
    #   changed (a customer rollup was restated since the last run — a new order bumped its updated_at, or a
    #   new customer was acquired), then re-fold each changed cohort over the FULL, UNWINDOWED customer set.
    #   The changed-set key derivation (brand_id, cohort_month = strftime(first_seen_at,'%Y-%m')) + the
    #   NOT-NULL guards are IDENTICAL to the fold below. The MERGE on the PK (brand_id, cohort_month) upserts
    #   exactly those restated cohorts. The fold-driving source is the sibling Silver mart silver_customer;
    #   it has no ingested_at, so the arrival/write clock is its entity `updated_at` (NOW-stamped on each
    #   rollup restatement = "which customers changed since last run"). Default OFF / first run / FULL_REFRESH
    #   → lo=None → NO changed-set, NO semi-join → the SQL below is byte-identical to the full recompute.
    lo, hi = incremental_window(con, "gold-retention", SOURCE, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # silver_customer's write clock otherwise. Same NOT-NULL guards as the fold (brand_id / first_seen_at).
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    customer_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: cohorts whose customer rollups changed within [lo, hi], using the SAME
    # (brand_id, cohort_month) key derivation + guards the fold uses. Built ONLY when incremental.
    changed = f"""
      SELECT DISTINCT brand_id, strftime(first_seen_at, '%Y-%m') AS cohort_month
      FROM {SOURCE}
      WHERE brand_id IS NOT NULL AND first_seen_at IS NOT NULL{customer_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-membership fold to only the changed cohorts so
    # each re-folds over its ENTIRE customer set. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        f"        AND (brand_id, strftime(first_seen_at, '%Y-%m')) IN "
        f"(SELECT brand_id, cohort_month FROM ({changed}))\n"
        if lo is not None else ""
    )

    # ── acquisition-cohort rollup over silver_customer (verbatim Spark WITH cohort AS (...)). ──
    # cohort_customers is a group COUNT (>= 1); repeat = lifetime_orders >= 2; total = Σ lifetime_orders.
    cohort = f"""
      SELECT
        brand_id,
        strftime(first_seen_at, '%Y-%m')                            AS cohort_month,
        max(currency_code)                                          AS currency_code,
        CAST(count(*) AS BIGINT)                                    AS cohort_customers,
        CAST(sum(CASE WHEN lifetime_orders >= 2 THEN 1 ELSE 0 END) AS BIGINT) AS repeat_customers,
        CAST(sum(coalesce(lifetime_orders, 0)) AS BIGINT)           AS total_orders
      FROM {SOURCE}
      WHERE brand_id IS NOT NULL AND first_seen_at IS NOT NULL
{refold_filter}      GROUP BY brand_id, strftime(first_seen_at, '%Y-%m')
    """

    # ── derive the integer-bps rates (verbatim CAST(a * 10000 / b AS bigint) truncate-toward-zero). ──
    staged = f"""
      SELECT
        brand_id,
        cohort_month,
        currency_code,
        cohort_customers,
        repeat_customers,
        total_orders,
        -- orders beyond each customer's first (acquiring) order = the returning purchases (>= 0).
        CAST(GREATEST(total_orders - cohort_customers, CAST(0 AS BIGINT)) AS BIGINT)  AS repeat_orders,
        -- customer-weighted repeat rate, integer bps (cohort_customers is a group COUNT, always >= 1).
        (repeat_customers * 10000 // cohort_customers)                                AS repeat_purchase_rate_bps,
        -- order-weighted returning rate, integer bps; NULL when no orders.
        CASE WHEN total_orders > 0
             THEN (GREATEST(total_orders - cohort_customers, CAST(0 AS BIGINT)) * 10000 // total_orders)
             ELSE NULL END                                                            AS returning_customer_rate_bps,
        -- avg lifetime orders per customer, integer bps (÷10000 at the read seam → e.g. 1.50).
        (total_orders * 10000 // cohort_customers)                                    AS avg_orders_per_customer_bps,
        now() AT TIME ZONE 'UTC'                                                      AS updated_at
      FROM ({cohort})
    """

    # Idempotent MERGE on the (brand_id, cohort_month) PK — replay-safe upsert (GROUP BY already yields
    # one row per PK; order_by_desc is a stable no-op tie-break, updated_at then cohort_month).
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "cohort_month"],
                       order_by_desc=["updated_at", "cohort_month"])


if __name__ == "__main__":
    # The watermark tracks the fold-driving source's write clock (silver_customer.updated_at), NOT the gated
    # keystone default — this Gold job reads a sibling Silver mart, not silver_collector_event.
    run_job("gold-retention", build, target_table="gold_retention",
            source_table=SOURCE, ts_col="updated_at")
