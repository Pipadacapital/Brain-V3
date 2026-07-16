"""
gold_utm_source.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_utm_source.py.

NET-NEW Gold `utm_source` mart (Brain V4, P3): the UTM / acquisition-SOURCE matrix. ONE row per
(brand_id, source, medium), folding the journey grain (silver_touchpoint first-touch utm), the order
spine (silver_order_state revenue) and the customer 360 (gold_customer_360 lifetime value / repeat) onto
the FIRST-touch source/medium of each visitor. A visitor (and the orders + customer they become) is
credited to the utm source/medium of their EARLIEST touch.

READS the sibling Silver Iceberg tables {CATALOG}.brain_silver.silver_touchpoint /
{CATALOG}.brain_silver.silver_order_state and the OPTIONAL sibling Gold {CATALOG}.brain_gold.gold_customer_360
DIRECTLY (NOT the gated collector keystone / raw Bronze), exactly as the Spark job reads them via
spark.table(). Writes {CATALOG}.brain_gold.gold_utm_source via an idempotent MERGE on the mart PK.

GRAIN / PK (verbatim Spark): exactly 1 row per (brand_id, source, medium). brand_id is the tenant key,
  FIRST column + pk[0]. source = first-touch utm_source, medium = first-touch utm_medium — honest-empty
  dims ('' / NULL) collapse to 'unknown' via COALESCE(NULLIF(x,''),'unknown') so no blank axes.

COLUMNS (byte-for-byte the Spark COLUMNS_SQL order/types):
  visitors        — distinct brain_anon_id whose FIRST touch carries this (source, medium).
  conversions     — distinct orders in an attributed visitor's journey, credited to first-touch src/medium.
  revenue_minor   — Σ silver_order_state.order_value_minor of those orders, bigint MINOR units.
  avg_ltv_minor   — AVG gold_customer_360.lifetime_value_minor of customers acquired via this src/medium.
  repeat_rate_pct — % of those acquired customers with >=2 lifetime orders (integer 0-100).
  currency_code   — the group's dominant currency.

MONEY (V4 rule 5): revenue_minor + avg_ltv_minor are bigint MINOR units + a sibling currency_code, summed/
  averaged strictly WITHIN a single (dominant) currency per group — NEVER blended across currencies. No
  float touches money. brand_id first.

RATE MATH (parity — IMPORTANT): unlike the truncating CAST-to-bigint marts, the Spark job here uses
  EXPLICIT `ROUND(...)` — `CAST(ROUND(AVG(lifetime_value_minor)) AS bigint)` and
  `CAST(ROUND(repeat_n * 100.0 / cust_n) AS int)`. DuckDB `CAST(ROUND(x) AS BIGINT/INT)` rounds-to-nearest
  identically (round-half-away-from-zero on both engines for these non-negative operands), so `ROUND(...)`
  is reproduced VERBATIM here — NOT the `//` floor-division used by the truncating-CAST ports. The
  `100.0` keeps the ratio in floating math exactly as Spark does before ROUND (no early integer floor).

DOMINANT CURRENCY (verbatim): both revenue and ltv pick one currency per (brand,source,medium) group via
  ROW_NUMBER() OVER (... ORDER BY <weight> DESC, currency_code ASC) WHERE rn = 1 — so revenue_minor and
  avg_ltv_minor never blend currencies. currency_code = COALESCE(r.currency_code, l.ltv_currency_code).

gold_customer_360 OPTIONAL: if that sibling Gold mart is absent (cold first cycle) the LTV CTE degrades
  to an empty set (avg_ltv_minor / repeat_rate_pct fall to 0) and the visitors/conversions/revenue matrix
  still builds — same fail-safe as the Spark _table_exists / _ltv_cte branch.

IDEMPOTENT / REPLAY-SAFE: full recompute from Silver(+sibling Gold) each run, MERGE-UPDATE'd on the
  (brand_id, source, medium) PK — re-running over the same inputs yields identical rows. The Spark job
  wraps the identical SQL in a PARTITION-INCREMENTAL driver (recompute only changed brands, each over full
  history, then the SAME MERGE) — a full-scan recompute here is parity-equivalent (the MERGE on the mart
  PK is idempotent and restates every group to the current aggregate). The GROUP BY already yields one row
  per PK, so the in-batch dedup order_by is a stable no-op tie-break.

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (reads already-gated Silver/Gold);
  the DuckDB framework never writes a quarantine table either. Nothing to skip.

Parity target: brain_gold.gold_utm_source (48 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_utm_source_duckdb_test
# instead of the live mart (parallel run -> compare -> cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_utm_source{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
# The customer-360 Iceberg Gold mart (sibling). OPTIONAL source — absent → avg_ltv_minor / repeat_rate_pct
# fall to 0; the rest of the matrix still builds (parity with the Spark _table_exists degradation).
CUSTOMER_360_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_customer_360"

# Column contract — byte-for-byte the Spark COLUMNS_SQL. brand_id tenant key first; money = bigint minor.
COLUMNS_SQL = """
  brand_id        string    NOT NULL,
  source          string    NOT NULL,
  medium          string    NOT NULL,
  visitors        bigint    NOT NULL,
  conversions     bigint    NOT NULL,
  revenue_minor   bigint    NOT NULL,
  avg_ltv_minor   bigint    NOT NULL,
  repeat_rate_pct int       NOT NULL,
  currency_code   string,
  updated_at      timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "source", "medium", "visitors", "conversions", "revenue_minor",
    "avg_ltv_minor", "repeat_rate_pct", "currency_code", "updated_at",
]


