"""
gold_revenue_analytics.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_revenue_analytics.py
(itself db/dbt/models/marts/gold_revenue_analytics.sql).

GOLD mart (not a Bronze/keystone read): READS the sibling Silver Iceberg table
{CATALOG}.brain_silver.silver_order_state directly and rolls it up to the revenue drill mart
{CATALOG}.brain_gold.gold_revenue_analytics via an idempotent MERGE on the mart PK. This is the
executive/revenue dashboard's drill source — realized revenue + order counts by month × lifecycle_state
× currency, per brand. It computes ONLY ADDITIVE aggregates (COUNT / SUM); non-additive ratios
(AOV / RTO% / growth) stay the metric-engine's job and are NOT computed here.

THE TRANSFORM (byte/minor-unit exact — reproduced verbatim from the Spark rollup_sql / the dbt SQL):
    select
        brand_id,
        date_format(state_effective_at, 'yyyy-MM')                    as period_month,
        lifecycle_state,
        currency_code,
        count(order_id)                                               as order_count,
        cast(sum(order_value_minor) as bigint)                        as realized_value_minor,
        cast(sum(case when is_terminal then 1 else 0 end) as bigint)  as terminal_order_count,
        current_timestamp()                                           as updated_at
    from silver_order_state
    where currency_code is not null
    group by brand_id, date_format(state_effective_at, 'yyyy-MM'), lifecycle_state, currency_code

GRAIN / PK: exactly one row per (brand_id, period_month, lifecycle_state, currency_code) — the mart PK.
  period_month = date_format(state_effective_at, 'yyyy-MM')  →  DuckDB strftime(state_effective_at, '%Y-%m').
  Session is UTC (set in _catalog.connect), so the month bucket derives from the UTC instant exactly as
  Spark's UTC-instant date_format does — no TZ drift in the bucket boundary.
MONEY: realized_value_minor = Σ(order_value_minor) as BIGINT MINOR units, per (brand, month, lifecycle,
  currency) — NEVER blended across currencies (GROUP BY currency_code + the currency_code IS NOT NULL
  filter isolate it). The SIGNED minor-unit value is carried STRAIGHT from Silver and SUMmed — no money
  re-derivation, no float ever touches it. Paired with currency_code on-row. brand_id is the tenant key,
  first column.
ADDITIVE ONLY (ADR-004): only additive COMPONENTS (order_count / realized_value_minor / terminal_order_count)
  are stored — mirrors the Spark job: no ratios computed.
IDEMPOTENT / REPLAY-SAFE: MERGE on the 4-col PK — re-running over the same Silver restates the same rows
  (UPDATE) and inserts new (brand, month, lifecycle, currency) tuples.

FULL RECOMPUTE vs Spark's entity-incremental wrapper: the Spark job wraps the identical GROUP BY in
  run_entity_incremental (a SCALING optimization — recompute only brands with new events, each over full
  history, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is parity-equivalent: the MERGE
  on the mart PK is idempotent and restates every (brand, month, lifecycle, currency) tuple to the current
  Silver aggregate (same rationale as gold_executive_metrics.py).

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver).

Parity target: brain_gold.gold_revenue_analytics.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_revenue_analytics_duckdb_test
# instead of the live mart (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_revenue_analytics{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"

# Column contract — byte-for-byte the Spark mart's _COLUMNS (dbt output projection). brand_id tenant key
# first; money = bigint minor + currency. Timestamp col is plain `timestamp` (framework GOLD convention).
COLUMNS_SQL = """
  brand_id              string    NOT NULL,
  period_month          string    NOT NULL,
  lifecycle_state       string    NOT NULL,
  currency_code         string    NOT NULL,
  order_count           bigint    NOT NULL,
  realized_value_minor  bigint,
  terminal_order_count  bigint,
  updated_at            timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "period_month", "lifecycle_state", "currency_code",
    "order_count", "realized_value_minor", "terminal_order_count", "updated_at",
]


