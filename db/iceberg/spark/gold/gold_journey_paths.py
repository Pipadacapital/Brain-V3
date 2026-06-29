"""
gold_journey_paths.py — Brain V4 Phase-2 NET-NEW Gold mart that powers the Journeys **Sankey**.

THE GAP IT CLOSES: the Journeys tab currently renders an interim "storefront stage funnel" — a
fixed, hand-shaped funnel — not a real aggregate of how customers actually move across CHANNELS.
This mart is the real path-aggregate: it folds the per-touch journey grain in Iceberg
brain_silver.silver_touchpoint into the MOST-COMMON ordered channel paths per brand, with a per-path
journey COUNT and the consecutive channel→channel EDGES a Sankey draws. It has NO dbt predecessor
(parity status = NEW); it repoints NO reader, changes NO existing mart, and writes ONLY into
brain_gold.gold_journey_paths. The thin Trino projection db/trino/views/mv_gold_journey_paths.sql
serves it; the Wire slice reads that view to build the Sankey.

GRAIN: exactly 1 row per (brand_id, path_signature) — one row per distinct ORDERED channel path that
at least one journey followed. brand_id is the tenant key, FIRST column. Bounded to the TOP_N most
common paths per brand (path_rank <= TOP_N) so the mart can never explode; each path is itself bounded
to the first MAX_PATH_LEN channels.

THE TRANSFORM (deterministic, replay-safe):
  - A "journey" is a (brand_id, brain_anon_id) in silver_touchpoint (its grain is 1 row per
    (brand_id, brain_anon_id, touch_seq) — every touch in journey order).
  - Order each journey's touches by (touch_seq, occurred_at, channel); channel is coalesced to
    'unknown' when blank so a path is never broken by a null node.
  - COLLAPSE consecutive duplicate channels (direct→direct→direct becomes one 'direct' node) — the
    standard channel-path normalization so the Sankey shows transitions, not self-loops.
  - Truncate to the first MAX_PATH_LEN channels (bound per-path width).
  - path_signature = the ordered channels joined with ' > ' (e.g. 'paid_search > email > direct').
  - GROUP BY (brand_id, path_signature, channels): journey_count = number of journeys that followed
    the exact path; converted_count = how many of those reached a conversion (stitched_order_id set).
  - RANK within each brand by journey_count desc (deterministic tiebreak: path_signature asc) and keep
    the TOP_N. edges[] = the consecutive channel transitions [{step, from_channel, to_channel}, …].

PER-STEP / PER-EDGE DROP-OFF (how the Sankey reads it): explode edges[] across the brand's rows and
sum journey_count grouped by (step, from_channel, to_channel) → those are the Sankey LINK weights. The
drop-off at a node = (journeys that REACHED it = Σ inbound, or Σ journey_count of paths whose length
> step) MINUS (journeys that CONTINUED = Σ outbound at that step). A path whose length == step+1 is a
journey that ended at that node (a drop). first_touch_channel / last_touch_channel give the endpoints.

MONEY: none. A path is not monetary (mirrors gold_attribution_paths); revenue joins downstream by the
order. So this mart's only counts are journey/conversion COUNTS — no minor-unit money column.

WRITE: full per-brand RECOMPUTE. Because the keyset is a TOP_N ranking, a MERGE-upsert would leak
stale paths that fell out of the top-N on a later run; instead we DELETE the recomputed brands then
INSERT the fresh top-N. Replay-safe: re-running over the same Silver yields byte-identical rows.

Run via run-gold-journey-paths.sh (auto-discovered by tools/dev/v4-refresh-loop.sh).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # gold/ — for _gold_base
from _gold_base import gold_partition_filter  # noqa: E402

TABLE_NAME = "gold_journey_paths"

# Bounds (deterministic, env-overridable for tuning without a code change). Keep the mart finite:
# at most TOP_N paths per brand, each at most MAX_PATH_LEN channels wide.
TOP_N = int(os.environ.get("JOURNEY_PATHS_TOP_N", "50"))
MAX_PATH_LEN = int(os.environ.get("JOURNEY_PATHS_MAX_LEN", "12"))

# Column contract. brand_id first (tenant key). NO money. The Sankey consumes channels[]/edges[].
# Keep each column on ONE line — iceberg_base._parse_column_defs splits on NEWLINES (so the commas
# inside array<struct<…>> are safe) and strips a trailing NOT NULL.
_COLUMNS = """
          brand_id            string                                                              NOT NULL,
          path_signature      string                                                              NOT NULL,
          path_length         bigint                                                              NOT NULL,
          channels            array<string>,
          edges               array<struct<step: bigint, from_channel: string, to_channel: string>>,
          first_touch_channel string,
          last_touch_channel  string,
          journey_count       bigint                                                              NOT NULL,
          converted_count     bigint                                                              NOT NULL,
          path_rank           bigint                                                              NOT NULL,
          updated_at          timestamp                                                           NOT NULL