def _table_exists(con, fq: str) -> bool:
    """True iff the (optional) sibling table is readable — mirrors the Spark _table_exists probe. Absent →
    the caller uses the empty ltv CTE so the job never hard-depends on Gold->Gold refresh ordering."""
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent → caller degrades gracefully (empty ltv)
        return False


def _ltv_cte(con) -> str:
    """LTV / repeat CTE folded onto each visitor's first-touch (source, medium) via the stitched_brain_id
    bridge into gold_customer_360. Verbatim port of the Spark _ltv_cte. If that sibling Gold mart is absent,
    return an EMPTY ltv CTE (avg_ltv / repeat_rate stay 0). References the `first_touch` CTE defined ahead
    of it in the WITH list.

    RATE MATH: ROUND(...) is reproduced VERBATIM (Spark uses explicit ROUND here, not a truncating CAST) —
    AVG(lifetime_value_minor) rounded to a bigint minor unit, and repeat_n*100.0/cust_n rounded to an int %.
    """
    if _table_exists(con, CUSTOMER_360_TABLE):
        return f"""
        cust AS (
            -- per-customer LTV, credited to the visitor's FIRST-touch source/medium (stitched_brain_id bridge)
            SELECT
                ft.brand_id, ft.source, ft.medium,
                c.lifetime_value_minor,
                c.lifetime_orders,
                COALESCE(NULLIF(c.currency_code, ''), 'unknown') AS currency_code
            FROM first_touch ft
            JOIN {CUSTOMER_360_TABLE} c
              ON c.brand_id = ft.brand_id AND c.brain_id = ft.stitched_brain_id
            WHERE ft.stitched_brain_id IS NOT NULL AND ft.stitched_brain_id <> ''
              AND c.lifetime_value_minor IS NOT NULL
        ),
        ltv_by_cur AS (
            SELECT
                brand_id, source, medium, currency_code,
                CAST(ROUND(AVG(lifetime_value_minor)) AS bigint)                         AS avg_ltv_minor,
                CAST(COUNT(*) AS bigint)                                                 AS cust_n,
                CAST(SUM(CASE WHEN COALESCE(lifetime_orders, 0) >= 2 THEN 1 ELSE 0 END) AS bigint) AS repeat_n
            FROM cust
            GROUP BY brand_id, source, medium, currency_code
        ),
        ltv AS (
            -- dominant currency per group (a brand transacts in one currency -> no cross-currency blend)
            SELECT brand_id, source, medium, ltv_currency_code, avg_ltv_minor, repeat_rate_pct
            FROM (
                SELECT
                    brand_id, source, medium,
                    currency_code AS ltv_currency_code,
                    avg_ltv_minor,
                    CASE WHEN cust_n > 0 THEN CAST(ROUND(repeat_n * 100.0 / cust_n) AS int) ELSE 0 END AS repeat_rate_pct,
                    ROW_NUMBER() OVER (PARTITION BY brand_id, source, medium ORDER BY cust_n DESC, currency_code ASC) AS lrn
                FROM ltv_by_cur
            ) WHERE lrn = 1
        )
        """
    # No customer-360 yet -> empty ltv (correct schema); avg_ltv_minor / repeat_rate_pct fall to 0.
    return """
        ltv AS (
            SELECT CAST(NULL AS string) AS brand_id, CAST(NULL AS string) AS source,
                   CAST(NULL AS string) AS medium, CAST(NULL AS string) AS ltv_currency_code,
                   CAST(0 AS bigint) AS avg_ltv_minor, CAST(0 AS int) AS repeat_rate_pct
            WHERE 1 = 0
        )
        """