def build(con):
    # brand-first tenant partitioning (mirrors the Spark bucket(256, brand_id) hidden partitioning).
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ─────────────────────────
    #   GRAIN = entity_fold: MANY silver_order_state rows aggregate into the mart's (brand_id, period_month,
    #   lifecycle_state, currency_code) rows. The Spark job's entity-incremental unit is the BRAND — every
    #   changed brand's ENTIRE set of month × lifecycle × currency buckets is re-aggregated, because a bucket's
    #   totals depend on order rows possibly BELOW the watermark. So we MUST NOT window the aggregate input
    #   directly (that would drop below-watermark orders → wrong money). Instead we window ONLY to DISCOVER
    #   which BRANDS changed (a silver_order_state row was (re)written since the last run), then re-aggregate
    #   each changed brand over its FULL, UNWINDOWED order history and MERGE-upsert exactly those buckets.
    #   The fold-driving source is silver_order_state; its ARRIVAL/WRITE clock is `updated_at` (a NOW-stamped
    #   write clock — silver_order_state has no top-level `ingested_at` column, only the business rollup
    #   `max_ingested_at`; `updated_at` is the "which rows changed since last run" clock). GOLD_INCREMENTAL
    #   flips this tier INDEPENDENTLY of Silver, so enabled=GOLD_INCREMENTAL is passed explicitly.
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the rollup SQL below
    #   is byte-identical to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-revenue-analytics", SOURCE, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over the
    # order spine's write clock otherwise. Each bound carries its own leading ` AND ` so lo=None → "".
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    source_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-BRAND set: brands whose order spine changed within [lo, hi]. Same currency_code IS NOT NULL
    # admission guard the fold uses (so a brand with only NULL-currency rows is not spuriously refolded).
    # Built ONLY when incremental (lo not None).
    changed = f"""
      SELECT DISTINCT brand_id
      FROM {SOURCE}
      WHERE currency_code IS NOT NULL{source_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history aggregate to only the changed brands so
    # each re-aggregates over its ENTIRE order history. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        f"\n        AND brand_id IN (SELECT brand_id FROM ({changed}))"
        if lo is not None else ""
    )

    # ── the dbt/Spark month × lifecycle × currency additive rollup, reproduced verbatim ──
    # date_format(state_effective_at, 'yyyy-MM')  →  strftime(state_effective_at, '%Y-%m'); UTC session
    # makes the month bucket derive from the UTC instant exactly as Spark's date_format does.
    rollup = f"""
      SELECT
        brand_id,
        strftime(state_effective_at, '%Y-%m')                                                AS period_month,
        lifecycle_state,
        currency_code,
        CAST(count(order_id) AS BIGINT)                                                       AS order_count,
        CAST(sum(order_value_minor) AS BIGINT)                                                AS realized_value_minor,
        CAST(sum(CASE WHEN is_terminal THEN 1 ELSE 0 END) AS BIGINT)                          AS terminal_order_count,
        now() AT TIME ZONE 'UTC'                                                              AS updated_at
      FROM {SOURCE}
      WHERE currency_code IS NOT NULL{refold_filter}
      GROUP BY
        brand_id,
        strftime(state_effective_at, '%Y-%m'),
        lifecycle_state,
        currency_code
    """

    # Idempotent MERGE on the (brand_id, period_month, lifecycle_state, currency_code) PK — replay-safe
    # restatement. The GROUP BY already yields one row per PK, so the in-batch dedup order_by is a stable
    # no-op tie-break.
    return merge_on_pk(con, TARGET, rollup, COLUMNS,
                       ["brand_id", "period_month", "lifecycle_state", "currency_code"],
                       order_by_desc=["updated_at", "order_count"])


if __name__ == "__main__":
    # The watermark tracks the order spine's write clock (silver_order_state.updated_at) — this Gold mart
    # reads a sibling Silver mart, not the gated keystone default.
    run_job("gold-revenue-analytics", build, target_table="gold_revenue_analytics",
            source_table=SOURCE, ts_col="updated_at")