""".strip("\n")

# The projected column order — INSERT ... SELECT must line up with the table column order above.
_SELECT_COLS = (
    "brand_id, path_signature, path_length, channels, edges, "
    "first_touch_channel, last_touch_channel, journey_count, converted_count, path_rank, updated_at"
)


def _read_silver_touchpoint(spark: SparkSession):
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
    try:
        df = spark.table(fqtn)
        df.schema  # force resolution
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            raise SystemExit(
                f"[gold_journey_paths] REQUIRED Iceberg table {fqtn} is absent — build the Phase-1 "
                f"silver_touchpoint Spark mart first (run-silver-touchpoint-sessions.sh)."
            )
        raise


def _build_sql() -> str:
    """The full path-aggregate transform as one Spark SQL string (over the temp view silver_touchpoint)."""
    return f"""
        with touches as (
            select
                brand_id,
                brain_anon_id,
                touch_seq,
                occurred_at,
                coalesce(nullif(trim(channel), ''), 'unknown') as channel,
                case when stitched_order_id is not null then 1 else 0 end as is_converted
            from silver_touchpoint
            where brand_id is not null and brain_anon_id is not null
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
                transform(
                    sort_array(collect_list(struct(step0, channel))),
                    x -> x.channel
                ) as channels,
                max(is_converted) as is_converted
            from capped
            group by brand_id, brain_anon_id
        ),
        journey_sig as (
            select
                brand_id,
                array_join(channels, ' > ') as path_signature,
                channels,
                is_converted
            from journeys
            where size(channels) >= 1
        ),
        agg as (
            select
                brand_id,
                path_signature,
                channels,
                cast(count(*) as bigint)          as journey_count,
                cast(sum(is_converted) as bigint) as converted_count
            from journey_sig
            -- path_signature functionally determines channels, so grouping by both is safe and
            -- avoids any aggregate over the array<string> column (no max(channels)).
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
            cast(size(channels) as bigint) as path_length,
            channels,
            case
                when size(channels) < 2
                    then cast(array() as array<struct<step: bigint, from_channel: string, to_channel: string>>)
                else transform(
                    sequence(0, size(channels) - 2),
                    i -> named_struct(
                        'step', cast(i as bigint),
                        'from_channel', channels[i],
                        'to_channel', channels[i + 1]
                    )
                )
            end as edges,
            channels[0]                       as first_touch_channel,
            channels[size(channels) - 1]      as last_touch_channel,
            journey_count,
            converted_count,
            cast(path_rank as bigint)         as path_rank,
            current_timestamp()               as updated_at
        from ranked
        where path_rank <= {TOP_N}
    """


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(8, brand_id)"
    )
    _tp = _read_silver_touchpoint(spark)
    _tp, _commit_wm = gold_partition_filter(
        spark, _tp, table_name=TABLE_NAME, source_tables=["silver_touchpoint"],
    )
    _tp.createOrReplaceTempView("silver_touchpoint")

    spark.sql(_build_sql()).createOrReplaceTempView("journey_paths_src")
    n = spark.table("journey_paths_src").count()

    # Full per-brand recompute: DELETE the brands we just recomputed, then INSERT the fresh top-N.
    # This evicts paths that fell out of the top-N on this run (a plain MERGE-upsert would leak them).
    brands = [
        r["brand_id"]
        for r in spark.sql("select distinct brand_id from journey_paths_src").collect()
        if r["brand_id"] is not None
    ]
    if brands:
        in_list = ", ".join("'" + str(b).replace("'", "''") + "'" for b in brands)
        spark.sql(f"DELETE FROM {fqtn} WHERE brand_id IN ({in_list})")

    spark.sql(f"INSERT INTO {fqtn} SELECT {_SELECT_COLS} FROM journey_paths_src")

    total = spark.table(fqtn).count()
    print(
        f"[gold_journey_paths] recomputed {n} top-{TOP_N} path rows across {len(brands)} brand(s) "
        f"→ {fqtn} (table now {total} rows)",
        flush=True,
    )
    _commit_wm()  # advance watermark after the write succeeded
    return fqtn


def main() -> None:
    spark = build_spark("gold-journey-paths")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[gold_journey_paths] DONE — Iceberg journey-path Sankey mart populated ✓", flush=True)


if __name__ == "__main__":
    main()