def build(con):
    # brand-first tenant partitioning (mirrors the Spark bucket(16, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(16, brand_id)")

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-BRAND REFOLD ─────────────────────────
    #   GRAIN = entity_fold: MANY silver_touchpoint rows fold — via each visitor's FIRST-touch utm — into
    #   ONE (brand_id, source, medium) matrix row whose visitors/conversions/revenue depend on the FULL
    #   touchpoint history, INCLUDING rows below the watermark. The fold aggregates on (brand_id, source,
    #   medium) but a VISITOR (brand_id, brain_anon_id) is the moving unit — its first-touch source/medium
    #   can change, MOVING it between (source, medium) groups. A MERGE-only restatement can never DECREMENT
    #   the abandoned group, so we CANNOT key the refold on the visitor. We refold at the BRAND grain — the
    #   Spark partition-incremental unit (its driver "recompute[s] only changed brands, each over full
    #   history, then the SAME MERGE"): a windowed read discovers which BRANDS had a touchpoint change since
    #   the last run, then EVERY (source, medium) group of each changed brand is recomputed over that brand's
    #   COMPLETE touchpoint history (all visitors re-read → intra-brand group-membership shifts captured).
    #   The fold-driving source is silver_touchpoint; it carries NO ingested_at — its arrival/write clock is
    #   the NOW-stamped updated_at (rule 2), exactly "which touchpoint rows changed since last run".
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below is
    #   BYTE-IDENTICAL to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-utm-source", TOUCHPOINT, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # silver_touchpoint's write clock otherwise.
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    tp_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-BRAND set: brands whose touchpoint spine changed within [lo, hi], using the SAME brand guard
    # the fold uses (brand_id NOT NULL). Built ONLY when incremental (lo not None).
    changed = f"""
      SELECT DISTINCT brand_id
      FROM {TOUCHPOINT}
      WHERE brand_id IS NOT NULL{tp_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history touchpoint scans to only changed brands
    # so every (source, medium) group of each changed brand refolds over that brand's ENTIRE touchpoint
    # history. EMPTY when lo is None → unwindowed full recompute. Applied identically to BOTH touchpoint
    # base scans (ft, visitor_orders) so the two stay a consistent per-brand slice.
    refold_filter = (
        f"              AND brand_id IN (SELECT brand_id FROM ({changed}))\n"
        if lo is not None else ""
    )

    # ── the full first-touch attribution matrix, reproduced verbatim from the Spark staged SQL ──
    staged = f"""
        WITH ft AS (
            -- rank each visitor's touches; rn=1 = the FIRST touch (its utm source/medium + resolved ids)
            SELECT
                brand_id,
                brain_anon_id,
                COALESCE(NULLIF(utm_source, ''), 'unknown') AS source,
                COALESCE(NULLIF(utm_medium, ''), 'unknown') AS medium,
                stitched_brain_id,
                ROW_NUMBER() OVER (
                    PARTITION BY brand_id, brain_anon_id
                    ORDER BY CASE WHEN is_first_touch THEN 0 ELSE 1 END, occurred_at ASC, touch_seq ASC
                ) AS rn
            FROM {TOUCHPOINT}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
{refold_filter}        ),
        first_touch AS (
            SELECT brand_id, brain_anon_id, source, medium, stitched_brain_id FROM ft WHERE rn = 1
        ),
        visitors AS (
            SELECT brand_id, source, medium, CAST(COUNT(DISTINCT brain_anon_id) AS bigint) AS visitors
            FROM first_touch
            GROUP BY brand_id, source, medium
        ),
        visitor_orders AS (
            -- any touch carrying a stitched order = an order in that visitor's journey
            SELECT DISTINCT brand_id, brain_anon_id, stitched_order_id AS order_id
            FROM {TOUCHPOINT}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
              AND stitched_order_id IS NOT NULL AND stitched_order_id <> ''
{refold_filter}        ),
        attributed_orders AS (
            -- credit each order to its visitor's FIRST-touch source/medium
            SELECT ft.brand_id, ft.source, ft.medium, vo.order_id
            FROM first_touch ft
            JOIN visitor_orders vo
              ON vo.brand_id = ft.brand_id AND vo.brain_anon_id = ft.brain_anon_id
        ),
        conv AS (
            SELECT brand_id, source, medium, CAST(COUNT(DISTINCT order_id) AS bigint) AS conversions
            FROM attributed_orders
            GROUP BY brand_id, source, medium
        ),
        order_rev AS (
            SELECT
                ao.brand_id, ao.source, ao.medium,
                COALESCE(NULLIF(os.currency_code, ''), 'unknown') AS currency_code,
                os.order_value_minor,
                ao.order_id
            FROM attributed_orders ao
            JOIN {ORDER_STATE} os
              ON os.brand_id = ao.brand_id AND os.order_id = ao.order_id
            WHERE os.order_value_minor IS NOT NULL
        ),
        rev_by_cur AS (
            SELECT brand_id, source, medium, currency_code,
                   CAST(SUM(order_value_minor) AS bigint) AS revenue_minor
            FROM order_rev
            GROUP BY brand_id, source, medium, currency_code
        ),
        rev AS (
            -- dominant currency per group (revenue summed WITHIN a single currency — never blended)
            SELECT brand_id, source, medium, currency_code, revenue_minor
            FROM (
                SELECT brand_id, source, medium, currency_code, revenue_minor,
                       ROW_NUMBER() OVER (PARTITION BY brand_id, source, medium ORDER BY revenue_minor DESC, currency_code ASC) AS crn
                FROM rev_by_cur
            ) WHERE crn = 1
        ),
        {_ltv_cte(con)}
        SELECT
            v.brand_id,
            v.source,
            v.medium,
            v.visitors,
            COALESCE(c.conversions, 0)                              AS conversions,
            COALESCE(r.revenue_minor, 0)                           AS revenue_minor,
            COALESCE(l.avg_ltv_minor, 0)                           AS avg_ltv_minor,
            COALESCE(l.repeat_rate_pct, 0)                         AS repeat_rate_pct,
            COALESCE(r.currency_code, l.ltv_currency_code)         AS currency_code,
            now() AT TIME ZONE 'UTC'                               AS updated_at
        FROM visitors v
        LEFT JOIN conv c ON c.brand_id = v.brand_id AND c.source = v.source AND c.medium = v.medium
        LEFT JOIN rev  r ON r.brand_id = v.brand_id AND r.source = v.source AND r.medium = v.medium
        LEFT JOIN ltv  l ON l.brand_id = v.brand_id AND l.source = v.source AND l.medium = v.medium
    """

    # Idempotent MERGE on the (brand_id, source, medium) PK — replay-safe restatement. The GROUP BY already
    # yields one row per PK, so the in-batch dedup order_by is a stable no-op tie-break.
    return merge_on_pk(con, TARGET, staged, COLUMNS,
                       ["brand_id", "source", "medium"],
                       order_by_desc=["updated_at", "visitors"])


if __name__ == "__main__":
    # The watermark tracks the touchpoint spine's write clock (silver_touchpoint.updated_at) — this Gold
    # mart folds sibling Silver/Gold marts, not the gated collector keystone. silver_touchpoint carries no
    # ingested_at, so its NOW-stamped updated_at is the arrival/write clock (rule 2).
    run_job("gold-utm-source", build, target_table="gold_utm_source",
            source_table=TOUCHPOINT, ts_col="updated_at")
