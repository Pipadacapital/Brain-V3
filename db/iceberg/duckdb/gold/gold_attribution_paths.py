"""
gold_attribution_paths.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_attribution_paths.py.

Brain V4 Phase-2 GROUP attribution mart (dbt predecessor gold_attribution_paths.sql). The
JOURNEY/PATH-grain attribution mart — ONE row per CONVERTED journey (brand_id, brain_anon_id,
stitched_order_id) with the ORDERED multi-touch channel path, first/last-touch channel, touch counts,
and the path span. READS Iceberg brain_silver.silver_touchpoint DIRECTLY (exactly like the Spark job via
spark.table()), WRITES Iceberg brain_gold.gold_attribution_paths via MERGE on the PK.

NO MONEY (per the dbt/Spark header): a path is not monetary — there is NO money column. Revenue joins at
read via stitched_order_id → gold_revenue_ledger. So parity is row-identity ONLY (keyed by the PK).

THE TRANSFORM (byte-for-byte the Spark result_sql, with the Spark→DuckDB translations below):
  converted_touches = silver_touchpoint WHERE stitched_order_id IS NOT NULL (a CONVERTED journey — the
                      deterministic read-back stitch; un-stitched journeys have no conversion → excluded).
  endpoints         = per (brand_id, brain_anon_id, stitched_order_id): the first/last touch channel
                      derived from min/max of an lpad(touch_seq,10,'0')||'|'||channel encoding — so the
                      MIN/MAX picks the channel at the smallest/largest touch_seq deterministically.
  result            = GROUP BY (brand_id, brain_anon_id, stitched_order_id):
                        stitched_brain_id        = max(stitched_brain_id)
                        channel_path             = ' > '-join of channels ORDER BY (touch_seq, occurred_at,
                                                   channel)
                        touch_count              = count(*)::bigint
                        distinct_channel_count   = count(distinct channel)::bigint
                        first_touch_channel      = last '|'-segment of max(_first_enc)
                        last_touch_channel       = last '|'-segment of max(_last_enc)
                        path_start_at / path_end_at = min/max(occurred_at)
                        updated_at               = now() (UTC)

SPARK→DUCKDB SQL TRANSLATIONS (parity-critical):
  - array_join(transform(sort_array(collect_list(struct(touch_seq, occurred_at, channel))), x -> x.channel),
    ' > ')   → array_to_string(list(channel ORDER BY touch_seq ASC, occurred_at ASC, channel ASC), ' > ').
    sort_array on struct(touch_seq, occurred_at, channel) sorts lexicographically by those fields in order,
    so ordering the list by exactly (touch_seq, occurred_at, channel) yields the identical channel sequence.
  - substring_index(x, '|', -1)  → string_split(x, '|')[-1]  (last segment after the final '|', 1-indexed
    DuckDB list negative index; NULL-safe: NULL in → NULL out, same as Spark).
  - current_timestamp()  → now() at time zone 'UTC'.
  - lpad(cast(touch_seq as string), 10, '0')  → unchanged (DuckDB lpad has the same 3-arg signature).

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver);
  the DuckDB framework never writes a quarantine table either. Nothing to skip.

DATA NOTE: with 0 stitched touchpoints in the current Silver (stitched_order_id NULL for all rows), the
  converted set is EMPTY → 0 path rows, exactly like the live empty StarRocks/Spark mart (parity-exact).
  If silver_touchpoint is ABSENT the Spark job SystemExits; here the read raises, run_job surfaces it — but
  in the parity corpus the table exists (empty of stitched rows), so this writes a correct empty mart.

Honors MIGRATION_TABLE_SUFFIX (→ gold_attribution_paths_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_attribution_paths.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_attribution_paths_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_attribution_paths"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"

# Column contract — the dbt/Spark gold_attribution_paths select list. brand_id first (tenant key). NO money.
COLUMNS_SQL = """
  brand_id               string    NOT NULL,
  brain_anon_id          string    NOT NULL,
  stitched_order_id      string    NOT NULL,
  stitched_brain_id      string,
  channel_path           string,
  touch_count            bigint    NOT NULL,
  distinct_channel_count bigint    NOT NULL,
  first_touch_channel    string,
  last_touch_channel     string,
  path_start_at          timestamp,
  path_end_at            timestamp,
  updated_at             timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_anon_id", "stitched_order_id", "stitched_brain_id",
    "channel_path", "touch_count", "distinct_channel_count",
    "first_touch_channel", "last_touch_channel",
    "path_start_at", "path_end_at", "updated_at",
]

PK = ["brand_id", "brain_anon_id", "stitched_order_id"]


