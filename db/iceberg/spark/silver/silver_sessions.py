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

STAGE-1 GATE (Brain V4 two-stage, _silver_technical): silver_sessions is a derived ROLLUP of the
  already-gated sibling Silver mart silver_touchpoint (not raw Bronze), so — exactly like silver_customer
  rolls up silver_order_state — the ONLY Stage-1 rule with a target here is the timestamp gate. A session's
  session_start_at (= min touch occurred_at) is run through dq_check (occurred_at only); a session whose
  start is future-dated/unparseable is diverted to brain_silver.silver_quarantine (stage='dq') with a
  reconstructable JSON payload (the session identity), and is NOT written to silver_sessions. N/A: money/
  currency (sessions carry NO money — no money column), impossible_quantity (touch_count/pageview_count are
  aggregate counts, not a per-record quantity), empty_identifier (the (brand_id, brain_anon_id, session_key)
  PK is structurally derived/NOT NULL), clean_name/clean_string (channel/page_type are enums, not display
  names). Good rows are byte-identical to before (parity-faithful).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession
from pyspark.sql.functions import (  # noqa: E402
    array_join,
    col,
    concat_ws,
    lit,
    size,
    struct,
    to_json,
)

from iceberg_base import (  # noqa: E402 — sys.path tweak above
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
    run_entity_incremental,
)
from _silver_technical import dq_violations_udf, write_quarantine  # noqa: E402

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


def _fold_and_merge(spark: SparkSession, fqtn: str) -> None:
    """Roll the touch grain up to the session grain + MERGE, over the CURRENTLY registered
    `silver_touchpoint` view (one entity-incremental bucket of visitors carrying their full touch
    history — so the per-session group-by is complete). Sessions aggregate a visitor's touches, so the
    driver hash-buckets by brain_anon_id to keep a visitor's touches together."""
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
    # ── Stage-1 DQ gate: future/unparseable session_start_at → quarantine(stage='dq') (see module docstring) ──
    gated = spark.sql(session_sql).withColumn(
        "_dq",
        dq_violations_udf()(
            lit(None).cast("bigint"), lit(None).cast("string"),
            col("session_start_at").cast("string"), lit(None).cast("bigint"),
        ),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            lit("silver_touchpoint").alias("source"),
            concat_ws("|", col("brand_id"), col("brain_anon_id"), col("session_key").cast("string")).alias(
                "bronze_event_id"
            ),
            lit(TABLE_NAME).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            to_json(
                struct("brand_id", "brain_anon_id", "session_key", "session_start_at", "session_end_at")
            ).alias("payload"),
        ),
        stage="dq",
    )
    gated.where(size(col("_dq")) == 0).drop("_dq").createOrReplaceTempView("silver_sessions_new")

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


def build(spark: SparkSession) -> str:
    """ENTITY-INCREMENTAL (entity = visitor brain_anon_id): sessions aggregate a visitor's touches, so
    reprocess only visitors whose silver_touchpoint rows changed since the watermark (touchpoint stamps
    updated_at when it re-folds a visitor → chains the incrementality), each over their FULL touch
    history, hash-bucketed. FULL_REFRESH=1 re-folds all. Source = silver_touchpoint (no ingested_at →
    watermark on updated_at via the side-table)."""
    fqtn = create_iceberg_table(
        spark, SILVER_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(256, brand_id)",
    )
    run_entity_incremental(
        spark,
        table_name=TABLE_NAME,
        source_fqtn=SILVER_TOUCHPOINT_TABLE,
        event_filter=lit(True),
        entity_expr=col("brain_anon_id"),
        fold_fn=lambda: _fold_and_merge(spark, fqtn),
        view_name="silver_touchpoint",
        time_col="updated_at",
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
