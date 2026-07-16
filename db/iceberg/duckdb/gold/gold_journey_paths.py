"""
gold_journey_paths.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_journey_paths.py.

Brain V4 Phase-2 NET-NEW Gold mart that powers the Journeys **Sankey**: the real path-aggregate that
folds the per-touch journey grain in Iceberg brain_silver.silver_touchpoint into the MOST-COMMON ordered
channel paths per brand, with a per-path journey COUNT and the consecutive channel→channel EDGES a Sankey
draws. NO dbt predecessor (parity status = NEW); repoints NO reader; writes ONLY into
{CATALOG}.brain_gold.gold_journey_paths.

READS the sibling Silver Iceberg table {CATALOG}.brain_silver.silver_touchpoint DIRECTLY (NOT the gated
collector keystone / raw Bronze), exactly as the Spark job reads it via spark.table(). Writes
{CATALOG}.brain_gold.gold_journey_paths honoring MIGRATION_TABLE_SUFFIX.

GRAIN / PK: exactly 1 row per (brand_id, path_signature) — one row per distinct ORDERED channel path that
  at least one journey followed. brand_id is the tenant key, FIRST column. Bounded to the TOP_N most
  common paths per brand (path_rank <= TOP_N); each path bounded to the first MAX_PATH_LEN channels.

THE TRANSFORM (byte-for-byte the Spark _build_sql, deterministic + replay-safe):
  - A "journey" is a (brand_id, brain_anon_id) in silver_touchpoint (grain = 1 row per
    (brand_id, brain_anon_id, touch_seq)).
  - Order each journey's touches by (touch_seq, occurred_at, channel); channel coalesced to 'unknown'
    when blank so a path is never broken by a null node.
  - COLLAPSE consecutive duplicate channels (direct→direct→direct → one 'direct' node).
  - Truncate to the first MAX_PATH_LEN channels.
  - path_signature = the ordered channels joined with ' > '.
  - GROUP BY (brand_id, path_signature, channels): journey_count = journeys that followed the exact path;
    converted_count = how many reached a conversion (stitched_order_id set).
  - RANK within each brand by journey_count desc (deterministic tiebreak: path_signature asc), keep TOP_N.
  - edges[] = the consecutive channel transitions [{step, from_channel, to_channel}, …].

SPARK→DUCKDB SQL TRANSLATIONS (parity-critical):
  - sort_array(collect_list(struct(step0, channel))) then transform(...,x->x.channel)
        → list(channel ORDER BY step0)   (step0 is unique 1..k per journey after the collapse/re-number,
          so ordering the collect by step0 yields the SAME channel sequence, deterministically).
  - array_join(channels, ' > ')          → array_to_string(channels, ' > ').
  - size(channels)                       → len(channels).
  - Spark channels[i] is 0-indexed; DuckDB lists are 1-indexed → channels[i+1].
    channels[0] → channels[1] ; channels[size-1] → channels[-1].
  - edges: transform(sequence(0, size-2), i -> named_struct('step', i, 'from_channel', channels[i],
    'to_channel', channels[i+1]))
        → list_transform(range(0, len(channels)-1),
             i -> struct_pack(step := i::BIGINT,
                              from_channel := channels[i + 1],      -- Spark channels[i]
                              to_channel   := channels[i + 2]))     -- Spark channels[i+1]
    (range(0, n-1) yields 0..n-2 == Spark's sequence(0, size-2); size<2 → empty edges list, same guard).

MONEY: none — a path is not monetary. Only journey/conversion COUNTS.

WRITE: full per-brand RECOMPUTE via DELETE-recomputed-brands + INSERT fresh top-N — NOT a MERGE-upsert.
  Because the keyset is a TOP_N ranking, a MERGE would LEAK stale paths that fell out of the top-N on a
  later run; the DELETE evicts them. Replay-safe: re-running over the same Silver yields byte-identical
  rows. (This is the ONE mart in the DuckDB port that does not use _base.merge_on_pk — the Spark job
  itself uses DELETE+INSERT for exactly this reason; we reproduce that discipline verbatim.)

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (reads already-gated Silver); the
  DuckDB framework never writes a quarantine table either. Nothing to skip.

Parity target: brain_gold.gold_journey_paths (192 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_journey_paths_duckdb_test
# instead of the live mart (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_journey_paths{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"

# Bounds (deterministic, env-overridable — SAME env vars/defaults as the Spark job). Keep the mart finite:
# at most TOP_N paths per brand, each at most MAX_PATH_LEN channels wide.
TOP_N = int(os.environ.get("JOURNEY_PATHS_TOP_N", "50"))
MAX_PATH_LEN = int(os.environ.get("JOURNEY_PATHS_MAX_LEN", "12"))

# Column contract — byte-for-byte the Spark _COLUMNS order/types. brand_id first (tenant key). NO money.
# The array/struct-array columns match the Spark Iceberg schema exactly.
COLUMNS_SQL = """
  brand_id            string NOT NULL,
  path_signature      string NOT NULL,
  path_length         bigint NOT NULL,
  channels            string[],
  edges               struct(step bigint, from_channel string, to_channel string)[],
  first_touch_channel string,
  last_touch_channel  string,
  journey_count       bigint NOT NULL,
  converted_count     bigint NOT NULL,
  path_rank           bigint NOT NULL,
  updated_at          timestamp NOT NULL