def build(con):
    # brand-first tenant partitioning (mirrors the Spark bucket(8, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — GRAIN = entity_fold (CHANGED-ENTITY REFOLD) ──
    #   MANY silver_touchpoint rows aggregate into ONE path row per (brand_id, brain_anon_id,
    #   stitched_order_id): channel_path / touch_count / endpoints depend on the CONVERTED journey's FULL set
    #   of touches — including rows BELOW the watermark. Windowing the fold input directly would drop touches
    #   → wrong path / counts. So we window ONLY to DISCOVER which converted journeys changed, then re-fold
    #   each changed journey over its FULL, UNWINDOWED touch set. The source silver_touchpoint is an ENTITY
    #   Silver mart with NO ingested_at — its arrival/write clock is `updated_at` (NOW-stamped on every write:
    #   exactly "which rows changed since last run"); occurred_at is business time (NOT usable — late arrivals
    #   below the watermark would be dropped). Gold flips INDEPENDENTLY of Silver via enabled=GOLD_INCREMENTAL.
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below is
    #   byte-identical to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-attribution-paths", TOUCHPOINT, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # the touchpoint mart's write clock otherwise.
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    tp_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: converted journeys whose touchpoints changed within [lo, hi], using the SAME PK
    # (brand_id, brain_anon_id, stitched_order_id) + the SAME stitched_order_id-NOT-NULL guard the fold uses.
    changed = f"""
      SELECT DISTINCT brand_id, brain_anon_id, stitched_order_id
      FROM {TOUCHPOINT}
      WHERE stitched_order_id IS NOT NULL{tp_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed journeys so each
    # re-folds over its ENTIRE touch set. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        f"            AND (brand_id, brain_anon_id, stitched_order_id) IN "
        f"(SELECT brand_id, brain_anon_id, stitched_order_id FROM ({changed}))\n"
        if lo is not None else ""
    )

    # The dbt/Spark transform, folded into one DuckDB SQL. See the module header for the Spark→DuckDB
    # translations (list(... ORDER BY) for the ordered path; string_split(...)[-1] for substring_index -1).
    staged = f"""
        WITH converted_touches AS (
            SELECT
                brand_id, brain_anon_id, stitched_order_id, stitched_brain_id,
                touch_seq, occurred_at, channel
            FROM {TOUCHPOINT}
            WHERE stitched_order_id IS NOT NULL
{refold_filter}        ),
        endpoints AS (
            SELECT
                brand_id, brain_anon_id, stitched_order_id,
                min(CASE WHEN touch_seq IS NOT NULL
                         THEN concat(lpad(CAST(touch_seq AS VARCHAR), 10, '0'), '|', channel) END) AS _first_enc,
                max(CASE WHEN touch_seq IS NOT NULL
                         THEN concat(lpad(CAST(touch_seq AS VARCHAR), 10, '0'), '|', channel) END) AS _last_enc
            FROM converted_touches
            GROUP BY brand_id, brain_anon_id, stitched_order_id
        ),
        ordered_paths AS (
            SELECT
                brand_id, brain_anon_id, stitched_order_id,
                max(stitched_brain_id) AS stitched_brain_id,
                -- sort_array(collect_list(struct(touch_seq, occurred_at, channel))) then .channel
                -- → list(channel ORDER BY touch_seq, occurred_at, channel), ' > '-joined. Byte-identical.
                array_to_string(
                    list(channel ORDER BY touch_seq ASC, occurred_at ASC, channel ASC),
                    ' > '
                ) AS channel_path,
                CAST(count(*) AS BIGINT)                AS touch_count,
                CAST(count(DISTINCT channel) AS BIGINT) AS distinct_channel_count,
                min(occurred_at)                        AS path_start_at,
                max(occurred_at)                        AS path_end_at
            FROM converted_touches
            GROUP BY brand_id, brain_anon_id, stitched_order_id
        )
        SELECT
            p.brand_id, p.brain_anon_id, p.stitched_order_id, p.stitched_brain_id,
            p.channel_path, p.touch_count, p.distinct_channel_count,
            string_split(e._first_enc, '|')[-1] AS first_touch_channel,
            string_split(e._last_enc,  '|')[-1] AS last_touch_channel,
            p.path_start_at, p.path_end_at,
            now() AT TIME ZONE 'UTC' AS updated_at
        FROM ordered_paths p
        JOIN endpoints e
          ON p.brand_id = e.brand_id
         AND p.brain_anon_id = e.brain_anon_id
         AND p.stitched_order_id = e.stitched_order_id
    """

    # The rollup is already 1 row per PK (GROUP BY upstream), so merge_on_pk's in-batch dedup is a no-op;
    # order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    # The watermark tracks the touchpoint mart's write clock (silver_touchpoint.updated_at) — this Gold job
    # reads a sibling Silver mart that has no ingested_at.
    run_job("gold-attribution-paths", build, target_table=TABLE,
            source_table=TOUCHPOINT, ts_col="updated_at")
