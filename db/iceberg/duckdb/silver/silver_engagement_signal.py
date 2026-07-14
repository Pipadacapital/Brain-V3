"""
silver_engagement_signal.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_engagement_signal.py.

NET-NEW canonical Silver `engagement_signal` (Brain V4 Phase 1b, GROUP pixel; parity status=NEW — no dbt
predecessor). One row per first-party pixel engagement/friction signal, normalizing the FOUR behavioral-
quality pixel events into ONE canonical shape:
    rage.click      → signal_type='rage_click'      (props x/y/count)
    dead.click      → signal_type='dead_click'      (props x/y/element)
    scroll.depth    → signal_type='scroll_depth'    (prop  percent 0..100)
    element.clicked → signal_type='element_clicked' (prop  element selector/role)

GRAIN   : 1 row per (brand_id, event_id) — the Bronze idempotency key (replay-safe MERGE on it).
MONEY   : none — an engagement signal carries NO money (registered money_columns=[]); no money column.
ISOLATION: brand_id first + the bucket() partition anchor.

STAGE-1 DQ GATE (faithful): the ONLY Stage-1 rule that applies to a timestamped, money-less signal is the
  occurred_at gate — a row whose occurred_at is future-dated (> now + 5min skew) or unparseable is DIVERTED
  and NEVER written. In DuckDB the source occurred_at is already a parsed `timestamp`, so "unparseable"
  collapses to NULL; both are excluded by the WHERE below. (money/currency, impossible_quantity,
  empty_identifier and clean_name/clean_string rules are N/A on this grain — see the Spark docstring.)
  QUARANTINE SIDE-WRITE SKIPPED: the Spark job also writes rejected rows to brain_silver.silver_quarantine
  (stage='dq'); this port only produces the main target (per migration rules) — Bronze keeps the original,
  so a future quarantine backfill remains possible. Rejected rows are simply not emitted here.

DEFAULT_SKEW_MS = 5 * 60 * 1000 (5 minutes), verbatim from _silver_technical.DEFAULT_SKEW_MS.
Parity target: brain_silver.silver_engagement_signal.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to
# silver_engagement_signal_duckdb_test instead of the live table (parallel run → compare → cut over).
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_engagement_signal{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# The four behavioral-quality pixel events (universal collector taxonomy).
ENGAGEMENT_EVENTS = ["rage.click", "dead.click", "scroll.depth", "element.clicked"]

# 5-minute clock-skew grace for "future" timestamps — verbatim DEFAULT_SKEW_MS parity.
_SKEW = "INTERVAL 5 MINUTE"

COLUMNS_SQL = """
  brand_id       string    NOT NULL,
  event_id       string    NOT NULL,
  signal_type    string    NOT NULL,
  selector       string,
  scroll_pct     int,
  click_count    int,
  pos_x          int,
  pos_y          int,
  page           string,
  session_id     string,
  brain_anon_id  string,
  device_class   string,
  viewport       string,
  occurred_at    timestamp NOT NULL,
  ingested_at    timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "signal_type", "selector", "scroll_pct", "click_count",
    "pos_x", "pos_y", "page", "session_id", "brain_anon_id", "device_class", "viewport",
    "occurred_at", "ingested_at",
]

# Normalize the four raw event_types to the stable signal_type discriminant (verbatim CASE port of
# _signal_type — NEVER a model).
_SIGNAL_TYPE = (
    "CASE event_type "
    "WHEN 'rage.click' THEN 'rage_click' "
    "WHEN 'dead.click' THEN 'dead_click' "
    "WHEN 'scroll.depth' THEN 'scroll_depth' "
    "WHEN 'element.clicked' THEN 'element_clicked' "
    "ELSE 'unknown' END"
)


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # Project the four event shapes into ONE canonical row shape (single lane — same event grain,
    # signal_type discriminates). `element` present on dead.click/element.clicked; scroll.depth carries
    # `percent`; rage.click carries `count`; rage/dead carry x/y. All others NULL by construction.
    typed = f"""
      SELECT brand_id, event_id,
             {_SIGNAL_TYPE} AS signal_type,
             {prop('pj', 'element')} AS selector,
             CAST({prop('pj', 'percent')} AS INTEGER) AS scroll_pct,
             CAST({prop('pj', 'count')} AS INTEGER) AS click_count,
             CAST({prop('pj', 'x')} AS INTEGER) AS pos_x,
             CAST({prop('pj', 'y')} AS INTEGER) AS pos_y,
             {prop('pj', 'landing_path')} AS page,
             {prop('pj', 'session_id')} AS session_id,
             {prop('pj', 'brain_anon_id')} AS brain_anon_id,
             {prop('pj', 'device.ua_class')} AS device_class,
             {prop('pj', 'device.viewport')} AS viewport,
             occurred_at, ingested_at
      FROM ({read_gated_events_sql(ENGAGEMENT_EVENTS)})
      WHERE event_id IS NOT NULL AND brand_id IS NOT NULL
    """

    # Stage-1 DQ gate: keep rows whose occurred_at is present (not NULL/unparseable) AND not future-dated
    # beyond the 5-minute skew grace. Rejected rows are simply not emitted (quarantine side-write skipped).
    gated = f"""
      SELECT {', '.join(COLUMNS)} FROM ({typed})
      WHERE occurred_at IS NOT NULL
        AND occurred_at <= now() + {_SKEW}
    """

    return merge_on_pk(con, TARGET, gated, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-engagement-signal", build, target_table="silver_engagement_signal")
