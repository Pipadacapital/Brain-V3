"""
gold_journey.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_journey.py.

The NET-NEW gap Gold `gold_journey` INTELLIGENCE rollup (Brain V4 Phase 2, GROUP "NEW gap Gold products";
parity status = NEW — no dbt predecessor, no Spark oracle table present in this catalog). ONE row per
(brand_id, brain_anon_id) summarizing each reconstructed visitor journey: how many touches, across how many
channels and sessions, when it started/ended, whether it converted, and how long conversion took. This is the
AGGREGATE serving mart the journey dashboard reads.

CRITICAL BOUNDARY (unchanged from Spark): this is the INTELLIGENCE-SIDE rollup — DISTINCT from the
identity-side journey reconstruction. A pure aggregate over the Silver journey spine: NO money column (the
journey entity carries no revenue — revenue truth stays in the order/settlement marts), and NO raw or hashed
PII — brain_anon_id is the opaque pseudonymous pixel id (the only identity key), never an email/phone hash.

GRAIN / PK: 1 row per (brand_id, brain_anon_id) — the visitor/journey key the whole Silver spine is anchored
  on (brain_id/stitched_brain_id is sparse pre-stitch, so the honest journey grain is the anon visitor).

SOURCES (read DIRECTLY, exactly as the Spark spark.table() reads):
  {CATALOG}.brain_silver.silver_journey    — the journey ENTITY (first/last touch+channel, touch/session
                                             count, converted flag — the deterministic spine).
  {CATALOG}.brain_silver.silver_touchpoint — per-touch grain → distinct_channels + first conversion-touch ts.
  {CATALOG}.brain_silver.silver_sessions   — per-session grain → authoritative distinct_sessions
                                             (COUNT DISTINCT session_key).

COLUMNS (byte-for-byte the Spark projection):
  touchpoint_count   = silver_journey.touch_count.
  distinct_channels  = INT count of distinct deterministic channels (silver_touchpoint).
  distinct_sessions  = COUNT DISTINCT session_key (silver_sessions), falling back to silver_journey.session_count.
  first_channel / last_channel  = the deterministic first/last arrival channel (NEVER a model).
  first_touch_at / last_touch_at = journey start/end (UTC).
  converted          = the spine's converted flag.
  converted_at       = timestamp of the FIRST conversion touch (NULL if not converted, and only surfaced
                       when the spine flagged the journey converted — consistent basis).
  days_to_convert    = INT whole days first-touch → first-conversion (integer date math; NULL if not converted).

SPARK→DUCKDB SQL TRANSLATIONS (parity-critical):
  - current_timestamp()                      → now() AT TIME ZONE 'UTC'  (framework SETs TimeZone=UTC).
  - DATEDIFF(CAST(a AS DATE), CAST(b AS DATE)) (Spark: end - start, whole days)
        → date_diff('day', CAST(b AS DATE), CAST(a AS DATE))  (DuckDB date_diff is end - start with the
          unit FIRST; verified: date_diff('day', start, end) == Spark DATEDIFF(end, start)).
  - CONVERSION_EVENTS  = 'payment.succeeded','order.placed','purchase.completed' (byte-identical set).

WRITE: idempotent MERGE via _base.merge_on_pk on PK (brand_id, brain_anon_id) — full recompute from Silver
  each run (replay-safe; the LEFT JOINs make it deterministic). staged is already 1 row per PK, so the
  in-batch dedup order_by is a stable no-op tie-break. Honors MIGRATION_TABLE_SUFFIX for the parity harness.

MONEY: none (registered money_columns=[] on the Spark side). A journey carries no revenue.

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (reads already-gated Silver); the
  DuckDB framework never writes a quarantine table either. Nothing to skip.

Parity target: brain_gold.gold_journey — NO Spark oracle table exists in this catalog (parity status NEW).
  This writes the honest full recompute from the live Silver spine; a parity_check has no Spark side to
  compare against (see CAVEAT in the report).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_journey"
_SUFFIX = os.environ.get("MIGRATION_TABLE_SUFFIX", "")
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{_SUFFIX}"

SILVER_JOURNEY = f"{CATALOG}.{SILVER_NAMESPACE}.silver_journey"
SILVER_TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
SILVER_SESSIONS = f"{CATALOG}.{SILVER_NAMESPACE}.silver_sessions"

# Conversion event set — byte-identical to silver_journey.CONVERSION_EVENTS (the spine's `converted` def).
CONVERSION_EVENTS_SQL = "'payment.succeeded', 'order.placed', 'purchase.completed'"

PK = ["brand_id", "brain_anon_id"]

# Column contract — byte-for-byte the Spark _COLUMNS order/types. brand_id first (tenant key). NO money.
COLUMNS_SQL = """
  brand_id          string    NOT NULL,
  brain_anon_id     string    NOT NULL,
  first_touch_at    timestamp NOT NULL,
  last_touch_at     timestamp NOT NULL,
  first_channel     string,
  last_channel      string,
  touchpoint_count  bigint    NOT NULL,
  distinct_channels int       NOT NULL,
  distinct_sessions bigint    NOT NULL,
  converted         boolean   NOT NULL,
  converted_at      timestamp,
  days_to_convert   int,
  updated_at        timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_anon_id", "first_touch_at", "last_touch_at", "first_channel", "last_channel",
    "touchpoint_count", "distinct_channels", "distinct_sessions", "converted", "converted_at",
    "days_to_convert", "updated_at",
]


