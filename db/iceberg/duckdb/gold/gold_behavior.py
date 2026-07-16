"""
gold_behavior.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_behavior.py.

NET-NEW gap Gold `behavior` mart (Brain V4 Phase 2, GROUP "NEW gap Gold products"). NO dbt predecessor
(parity status=NEW; matrix §3/4). The materialized browse-behavior surface — one row per
(brand_id, behavior_date, page_type) holding the daily page-view volume + session/journey reach per
page_type, read from Iceberg brain_silver.silver_page_view DIRECTLY (exactly like the Spark job reads
it via silver()). This is the Gold rollup of the TS computeStorefrontBehavior page-type-mix signal
(storefront-behavior.ts), lifted to a daily mart over the dedicated page-view Silver grain.

THE TRANSFORM (verbatim from the Spark staged SQL):
    SELECT brand_id,
           CAST(occurred_at AS DATE)                    AS behavior_date,
           COALESCE(NULLIF(page_type, ''), 'unknown')   AS page_type,
           COUNT(*)                                      AS views,
           COUNT(DISTINCT session_id)                   AS sessions,
           COUNT(DISTINCT brain_anon_id)                AS journeys,
           current_timestamp()                          AS updated_at
    FROM silver_page_view
    WHERE brand_id IS NOT NULL AND occurred_at IS NOT NULL
    GROUP BY brand_id, CAST(occurred_at AS DATE), COALESCE(NULLIF(page_type, ''), 'unknown')

GRAIN / PK: 1 row per (brand_id, behavior_date, page_type). behavior_date = occurred_at::date (UTC).
  page_type is the page taxonomy (product|collection|cart|search|other|''→'unknown'). NO money
  (behavior is impression counting — registered money_columns=[]). brand_id first + partition anchor.
COLUMNS :
  views    — page-view events of this page_type in the day (COUNT(*)).
  sessions — distinct session_id reaching this page_type.
  journeys — distinct brain_anon_id reaching this page_type (journey reach).
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on the PK. Idempotent.

FULL RECOMPUTE vs Spark's entity-incremental wrapper: the Spark job wraps the identical GROUP BY in
  run_entity_incremental (a SCALING optimization — recompute only brands with new events over full
  history, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is parity-equivalent: the
  MERGE on the mart PK is idempotent and restates every (brand, date, page_type) to the current Silver
  aggregate. silver() in full mode returns the raw FQTN — byte-identical read set.

CAVEAT — orphan-shedding: the Spark job passes delete_orphans=True (WHEN NOT MATCHED BY SOURCE DELETE)
  so a full per-brand recompute sheds a disappeared group's Gold row. The DuckDB _base.merge_on_pk does
  NOT implement a not-matched-by-source DELETE — this port is MATCHED-UPDATE / NOT-MATCHED-INSERT only.
  For the parallel-run parity harness (fresh <table>_duckdb_test built from the same Silver) the
  admission set is identical; the divergence only surfaces after an upstream group disappears from
  Silver between runs. Noted, not silently dropped.

QUARANTINE : the Spark job has NO Stage-1/quarantine side-write here (it reads already-gated Silver).
  This framework has none either — nothing to skip.

Honors MIGRATION_TABLE_SUFFIX (→ gold_behavior_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_behavior (Spark oracle: 199 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_behavior_duckdb_test beside the Spark-produced
# live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_behavior"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_page_view"

# Mirrors the Spark COLUMNS_SQL order/types exactly. No money (impression counting). behavior_date DATE.
COLUMNS_SQL = """
  brand_id       string    NOT NULL,
  behavior_date  date      NOT NULL,
  page_type      string    NOT NULL,
  views          bigint    NOT NULL,
  sessions       bigint    NOT NULL,
  journeys       bigint    NOT NULL,
  updated_at     timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "behavior_date", "page_type",
    "views", "sessions", "journeys", "updated_at",
]

PK = ["brand_id", "behavior_date", "page_type"]


def build(con):
    # brand-first tenant partitioning + per-day anchor (mirrors Spark bucket(64, brand_id), behavior_date).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), behavior_date")

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ────────────────────────
    #   GRAIN = entity_fold: MANY silver_page_view rows aggregate into ONE (brand_id, behavior_date,
    #   page_type) row whose daily views/sessions/journeys depend on ALL page-view events of that day —
    #   including rows BELOW the watermark (a late-arriving page view for a day already partly rolled up).
    #   Windowing the fold input directly would drop those → wrong daily counts. So we window ONLY to
    #   DISCOVER which (brand_id, behavior_date) buckets changed (a new page view landed for that day since
    #   the last run), then re-fold each changed DAY over its FULL, UNWINDOWED page-view history — which
    #   restates every page_type in that day (page_type follows the day bucket). The MERGE on the PK
    #   (brand_id, behavior_date, page_type) upserts exactly those restated rows. The fold-driving source is
    #   silver_page_view — a per-event Silver mart with an arrival clock ingested_at (ts_col=ingested_at).
    #   GOLD_INCREMENTAL gates the Gold tier INDEPENDENTLY of Silver (already ON in prod).
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below is
    #   byte-identical to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-behavior", SOURCE, ts_col="ingested_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # the page-view arrival clock otherwise. Same day-bucket guards as the fold (brand_id + occurred_at).
    win = []
    if lo is not None:
        win.append(f"ingested_at >= '{lo}'")
    if hi is not None:
        win.append(f"ingested_at <= '{hi}'")
    view_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: (brand_id, behavior_date) day-buckets whose page views changed within [lo, hi], using
    # the SAME day derivation + guards the fold uses. Built ONLY when incremental (lo not None).
    changed = f"""
        SELECT DISTINCT brand_id, CAST(occurred_at AS DATE) AS behavior_date
        FROM {SOURCE}
        WHERE brand_id IS NOT NULL AND occurred_at IS NOT NULL{view_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed day-buckets so
    # each re-folds every page_type over the whole day. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        "          AND (brand_id, CAST(occurred_at AS DATE)) IN "
        f"(SELECT brand_id, behavior_date FROM ({changed}))\n"
        if lo is not None else ""
    )

    # ── the Spark staged rollup, reproduced verbatim (daily page-type-mix, one row per PK) ──
    staged = f"""
        SELECT
            brand_id,
            CAST(occurred_at AS DATE)                                    AS behavior_date,
            COALESCE(NULLIF(page_type, ''), 'unknown')                   AS page_type,
            CAST(COUNT(*) AS BIGINT)                                     AS views,
            CAST(COUNT(DISTINCT session_id) AS BIGINT)                   AS sessions,
            CAST(COUNT(DISTINCT brain_anon_id) AS BIGINT)                AS journeys,
            now()                                                        AS updated_at
        FROM {SOURCE}
        WHERE brand_id IS NOT NULL AND occurred_at IS NOT NULL
{refold_filter}        GROUP BY brand_id, CAST(occurred_at AS DATE), COALESCE(NULLIF(page_type, ''), 'unknown')
    """

    # The rollup is already 1 row per PK (GROUP BY upstream), so merge_on_pk's in-batch dedup is a no-op;
    # order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    # The watermark tracks the page-view arrival clock (silver_page_view.ingested_at) — this Gold mart
    # folds a per-event Silver mart, not the gated keystone default.
    run_job("gold-behavior", build, target_table=TABLE, source_table=SOURCE, ts_col="ingested_at")
