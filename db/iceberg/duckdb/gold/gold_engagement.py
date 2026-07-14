"""
gold_engagement.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_engagement.py.

NET-NEW gap Gold `engagement` mart (Brain V4 Phase 2, GROUP "NEW gap Gold products"). NO dbt
predecessor (parity status=NEW; matrix §3/4). The materialized UX-engagement-quality surface — one
row per (brand_id, engagement_date, signal_type) holding the daily count + page/session reach of each
first-party-pixel engagement signal (rage_click / dead_click / scroll_depth / element_clicked), read
from Iceberg brain_silver.silver_engagement_signal DIRECTLY (exactly like the Spark job reads it via
silver()). This is the Gold rollup of the friction/interaction grain the engagement dashboard reads.

THE TRANSFORM (verbatim from the Spark staged SQL):
    SELECT brand_id,
           CAST(occurred_at AS DATE)                    AS engagement_date,
           signal_type,
           COUNT(*)                                      AS signal_count,
           COUNT(DISTINCT session_id)                    AS sessions,
           COUNT(DISTINCT page)                          AS pages,
           -- integer-floored mean scroll milestone (scroll_depth only; NULL otherwise)
           CASE WHEN signal_type='scroll_depth'
                THEN CAST(SUM(COALESCE(scroll_pct,0)) / NULLIF(COUNT(scroll_pct),0) AS INT)
                ELSE NULL END                            AS avg_scroll_pct,
           current_timestamp()                          AS updated_at
    FROM silver_engagement_signal
    WHERE brand_id IS NOT NULL AND occurred_at IS NOT NULL
    GROUP BY brand_id, CAST(occurred_at AS DATE), signal_type

GRAIN / PK: 1 row per (brand_id, engagement_date, signal_type). engagement_date = occurred_at::date
  (UTC). signal_type is the pixel signal taxonomy (rage_click|dead_click|scroll_depth|element_clicked).
  NO money (a UX-quality marker — registered money_columns=[]). brand_id first + partition anchor.
COLUMNS :
  signal_count   — number of signals of this type in the day (COUNT(*)).
  sessions       — distinct session_id exhibiting this signal type in the day.
  pages          — distinct page the signal fired on.
  avg_scroll_pct — for scroll_depth: integer-FLOORED mean milestone percent (NULL for non-scroll types).
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on the PK. Idempotent.

TRUNCATION FIDELITY (Spark CAST-div vs DuckDB `/`): the Spark job computes
  CAST(SUM(scroll_pct) / NULLIF(COUNT(scroll_pct),0) AS INT). In Spark, `/` between ints yields a DOUBLE
  and CAST AS INT TRUNCATES toward zero. DuckDB's `/` is likewise true division, but CAST-to-INTEGER
  ROUNDS (half-to-even), NOT truncates — a half-milestone would diverge. To reproduce Spark's truncation
  exactly this port uses integer FLOOR division `//` (scroll_pct is non-negative, so floor == truncate),
  wrapped in the same scroll_depth guard, so avg_scroll_pct is byte-identical to the Spark oracle.

FULL RECOMPUTE vs Spark's entity-incremental wrapper: the Spark job wraps the identical GROUP BY in
  run_entity_incremental (a SCALING optimization — recompute only brands with new events over full
  history, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is parity-equivalent: the
  MERGE on the mart PK is idempotent and restates every (brand, date, signal_type) to the current
  Silver aggregate.

CAVEAT — orphan-shedding: the Spark job passes delete_orphans=True (WHEN NOT MATCHED BY SOURCE DELETE)
  so a full per-brand recompute sheds a disappeared group's Gold row. The DuckDB _base.merge_on_pk does
  NOT implement a not-matched-by-source DELETE — this port is MATCHED-UPDATE / NOT-MATCHED-INSERT only.
  For the parallel-run parity harness (fresh <table>_duckdb_test built from the same Silver) the
  admission set is identical; the divergence only surfaces after an upstream group disappears from
  Silver between runs. Noted, not silently dropped.

QUARANTINE : the Spark job has NO Stage-1/quarantine side-write here (it reads already-gated Silver).
  This framework has none either — nothing to skip.

Honors MIGRATION_TABLE_SUFFIX (→ gold_engagement_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_engagement (Spark oracle: 11 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_engagement_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_engagement"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_engagement_signal"

# Mirrors the Spark COLUMNS_SQL order/types exactly. No money (UX-quality marker). engagement_date DATE;
# avg_scroll_pct is nullable INT. updated_at plain timestamp (DuckDB session is fixed UTC).
COLUMNS_SQL = """
  brand_id         string    NOT NULL,
  engagement_date  date      NOT NULL,
  signal_type      string    NOT NULL,
  signal_count     bigint    NOT NULL,
  sessions         bigint    NOT NULL,
  pages            bigint    NOT NULL,
  avg_scroll_pct   int,
  updated_at       timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "engagement_date", "signal_type",
    "signal_count", "sessions", "pages", "avg_scroll_pct", "updated_at",
]

PK = ["brand_id", "engagement_date", "signal_type"]


def build(con):
    # brand-first tenant partitioning + per-day anchor (mirrors Spark bucket(64, brand_id), engagement_date;
    # day() is singular in DuckDB's Iceberg transform vocabulary vs Spark's days()).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), engagement_date")

    # ── the Spark staged rollup, reproduced verbatim (daily per-signal-type friction rollup) ──
    # avg_scroll_pct: integer FLOOR division `//` reproduces Spark's CAST-int-division TRUNCATION
    # (scroll_pct ≥ 0 → floor == truncate), scroll_depth-only, NULL otherwise. No float touches the mart.
    staged = f"""
        SELECT
            brand_id,
            CAST(occurred_at AS DATE)                                    AS engagement_date,
            signal_type,
            CAST(COUNT(*) AS BIGINT)                                     AS signal_count,
            CAST(COUNT(DISTINCT session_id) AS BIGINT)                   AS sessions,
            CAST(COUNT(DISTINCT page) AS BIGINT)                         AS pages,
            CASE WHEN signal_type = 'scroll_depth'
                 THEN CAST(SUM(COALESCE(scroll_pct, 0)) // NULLIF(COUNT(scroll_pct), 0) AS INT)
                 ELSE NULL END                                           AS avg_scroll_pct,
            now()                                                        AS updated_at
        FROM {SOURCE}
        WHERE brand_id IS NOT NULL AND occurred_at IS NOT NULL
        GROUP BY brand_id, CAST(occurred_at AS DATE), signal_type
    """

    # The rollup is already 1 row per PK (GROUP BY upstream), so merge_on_pk's in-batch dedup is a no-op;
    # order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    run_job("gold-engagement", build, target_table=TABLE)