def build(con):
    # brand-first tenant bucketing + day() partition (mirrors Spark bucket(64, brand_id), days(first_touch_at)).
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ──────────────────────────
    #   GRAIN = entity_fold: MANY silver_touchpoint / silver_sessions rows aggregate into ONE
    #   (brand_id, brain_anon_id) journey row whose distinct_channels / distinct_sessions / converted_at
    #   depend on that entity's FULL touch+session history — including rows BELOW the watermark. Windowing
    #   the tp/ss fold inputs directly would silently drop history → wrong journey aggregates. So we window
    #   ONLY to DISCOVER which journeys changed (a touch/spine row landed since the last run), then re-fold
    #   each changed entity over its FULL, UNWINDOWED history. The MERGE on the PK (brand_id, brain_anon_id)
    #   upserts exactly those restated rollups.
    #
    #   CLOCK: the changed-set is keyed off the journey SPINE silver_journey (the FROM-clause mart that
    #   determines which (brand_id, brain_anon_id) rows EXIST). silver_journey is an ENTITY Silver mart —
    #   it has NO ingested_at, but it HAS updated_at (a now()-stamped write clock), so ts_col='updated_at'
    #   is exactly "which journey rows changed since last run" (verified against silver_journey COLUMNS_SQL).
    #
    #   Passes enabled=GOLD_INCREMENTAL so the Gold tier flips INDEPENDENTLY of SILVER_INCREMENTAL.
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below is
    #   BYTE-IDENTICAL to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-journey", SILVER_JOURNEY, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); an [lo, hi] range over
    # the spine's write clock otherwise. Same entity-key guard as the fold (brand_id/brain_anon_id NOT NULL).
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    spine_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: journeys whose spine row changed within [lo, hi], using the SAME (brand_id,
    # brain_anon_id) key + NOT-NULL guards the fold uses. Built ONLY when incremental (lo not None).
    changed = f"""
        SELECT DISTINCT brand_id, brain_anon_id
        FROM {SILVER_JOURNEY}
        WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL{spine_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed journeys so each
    # re-folds over its ENTIRE touch/session history. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        f"          AND (j.brand_id, j.brain_anon_id) IN (SELECT brand_id, brain_anon_id FROM ({changed}))\n"
        if lo is not None else ""
    )

    staged = f"""
        WITH tp AS (
            -- Per-touch grain → distinct deterministic channels + the FIRST conversion-touch timestamp.
            SELECT
                brand_id,
                brain_anon_id,
                COUNT(DISTINCT channel) AS distinct_channels,
                MIN(CASE WHEN event_type IN ({CONVERSION_EVENTS_SQL})
                         THEN occurred_at END) AS converted_at
            FROM {SILVER_TOUCHPOINT}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
            GROUP BY brand_id, brain_anon_id
        ),
        ss AS (
            -- Per-session grain → authoritative distinct session count (COUNT DISTINCT session_key).
            SELECT
                brand_id,
                brain_anon_id,
                COUNT(DISTINCT session_key) AS distinct_sessions
            FROM {SILVER_SESSIONS}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
            GROUP BY brand_id, brain_anon_id
        )
        SELECT
            j.brand_id,
            j.brain_anon_id,
            j.first_touch_at,
            j.last_touch_at,
            j.first_channel,
            j.last_channel,
            j.touch_count AS touchpoint_count,
            CAST(COALESCE(tp.distinct_channels, 0) AS INTEGER) AS distinct_channels,
            COALESCE(ss.distinct_sessions, j.session_count) AS distinct_sessions,
            j.converted,
            -- conversion timestamp only when the spine flagged the journey converted (consistent basis).
            CASE WHEN j.converted THEN tp.converted_at ELSE NULL END AS converted_at,
            -- whole days first-touch → first-conversion (integer date math, NULL if not converted).
            -- date_diff('day', start, end) == Spark DATEDIFF(end, start).
            CASE WHEN j.converted AND tp.converted_at IS NOT NULL
                 THEN CAST(date_diff('day', CAST(j.first_touch_at AS DATE),
                                             CAST(tp.converted_at AS DATE)) AS INTEGER)
                 ELSE NULL END AS days_to_convert,
            now() AT TIME ZONE 'UTC' AS updated_at
        FROM {SILVER_JOURNEY} j
        LEFT JOIN tp ON j.brand_id = tp.brand_id AND j.brain_anon_id = tp.brain_anon_id
        LEFT JOIN ss ON j.brand_id = ss.brand_id AND j.brain_anon_id = ss.brain_anon_id
        WHERE j.brand_id IS NOT NULL AND j.brain_anon_id IS NOT NULL
{refold_filter}    """

    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    # The watermark tracks the journey spine's write clock (silver_journey.updated_at) — this Gold rollup
    # reads sibling Silver marts, and silver_journey (the entity spine) has no ingested_at.
    run_job("gold-journey", build, target_table=TABLE,
            source_table=SILVER_JOURNEY, ts_col="updated_at")