""".strip("\n")

# The projected column order — INSERT ... SELECT must line up with the table column order above.
_SELECT_COLS = (
    "brand_id, path_signature, path_length, channels, edges, "
    "first_touch_channel, last_touch_channel, journey_count, converted_count, path_rank, updated_at"
)


def _build_sql(refold_filter: str = "") -> str:
    """The full path-aggregate transform as one DuckDB SQL string (over TOUCHPOINT), verbatim from the
    Spark _build_sql with the Spark→DuckDB translations documented at the top of this file.

    `refold_filter` is a CHANGED-ENTITY semi-join predicate injected into the base `touches` read — it is
    the EMPTY string on a full scan (default OFF / first run / FULL_REFRESH), keeping the generated SQL
    byte-identical to the pre-incremental version, and a `AND brand_id IN (...changed brands...)` clause
    when GOLD_INCREMENTAL windows the run (see build())."""
    return f"""
        with touches as (
            select
                brand_id,
                brain_anon_id,
                touch_seq,
                occurred_at,
                coalesce(nullif(trim(channel), ''), 'unknown') as channel,
                case when stitched_order_id is not null then 1 else 0 end as is_converted
            from {TOUCHPOINT}
            where brand_id is not null and brain_anon_id is not null{refold_filter}
        ),
        ordered as (
            select
                brand_id, brain_anon_id, channel, is_converted,
                row_number() over (
                    partition by brand_id, brain_anon_id
                    order by touch_seq asc, occurred_at asc, channel asc
                ) as rn,
                lag(channel) over (
                    partition by brand_id, brain_anon_id
                    order by touch_seq asc, occurred_at asc, channel asc
                ) as prev_channel
            from touches
        ),
        -- collapse consecutive duplicate channels, then re-number the surviving nodes 1..k
        collapsed as (
            select
                brand_id, brain_anon_id, channel, is_converted,
                row_number() over (
                    partition by brand_id, brain_anon_id
                    order by rn asc
                ) as step0
            from ordered
            where prev_channel is null or prev_channel <> channel
        ),
        capped as (
            select * from collapsed where step0 <= {MAX_PATH_LEN}
        ),
        journeys as (
            select
                brand_id,
                brain_anon_id,
                -- sort_array(collect_list(struct(step0, channel))) then take .channel
                -- → step0 is unique 1..k per journey, so ordering the list by step0 is the SAME sequence.
                list(channel order by step0 asc) as channels,
                max(is_converted) as is_converted
            from capped
            group by brand_id, brain_anon_id
        ),
        journey_sig as (
            select
                brand_id,
                array_to_string(channels, ' > ') as path_signature,
                channels,
                is_converted
            from journeys
            where len(channels) >= 1
        ),
        agg as (
            select
                brand_id,
                path_signature,
                channels,
                cast(count(*) as bigint)          as journey_count,
                cast(sum(is_converted) as bigint) as converted_count
            from journey_sig
            -- path_signature functionally determines channels, so grouping by both is safe.
            group by brand_id, path_signature, channels
        ),
        ranked as (
            select
                a.*,
                row_number() over (
                    partition by brand_id
                    order by journey_count desc, path_signature asc
                ) as path_rank
            from agg a
        )
        select
            brand_id,
            path_signature,
            cast(len(channels) as bigint) as path_length,
            channels,
            case
                when len(channels) < 2
                    then cast([] as struct(step bigint, from_channel string, to_channel string)[])
                else list_transform(
                    range(0, len(channels) - 1),
                    i -> struct_pack(
                        step         := cast(i as bigint),
                        from_channel := channels[i + 1],   -- Spark 0-indexed channels[i]
                        to_channel   := channels[i + 2]     -- Spark 0-indexed channels[i+1]
                    )
                )
            end as edges,
            channels[1]                       as first_touch_channel,
            channels[-1]                      as last_touch_channel,
            journey_count,
            converted_count,
            cast(path_rank as bigint)         as path_rank,
            now() at time zone 'UTC'          as updated_at
        from ranked
        where path_rank <= {TOP_N}
    """


def build(con):
    # brand-first tenant partitioning (mirrors the Spark bucket(8, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(8, brand_id)")

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY (per-brand) REFOLD ─────────────
    #   GRAIN = entity_fold: MANY silver_touchpoint rows fold, per (brand_id, brain_anon_id) journey, into a
    #   per-BRAND TOP_N path ranking whose journey/converted COUNTS depend on the brand's FULL touch history
    #   — including touches BELOW the watermark. Windowing the fold input directly would silently drop that
    #   history → wrong counts / wrong top-N. So we window ONLY to DISCOVER which BRANDS changed (a touch
    #   landed since the last run), then re-fold each changed brand over its FULL, UNWINDOWED touch history.
    #   The DELETE-recomputed-brands + INSERT top-N write then replaces exactly those brands; untouched
    #   brands keep their existing rows. The fold-driving source is silver_touchpoint; it has NO ingested_at
    #   (entity Silver mart), so the arrival/write clock is its NOW-stamped updated_at (ts_col='updated_at').
    #   GOLD_INCREMENTAL gates this INDEPENDENTLY of Silver. Default OFF / first run / FULL_REFRESH → lo=None
    #   → NO changed-set, EMPTY refold_filter → the SQL is byte-identical to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-journey-paths", TOUCHPOINT, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # the touchpoint mart's write clock (updated_at) otherwise. Same brand_id NOT NULL guard as the fold.
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    touch_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-BRAND set: brands whose touchpoints changed within [lo, hi], using the SAME brand_id key +
    # brand_id-NOT-NULL guard the fold uses. Built ONLY when incremental (lo not None).
    changed = f"""
      SELECT DISTINCT brand_id
      FROM {TOUCHPOINT}
      WHERE brand_id IS NOT NULL{touch_window}
    """

    # Semi-join clause injected into the base `touches` read: when incremental, restrict the FULL-history
    # fold to only the changed brands so each re-folds over its ENTIRE touch history. EMPTY when lo is None
    # → unwindowed full recompute (byte-identical to before this edit).
    refold_filter = (
        f"\n              and brand_id in (select brand_id from ({changed}))"
        if lo is not None else ""
    )

    src = _build_sql(refold_filter)
    con.execute(f"CREATE OR REPLACE TEMP TABLE journey_paths_src AS {src}")
    n = con.execute("SELECT count(*) FROM journey_paths_src").fetchone()[0]

    # Full per-brand recompute: DELETE the brands we just recomputed, then INSERT the fresh top-N.
    # A plain MERGE-upsert would leak paths that fell out of the top-N on this run.
    brands = [
        r[0] for r in con.execute(
            "SELECT DISTINCT brand_id FROM journey_paths_src WHERE brand_id IS NOT NULL"
        ).fetchall()
    ]
    if brands:
        in_list = ", ".join("'" + str(b).replace("'", "''") + "'" for b in brands)
        con.execute(f"DELETE FROM {TARGET} WHERE brand_id IN ({in_list})")

    # Name the target columns explicitly: the live table can carry MORE columns than the
    # job writes (schema drift — e.g. the phantom `from_channel` the pre-fix comma-split
    # created), and a bare INSERT ... SELECT binds by position and dies on the count.
    con.execute(f"INSERT INTO {TARGET} ({_SELECT_COLS}) SELECT {_SELECT_COLS} FROM journey_paths_src")
    con.execute("DROP TABLE IF EXISTS journey_paths_src")
    return n


if __name__ == "__main__":
    # The watermark tracks the touchpoint mart's write clock (silver_touchpoint.updated_at), NOT the gated
    # keystone default — this Gold job folds a sibling Silver mart which has no ingested_at (entity mart).
    run_job("gold-journey-paths", build, target_table="gold_journey_paths",
            source_table=TOUCHPOINT, ts_col="updated_at")
