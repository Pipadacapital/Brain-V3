"""
silver_search.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_search.py.

NET-NEW canonical Silver `search` grain (Brain V4 Phase 1b, GROUP pixel-behavior). ONE gated read over
the keystone rest.brain_silver.silver_collector_event (ADR-0006 P3 — the Spark job's read_bronze_events
reads that same gated source) for 'search.submitted' → typed projection → is_zero_result derivation →
Stage-1 DQ gate → idempotent MERGE on (brand_id, event_id). Parity target: brain_silver.silver_search.

FAITHFUL to the Spark build():
  - event_type IN ('search.submitted').
  - query   = COALESCE(properties.query, properties.q)          (some storefronts name the param `q`).
  - results_count = COALESCE(properties.results, properties.results_count) CAST bigint (NULL if absent).
  - is_zero_result derived ONLY when results_count IS NOT NULL (results_count == 0); else NULL boolean —
    a NULL count stays unknown, never mislabeled a zero-result.
  - path = properties.landing_path, referrer = properties.referrer, device_class = properties.device.ua_class.
  - MONEY: NONE (a search is non-monetary — no money column).
  - admission filter: event_id / brand_id / brain_anon_id all NOT NULL (the Spark .where()).
  - dedup + MERGE on (brand_id, event_id) latest-ingested-wins, order_by_desc=[ingested_at, occurred_at].

STAGE-1 DQ GATE (non-monetary): the Spark job runs dq_violations_udf over (amount=NULL, currency=NULL,
occurred_at, results_count) — so the only live rules are the TIMESTAMP gate (unparseable/future occurred_at)
and the QUANTITY gate over results_count (impossible_quantity: negative or absurdly large). occurred_at is
already an Iceberg timestamp column here (never a string), so the timestamp rule cannot fire (it is a valid
instant by construction) — matching the Spark behavior where a parseable ts passes. The quantity rule is
preserved as a WHERE below (results_count NULL is OMITTED — the count is genuinely unknown, not invalid).

CAVEAT — quarantine side-write SKIPPED: the Spark job diverts Stage-1 DQ failures to
brain_silver.silver_quarantine (stage='dq') and drops them from the mart. This DuckDB port has no
_silver_technical analogue, so it does NOT write the quarantine side-table. It DOES preserve the mart's
admission filters (NOT-NULL keys + the impossible_quantity guard), so good rows are data-equivalent to the
Spark mart output; Bronze keeps the originals, so the quarantine ledger can be rebuilt separately.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import (  # noqa: E402
    GATED_SOURCE,
    ensure_table,
    incremental_window,
    merge_on_pk,
    prop,
    read_gated_events_sql,
    run_job,
)
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_search_duckdb_test beside the Spark-produced
# live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_search{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SEARCH_EVENTS = ["search.submitted"]

# DEFAULT_ABSURD_QTY from _silver_technical (dq_check impossible_quantity ceiling). A results_count outside
# [0, ABSURD_QTY] is diverted in Spark; we drop it here (quarantine side-write skipped, see module docstring).
ABSURD_QTY = int(os.environ.get("SILVER_ABSURD_QTY", "1000000000"))

# Canonical Silver column contract — mirrors the Spark mart DDL column-for-column.
COLUMNS_SQL = """
  brand_id        string    NOT NULL,
  event_id        string    NOT NULL,
  brain_anon_id   string    NOT NULL,
  session_id      string,
  query           string,
  results_count   bigint,
  is_zero_result  boolean,
  path            string,
  referrer        string,
  device_class    string,
  occurred_at     timestamp NOT NULL,
  ingested_at     timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "brain_anon_id", "session_id", "query", "results_count",
    "is_zero_result", "path", "referrer", "device_class", "occurred_at", "ingested_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   GRAIN=per_event: each gated keystone row → 0..1 silver row via the idempotent MERGE on
    #   (brand_id, event_id), so windowing the source read is safe — a row's output depends only on itself.
    #   Default OFF / first run / FULL_REFRESH → (None, None); read_gated_events_sql then omits the [lo,hi)
    #   predicate, so the generated SQL is byte-identical to the pre-edit full scan.
    lo, hi = incremental_window(con, "silver-search", GATED_SOURCE, ts_col="ingested_at")

    typed = f"""
      SELECT
        brand_id,
        event_id,
        {prop('pj','brain_anon_id')} AS brain_anon_id,
        {prop('pj','session_id')} AS session_id,
        COALESCE({prop('pj','query')}, {prop('pj','q')}) AS query,
        CAST(COALESCE({prop('pj','results')}, {prop('pj','results_count')}) AS BIGINT) AS results_count,
        {prop('pj','landing_path')} AS path,
        {prop('pj','referrer')} AS referrer,
        {prop('pj','device.ua_class')} AS device_class,
        occurred_at,
        ingested_at
      FROM ({read_gated_events_sql(SEARCH_EVENTS, lo=lo, hi=hi)})
    """

    # is_zero_result derived ONLY when results_count is present — a NULL count stays unknown (NULL boolean).
    staged = f"""
      SELECT
        brand_id, event_id, brain_anon_id, session_id, query, results_count,
        CASE WHEN results_count IS NOT NULL THEN (results_count = 0)
             ELSE CAST(NULL AS BOOLEAN) END AS is_zero_result,
        path, referrer, device_class, occurred_at, ingested_at
      FROM ({typed})
    """

    # Mart admission filters (the Spark .where + the surviving Stage-1 DQ rules):
    #   - event_id / brand_id / brain_anon_id NOT NULL.
    #   - impossible_quantity guard on results_count (NULL omitted — genuinely unknown, not invalid).
    #   (occurred_at is a timestamp column, so the timestamp DQ rules cannot fire — a valid instant by
    #    construction, matching Spark's "parseable ts passes".)
    good = f"""
      SELECT {', '.join(COLUMNS)} FROM ({staged})
      WHERE event_id IS NOT NULL AND brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
        AND (results_count IS NULL OR (results_count >= 0 AND results_count <= {ABSURD_QTY}))
    """

    return merge_on_pk(con, TARGET, good, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-search", build, target_table="silver_search")
