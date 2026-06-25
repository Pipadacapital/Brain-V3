"""
silver_sessions.py — Brain V4 Phase 1 (Spark Silver, dual-run). GROUP=touchpoint+sessions.

Reimplements the dbt model db/dbt/models/marts/silver_sessions.sql as a Spark job that READS the
Iceberg brain_silver.silver_touchpoint mart (built by silver_touchpoint.py, the per-touch grain) and
WRITES Iceberg brain_silver.silver_sessions, reproducing the dbt SQL transform EXACTLY. This runs
BESIDE the live dbt→StarRocks brain_silver (dual-run, NON-BREAKING). It repoints no reader, changes no
dbt model, changes no app code.

THE FOLD (dbt silver_sessions.sql, inlined verbatim): roll the per-TOUCH grain up to one row per
SESSION (brand_id, brain_anon_id, session_key) — the natural unit funnel/engagement COUNT DISTINCT over.
Per session: touch_count, pageview/product-view counts, entry/exit channel + entry page_type
(deterministic by touch order via the order-encoded min/max trick), session start/end + duration_seconds,
a bounce flag (touch_count = 1), and a converted flag (any touch stitched to an order — D-5, never
inferred).

GRAIN: exactly 1 row per (brand_id, brain_anon_id, session_key).
NO MONEY: sessions are not monetary — there is NO money column in this mart (dbt asserts the same).
brand_id is the tenant key, first column. Only the opaque anon id rides through (no raw PII).
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, brain_anon_id, session_key) — re-run yields identical rows.

DEPENDENCY: this reads the Iceberg silver_touchpoint (NOT the StarRocks one) so the dual-run Silver
session grain is derived from the dual-run touch grain — exactly the dbt lineage (silver_sessions
ref's silver_touchpoint). Run silver_touchpoint.py FIRST.

PARITY NOTE — entry/exit by touch order: dbt encodes channel/page_type with a zero-padded touch_seq
prefix (lpad(touch_seq,10,'0') || '|' || value) so min()/max() over the encoded string resolves the
FIRST/LAST touch deterministically by ORDER, not by value; substring_index(...,'|',-1) then peels the
value back off. Spark has lpad / substring_index with identical semantics, so the encoding is reproduced
verbatim → byte-identical entry/exit values.
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession

from iceberg_base import (  # noqa: E402 — sys.path tweak above
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

SILVER_TOUCHPOINT_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
TABLE_NAME = "silver_sessions"

# Mirrors silver_sessions.sql column order/types (StarRocks: varchar/int/bigint/datetime/boolean).
_COLUMNS = """
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


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(256, brand_id)",
    )

    spark.read.table(SILVER_TOUCHPOINT_TABLE).createOrReplaceTempView("silver_touchpoint")

    # ── silver_sessions: roll the touch grain up to the session grain (verbatim dbt fold) ──
    session_sql = """
        with touches as (
            select
                brand_id, brain_anon_id, session_key, session_seq, touch_seq, occurred_at,
                event_type, channel, page_type, stitched_order_id,
                concat(lpad(cast(touch_seq as string), 10, '0'), '|', coalesce(channel, ''))   as _ch_enc,
                concat(lpad(cast(touch_seq as string), 10, '0'), '|', coalesce(page_type, '')) as _pt_enc
            from silver_touchpoint
        )
        select
            brand_id,
            brain_anon_id,
            session_key,
            max(session_seq)                                                       as session_seq,
            cast(count(*) as bigint)                                               as touch_count,
            cast(sum(case when event_type = 'page.viewed' then 1 else 0 end) as bigint)    as pageview_count,
            cast(sum(case when event_type = 'product.viewed' then 1 else 0 end) as bigint) as product_view_count,
            substring_index(min(_ch_enc), '|', -1)                                as entry_channel,
            substring_index(max(_ch_enc), '|', -1)                                as exit_channel,
            substring_index(min(_pt_enc), '|', -1)                                as entry_page_type,
            min(occurred_at)                                                      as session_start_at,
            max(occurred_at)                                                      as session_end_at,
            -- StarRocks timestampdiff(second, start, end) TRUNCATES the *difference* of the full-precision
            -- timestamps (verified: timestampdiff(s, 17:01:17.992, 17:14:20.326) = 782, not 783). Spark's
            -- unix_timestamp() floors EACH endpoint to whole seconds first, which differs by ±1 second when
            -- the fractional parts cross a boundary. To be byte-identical we floor the difference of the
            -- full-precision epoch (double seconds incl. fraction), not each endpoint.
            cast(
                floor(
                    cast(max(occurred_at) as double) - cast(min(occurred_at) as double)
                ) as bigint
            )                                                                     as duration_seconds,
            (count(*) = 1)                                                        as is_bounce,
            (max(case when stitched_order_id is not null then 1 else 0 end) = 1)  as is_converted,
            current_timestamp()                                                  as updated_at
        from touches
        group by brand_id, brain_anon_id, session_key
    """
    spark.sql(session_sql).createOrReplaceTempView("silver_sessions_new")

    # Idempotent MERGE on the (brand_id, brain_anon_id, session_key) PK — replay-safe upsert.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING silver_sessions_new s
        ON t.brand_id = s.brand_id AND t.brain_anon_id = s.brain_anon_id AND t.session_key = s.session_key
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[silver_sessions] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("silver-sessions")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)


if __name__ == "__main__":
    main()
