"""
gold_executive_metrics.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_executive_metrics.py.

GOLD mart (not a Bronze/keystone read): READS the sibling Silver Iceberg table
{CATALOG}.brain_silver.silver_order_state directly and rolls it up to the executive mart
{CATALOG}.brain_gold.gold_executive_metrics via an idempotent MERGE on the mart PK.

THE TRANSFORM (byte/minor-unit exact — reproduced verbatim from the Spark rollup_sql, itself the
dbt gold_executive_metrics.sql):
    select brand_id, currency_code,
           count(order_id)                                              as total_orders,
           cast(sum(order_value_minor) as bigint)                       as realized_value_minor,
           cast(count(distinct brain_id) as bigint)                     as distinct_customers,
           cast(sum(case when is_terminal then 1 else 0 end) as bigint) as terminal_orders,
           cast(sum(case when lifecycle_state='delivered' then 1 else 0 end) as bigint) as delivered_orders,
           ... rto / cancelled / refunded ...,
           'live' as data_source, current_timestamp() as updated_at
    from silver_order_state
    where currency_code is not null
    group by brand_id, currency_code

GRAIN / PK: exactly one row per (brand_id, currency_code) — the mart PK.
MONEY: realized_value_minor = Σ(order_value_minor) as BIGINT MINOR units, per (brand, currency) — NEVER
  blended across currencies (GROUP BY currency_code isolates it). Paired with currency_code on-row.
  brand_id is the tenant key, first column. No float ever touches money.
ADDITIVE ONLY (ADR-004): only additive COMPONENTS are stored — non-additive ratios (AOV, RTO%) are derived
  at read by the metric-engine, NOT here. Mirrors the Spark job: no ratios computed.
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, currency_code) — re-running over the same Silver restates the
  same rows (UPDATE) and inserts new (brand, currency) pairs. data_source is hard-coded 'live'.

FULL RECOMPUTE vs Spark's entity-incremental wrapper: the Spark job wraps the identical GROUP BY in
  run_entity_incremental (a SCALING optimization — recompute only brands with new events, each over full
  history, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is parity-equivalent: the MERGE
  on the mart PK is idempotent and restates every (brand, currency) to the current Silver aggregate.

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver).

Parity target: brain_gold.gold_executive_metrics.
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

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_executive_metrics_duckdb_test
# instead of the live mart (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_executive_metrics{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"

# Column contract — byte-for-byte the Spark mart's _COLUMNS (dbt output projection). brand_id tenant key
# first; money = bigint minor + currency.
COLUMNS_SQL = """
  brand_id             string    NOT NULL,
  currency_code        string    NOT NULL,
  total_orders         bigint    NOT NULL,
  realized_value_minor bigint,
  distinct_customers   bigint    NOT NULL,
  terminal_orders      bigint,
  delivered_orders     bigint,
  rto_orders           bigint,
  cancelled_orders     bigint,
  refunded_orders      bigint,
  data_source          string    NOT NULL,
  updated_at           timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "currency_code", "total_orders", "realized_value_minor", "distinct_customers",
    "terminal_orders", "delivered_orders", "rto_orders", "cancelled_orders", "refunded_orders",
    "data_source", "updated_at",
]


def build(con):
    # brand-first tenant partitioning + per-currency bucketing (mirrors Spark bucket(4, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(4, brand_id)")

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ─────────────────────────
    #   GRAIN = entity_fold: MANY silver_order_state rows aggregate into ONE (brand_id, currency_code) mart
    #   row whose totals (total_orders, realized_value_minor, distinct_customers, …) depend on the entity's
    #   FULL order history — including source rows BELOW the watermark. Windowing the fold input directly
    #   would silently drop history → wrong money/counts. So we window ONLY to DISCOVER which (brand,
    #   currency) pairs changed (a source row was (re-)written since the last run), then re-fold each changed
    #   pair over its FULL, UNWINDOWED history. The MERGE on the PK (brand_id, currency_code) upserts exactly
    #   those restated rollups.
    #   CLOCK: silver_order_state has NO top-level ingested_at column (its COLUMNS_SQL exposes only the
    #   NOW-stamped write clock `updated_at` + business/rollup timestamps). It is an ENTITY mart, so the
    #   arrival/write clock is `updated_at` — exactly "which order-state rows were rewritten since last run".
    #   This job flips on GOLD_INCREMENTAL (Gold tier), INDEPENDENTLY of SILVER_INCREMENTAL.
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below is
    #   BYTE-IDENTICAL to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-executive-metrics", SOURCE, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # the source's write clock otherwise. Same entity guard as the fold (currency_code IS NOT NULL).
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    src_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: (brand_id, currency_code) pairs whose source rows changed within [lo, hi], using the
    # SAME key + currency-NOT-NULL guard the fold uses. Built ONLY when incremental (lo not None).
    changed = f"""
      SELECT DISTINCT brand_id, currency_code
      FROM {SOURCE}
      WHERE currency_code IS NOT NULL{src_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed (brand, currency)
    # pairs so each re-folds over its ENTIRE history. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        f"        AND (brand_id, currency_code) IN (SELECT brand_id, currency_code FROM ({changed}))\n"
        if lo is not None else ""
    )

    # ── the dbt/Spark aggregation, reproduced verbatim (additive components only, per (brand, currency)) ──
    rollup = f"""
      SELECT
        brand_id,
        currency_code,
        CAST(count(order_id) AS BIGINT)                                                      AS total_orders,
        CAST(sum(order_value_minor) AS BIGINT)                                               AS realized_value_minor,
        CAST(count(DISTINCT brain_id) AS BIGINT)                                             AS distinct_customers,
        CAST(sum(CASE WHEN is_terminal THEN 1 ELSE 0 END) AS BIGINT)                         AS terminal_orders,
        CAST(sum(CASE WHEN lifecycle_state = 'delivered' THEN 1 ELSE 0 END) AS BIGINT)       AS delivered_orders,
        CAST(sum(CASE WHEN lifecycle_state = 'rto'       THEN 1 ELSE 0 END) AS BIGINT)       AS rto_orders,
        CAST(sum(CASE WHEN lifecycle_state = 'cancelled' THEN 1 ELSE 0 END) AS BIGINT)       AS cancelled_orders,
        CAST(sum(CASE WHEN lifecycle_state = 'refunded'  THEN 1 ELSE 0 END) AS BIGINT)       AS refunded_orders,
        CAST('live' AS VARCHAR)                                                              AS data_source,
        now() AT TIME ZONE 'UTC'                                                             AS updated_at
      FROM {SOURCE}
      WHERE currency_code IS NOT NULL
{refold_filter}      GROUP BY brand_id, currency_code
    """

    # Idempotent MERGE on the (brand_id, currency_code) PK — replay-safe restatement. The GROUP BY already
    # yields one row per PK, so the in-batch dedup order_by is a stable no-op tie-break.
    return merge_on_pk(con, TARGET, rollup, COLUMNS,
                       ["brand_id", "currency_code"],
                       order_by_desc=["updated_at", "total_orders"])


if __name__ == "__main__":
    # The watermark tracks the source's write clock (silver_order_state.updated_at) — this Gold mart folds a
    # sibling Silver mart, and silver_order_state exposes no top-level ingested_at, so `updated_at` is its
    # arrival/write clock.
    run_job("gold-executive-metrics", build, target_table="gold_executive_metrics",
            source_table=SOURCE, ts_col="updated_at")
