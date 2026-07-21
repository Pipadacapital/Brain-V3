"""
silver_sessions.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_sessions.py.

SESSIONIZATION rollup: reads the sibling Silver mart {CATALOG}.brain_silver.silver_touchpoint (the
per-TOUCH grain, built by silver_touchpoint) and folds it up to ONE row per SESSION
(brand_id, brain_anon_id, session_key) — the exact dbt silver_sessions.sql transform the Spark job
inlines verbatim. NOT read from raw Bronze / the gated keystone: the source is another Silver table,
read directly as {CATALOG}.brain_silver.silver_touchpoint.

THE FOLD (per session): touch_count, pageview/product-view counts, entry/exit channel + entry
page_type (deterministic by touch ORDER via the zero-padded touch_seq encoding), session start/end +
duration_seconds, a bounce flag (touch_count = 1), and a converted flag (any touch stitched to an order).

GRAIN : exactly 1 row per (brand_id, brain_anon_id, session_key).
NO MONEY: sessions are not monetary — there is NO money column in this mart.
ISOLATION: brand_id first + bucket() partition anchor.
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, brain_anon_id, session_key) — re-run yields identical rows.

ENTRY/EXIT BY TOUCH ORDER (verbatim): dbt/Spark encode channel/page_type with a zero-padded touch_seq
  prefix `lpad(touch_seq,10,'0') || '|' || value` so min()/max() over the encoded string resolves the
  FIRST/LAST touch by ORDER, not by value; substring_index(...,'|',-1) peels the value back off. DuckDB
  has lpad; the encoded string is exactly `<10 digits>|<value>` (channel/page_type are enums, never
  contain '|'), so the value is `substr(encoded, 12)` — the byte-identical peel of substring_index('|', -1).

DURATION (verbatim): Spark floors the difference of the FULL-PRECISION epoch (double seconds incl.
  fraction), NOT each endpoint — `floor(cast(max as double) - cast(min as double))`. DuckDB analogue:
  `floor(epoch_us(max)/1e6 - epoch_us(min)/1e6)` (epoch_us gives whole-microsecond precision), so the
  ±1s boundary artifact of flooring each endpoint separately never appears.

UTC: silver_touchpoint.occurred_at is TIMESTAMP WITH TIME ZONE; the Silver session_start_at/end_at
  columns are naive `timestamp` (Iceberg parity with Spark UTC instants). `AT TIME ZONE 'UTC'` pins the
  wall-clock to UTC regardless of session TZ (same as silver_campaign) → byte-parity + checksum-safe.

STAGE-1 GATE: the Spark job's only Stage-1 rule here is the timestamp dq_check on session_start_at,
  diverting future/unparseable sessions to brain_silver.silver_quarantine(stage='dq'). This framework has
  NO quarantine side-write (parity with the other ported jobs) — the quarantine side-write is SKIPPED.
  session_start_at = min(occurred_at) over already-gated Silver touches, so a violation is not expected.

Parity target: brain_silver.silver_sessions.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_sessions{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"

# Mirrors the Spark _COLUMNS order/types (naive timestamp; no money column).
COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  brain_anon_id       string    NOT NULL,
  session_key         int       NOT NULL,
  session_seq         bigint,
  touch_count         bigint,
  pageview_count      bigint,
  product_view_count  bigint,
  entry_channel       string,
  exit_channel        string,
  entry_page_type     string,
  session_start_at    timestamp,
  session_end_at      timestamp,
  duration_seconds    bigint,
  is_bounce           boolean,
  is_converted        boolean,
  updated_at          timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_anon_id", "session_key", "session_seq", "touch_count", "pageview_count",
    "product_view_count", "entry_channel", "exit_channel", "entry_page_type", "session_start_at",
    "session_end_at", "duration_seconds", "is_bounce", "is_converted", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   GRAIN = entity_fold: MANY silver_touchpoint per-touch rows sessionize (GROUP BY) into ONE
    #   (brand_id, brain_anon_id, session_key) row whose value (touch_count, entry/exit by touch ORDER,
    #   min/max session start/end, is_bounce, is_converted) depends on touches that may sit BELOW the
    #   watermark. So we MUST NOT window the fold input directly (that would drop history → wrong counts,
    #   wrong entry/exit, wrong duration). Instead: use the [lo,hi) window ONLY to discover the CHANGED
    #   session keys, then re-fold each changed session over its FULL touch history.
    #
    #   The source silver_touchpoint has NO `ingested_at` column (see its COLUMNS_SQL: only occurred_at +
    #   a `now()` run-clock `updated_at`). Its physical arrival/change key is `updated_at` — every re-landed
    #   or new touch row gets a fresh now() on write — so the watermark tracks max(updated_at) with the
    #   framework's trailing lookback (a slightly-late write can never be skipped; the idempotent MERGE dedups
    #   the re-scanned overlap). This mirrors silver_shipment (its source likewise lacked ingested_at).
    #   Default OFF (lo=None) → NO changed-set, NO semi-join → byte-identical full re-fold, unchanged SQL.
    lo, hi = incremental_window(con, "silver-sessions", SOURCE, ts_col="updated_at")
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    src_window = f"WHERE {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: the (brand_id, brain_anon_id, session_key) session keys whose touches changed in
    # [lo,hi). Uses the SAME entity-key derivation the fold GROUPs on (no extra not-null guard, matching the
    # fold's GROUP BY exactly). Never referenced when lo is None (default OFF → src_window '').
    changed = (
        f"SELECT DISTINCT brand_id, brain_anon_id, session_key FROM {SOURCE} {src_window}"
    )

    # The fold reads the FULL, UNWINDOWED source; when incremental is on, a semi-join narrows it to ONLY the
    # changed sessions so each re-folds over its COMPLETE touch history. When lo is None the extra predicate
    # is absent → byte-identical full scan of SOURCE.
    fold_source = SOURCE
    if lo is not None:
        fold_source = (
            f"(SELECT * FROM {SOURCE} "
            f"WHERE (brand_id, brain_anon_id, session_key) "
            f"IN (SELECT brand_id, brain_anon_id, session_key FROM ({changed})))"
        )

    # ── per-touch projection (occurred_at → UTC-naive) + the order-encoded channel/page_type ──
    touches = f"""
      SELECT
        brand_id, brain_anon_id, session_key, session_seq, touch_seq,
        occurred_at AT TIME ZONE 'UTC' AS occurred_at,
        event_type, channel, page_type, stitched_order_id,
        concat(lpad(CAST(touch_seq AS VARCHAR), 10, '0'), '|', coalesce(channel, ''))   AS _ch_enc,
        concat(lpad(CAST(touch_seq AS VARCHAR), 10, '0'), '|', coalesce(page_type, '')) AS _pt_enc
      FROM {fold_source}
    """

    # ── roll the touch grain up to the session grain (verbatim dbt fold) ──
    # substring_index(min(_ch_enc), '|', -1) == substr(min(_ch_enc), 12): peel the value off the
    #   fixed `<10 digits>|` prefix. min/max over the encoded string picks the FIRST/LAST touch by ORDER.
    # duration_seconds: floor of the FULL-PRECISION second difference (epoch_us/1e6), not per-endpoint.
    staged = f"""
      SELECT
        brand_id,
        brain_anon_id,
        session_key,
        max(session_seq)                                                              AS session_seq,
        CAST(count(*) AS BIGINT)                                                      AS touch_count,
        CAST(sum(CASE WHEN event_type = 'page.viewed' THEN 1 ELSE 0 END) AS BIGINT)    AS pageview_count,
        CAST(sum(CASE WHEN event_type = 'product.viewed' THEN 1 ELSE 0 END) AS BIGINT) AS product_view_count,
        substr(min(_ch_enc), 12)                                                     AS entry_channel,
        substr(max(_ch_enc), 12)                                                     AS exit_channel,
        substr(min(_pt_enc), 12)                                                     AS entry_page_type,
        min(occurred_at)                                                             AS session_start_at,
        max(occurred_at)                                                             AS session_end_at,
        CAST(
            floor(epoch_us(max(occurred_at)) / 1000000.0 - epoch_us(min(occurred_at)) / 1000000.0)
        AS BIGINT)                                                                   AS duration_seconds,
        (count(*) = 1)                                                               AS is_bounce,
        (max(CASE WHEN stitched_order_id IS NOT NULL THEN 1 ELSE 0 END) = 1)         AS is_converted,
        now() AT TIME ZONE 'UTC'                                                     AS updated_at
      FROM ({touches})
      GROUP BY brand_id, brain_anon_id, session_key
    """

    # Idempotent MERGE on the (brand_id, brain_anon_id, session_key) PK — replay-safe upsert.
    # order_by_desc = session_end_at (recency) then session_key for a deterministic in-batch dedup (the
    # GROUP BY already yields one row per PK, so this is a stable no-op tie-break).
    return merge_on_pk(con, TARGET, staged, COLUMNS,
                       ["brand_id", "brain_anon_id", "session_key"],
                       order_by_desc=["session_end_at", "session_key"])


if __name__ == "__main__":
    # Source is the sibling Silver mart silver_touchpoint (NOT the gated keystone) and it has no
    # ingested_at column — the watermark tracks max(updated_at) on that table (see incremental_window's
    # ts_col), the same run-clock the fold-source read/semi-join windows on.
    run_job(
        "silver-sessions", build, target_table="silver_sessions",
        source_table=SOURCE, ts_col="updated_at",
    )
