"""
silver_touchpoint.py — Brain V4 Phase 1 (Spark Silver, dual-run). GROUP=touchpoint+sessions.

Reimplements the dbt model db/dbt/models/marts/silver_touchpoint.sql as a Spark job that READS
Iceberg Bronze (rest.brain_bronze.collector_events) + the PG ops.silver_journey_stitch
export, and WRITES Iceberg brain_silver.silver_touchpoint, reproducing the dbt SQL transform EXACTLY.
This runs BESIDE the live dbt→StarRocks brain_silver (dual-run, NON-BREAKING). It repoints no reader,
changes no dbt model, changes no app code.

THE FOLDED TRANSFORM CHAIN (dbt → Spark, inlined here so this one job reproduces the whole pipeline):
  stg_touchpoint_events.sql      — read the journey/behavioral event set from Bronze, type
                                   payload.properties.* (brain_anon_id / session_id / utm / click_ids /
                                   page_type / …), DROP rows with no brain_anon_id (cannot sessionize),
                                   dedup on the Bronze idempotency key (brand_id, event_id).
  int_touchpoint_sessionized.sql — 30-min-inactivity sessionization (server-re-derived, replay-stable),
                                   session_seq = running sum of the boundary flag, session_key =
                                   murmur_hash3_32(brand_id|brain_anon_id|session_seq), touch_seq =
                                   row_number over the anon journey, is_first/is_last flags, the
                                   deterministic channel CASE ladder, referrer_host extraction.
  silver_touchpoint.sql          — LEFT JOIN the deterministic cart-stitch map (read-back, never
                                   inferred — D-5), + the 400-day TTL/partition-window guard.

GRAIN: exactly 1 row per (brand_id, brain_anon_id, touch_seq) — every touch in journey order.
NO MONEY: touchpoints are not monetary — there is NO money column in this mart (dbt asserts the same).
brand_id is the tenant key, first column. Only hashed/anon identifiers ride through (brain_anon_id is an
opaque pixel anon id, never raw PII).
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, brain_anon_id, touch_seq) — re-run yields identical rows.

PARITY-CRITICAL DETAIL — session_key:
  dbt's silver chain computes session_key = murmur_hash3_32(concat_ws('|', brand_id, brain_anon_id,
  cast(session_seq as string))) on StarRocks. StarRocks' murmur_hash3_32 is MurmurHash3 x86 32-bit over
  the UTF-8 bytes of the string with SEED 104729 (verified empirically: murmur_hash3_32('') = -965378730,
  murmur_hash3_32('b|a|1') = -392793285, murmur_hash3_32('hello') = 1321743225 — all reproduced only with
  seed 104729). Spark's built-in hash()/xxhash64 do NOT match it, so we register a UDF that computes the
  exact same algorithm + seed and returns a signed 32-bit int → byte-identical session_key to the dbt SoR.

The cart-stitch map (silver_journey_stitch) is read from PG ops.silver_journey_stitch (brain_ops moved
to the PG `ops` schema — PG is the operational-only store) over PG JDBC — not a second source.

STAGE-1 GATE (Brain V4 two-stage, _silver_technical): the gate runs over the TYPED source rows BEFORE the
  sessionization/dedup fold (so a bad touch never gets a touch_seq), routing rejects → stage='dq'. NO money
  on this mart, so two rules apply:
    - empty_identifier:brain_anon_id — stg_touchpoint_events ALREADY drops no-anon rows (cannot sessionize,
      the exact dbt stg logic). That silent drop is REPLACED by a routed write_quarantine — the admitted set
      (and dbt parity) is unchanged; the diverted rows are now observable + replayable.
    - future/unparseable timestamp — each kept touch runs through dq_check (occurred_at only); a bad-timestamp
      touch is diverted to silver_quarantine instead of being session-keyed and folded.
  N/A: money/currency (no money column), impossible_quantity (no quantity field), clean_name/clean_string
  (utm/page_type/search_query/landing_path are campaign metadata/URLs/enums — cleaning would perturb the
  dbt-parity values). Bronze keeps every original (replay-safe); surviving touches are byte-identical
  (parity-faithful).

Run via run-silver-touchpoint-sessions.sh (Iceberg + PG JDBC packages).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # silver/ — for _silver_technical

from datetime import timedelta

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    abs as abs_, array_join, col, get_json_object, hash as hash_, lit, size,
)
from pyspark.sql.types import IntegerType

from iceberg_base import (  # noqa: E402 — sys.path tweak above
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
    read_job_watermark,
    write_job_watermark,
)
from _silver_technical import dq_violations_udf, write_quarantine  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
# ADR-0006 P3: read the GATED collector source (brain_silver.silver_collector_event) — the R2/R3
# admission gate now lives in Silver (silver_collector_event.py) over the RAW Kafka-Connect Bronze,
# not in the retired Spark sink. Same `payload`-is-the-full-envelope column contract, so the
# get_json_object extraction below is unchanged. Override SILVER_NAMESPACE for tests.
_SILVER_NS = os.environ.get("SILVER_NAMESPACE", "brain_silver")
BRONZE_TABLE = f"{CATALOG}.{_SILVER_NS}.silver_collector_event"
TABLE_NAME = "silver_touchpoint"

# CURRENT-side cart-stitch read — over PG JDBC now (brain_ops moved to PG schema `ops`; PG is the
# operational-only store). Superuser RLS-bypass ETL read.
PG_JDBC_URL = os.environ.get("SILVER_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("SILVER_PG_USER", "brain")
PG_PASSWORD = os.environ.get("SILVER_PG_PASSWORD", "brain")

# The exact journey/behavioral event set stg_touchpoint_events.sql admits from Bronze (verbatim).
TOUCHPOINT_EVENT_TYPES = (
    "'page.viewed', 'product.viewed', 'collection.viewed', 'cart.viewed', 'cart.item_added', "
    "'cart.item_removed', 'cart.updated', 'search.submitted', 'checkout.started', "
    "'checkout.step_viewed', 'checkout.shipping_selected', 'payment.initiated', 'payment.succeeded', "
    "'payment.failed', 'order.placed', 'purchase.completed', 'coupon.applied', 'form.submitted', "
    "'user.logged_in', 'user.signed_up', 'identify', 'scroll.depth', 'element.clicked', "
    "'rage.click', 'dead.click'"
)

# Python list form of TOUCHPOINT_EVENT_TYPES (for the entity-incremental affected-visitor discovery +
# bucket filter via DataFrame .isin()). Parsed from the same SQL-literal constant → always in sync.
_TP_TYPES = [t.strip().strip("'") for t in TOUCHPOINT_EVENT_TYPES.replace("\n", " ").split(",") if t.strip()]

# StarRocks murmur_hash3_32 seed (verified: see module docstring). MurmurHash3 x86 32-bit over UTF-8 bytes.
MURMUR_SEED = int(os.environ.get("MURMUR_HASH3_SEED", "104729"))

# Mirrors silver_touchpoint.sql column order/types (StarRocks: varchar/bigint/int/boolean/datetime).
_COLUMNS = """
          brand_id          string    NOT NULL,
          brain_anon_id     string    NOT NULL,
          touch_seq         bigint    NOT NULL,
          session_key       int,
          session_seq       bigint,
          is_first_touch    boolean,
          is_last_touch     boolean,
          occurred_at       timestamp,
          event_type        string,
          channel           string,
          utm_source        string,
          utm_medium        string,
          utm_campaign      string,
          utm_term          string,
          utm_content       string,
          fbclid            string,
          gclid             string,
          ttclid            string,
          msclkid           string,
          gbraid            string,
          wbraid            string,
          dclid             string,
          referrer_host     string,
          landing_path      string,
          page_type         string,
          product_handle    string,
          collection_handle string,
          search_query      string,
          stitched_order_id string,
          stitched_brain_id string,
          is_synthetic      boolean,
          session_id_raw    string,
          updated_at        timestamp NOT NULL
""".strip("\n")


def _murmur3_x86_32(data: bytes, seed: int) -> int:
    """MurmurHash3 x86 32-bit over the raw bytes (reference impl) — matches StarRocks murmur_hash3_32."""
    c1 = 0xCC9E2D51
    c2 = 0x1B873593
    length = len(data)
    h1 = seed & 0xFFFFFFFF
    rounded_end = length & ~0x3
    for i in range(0, rounded_end, 4):
        k1 = (
            (data[i] & 0xFF)
            | ((data[i + 1] & 0xFF) << 8)
            | ((data[i + 2] & 0xFF) << 16)
            | ((data[i + 3] & 0xFF) << 24)
        )
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = ((k1 << 15) | (k1 >> 17)) & 0xFFFFFFFF
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1
        h1 = ((h1 << 13) | (h1 >> 19)) & 0xFFFFFFFF
        h1 = (h1 * 5 + 0xE6546B64) & 0xFFFFFFFF
    k1 = 0
    tail = length & 0x3
    if tail == 3:
        k1 ^= (data[rounded_end + 2] & 0xFF) << 16
    if tail >= 2:
        k1 ^= (data[rounded_end + 1] & 0xFF) << 8
    if tail >= 1:
        k1 ^= data[rounded_end] & 0xFF
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = ((k1 << 15) | (k1 >> 17)) & 0xFFFFFFFF
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1
    h1 ^= length
    h1 ^= h1 >> 16
    h1 = (h1 * 0x85EBCA6B) & 0xFFFFFFFF
    h1 ^= h1 >> 13
    h1 = (h1 * 0xC2B2AE35) & 0xFFFFFFFF
    h1 ^= h1 >> 16
    return h1


def _register_murmur_udf(spark: SparkSession) -> None:
    """Register sr_murmur_hash3_32(str) → signed int, byte-identical to StarRocks murmur_hash3_32."""
    seed = MURMUR_SEED

    def _udf(s):
        if s is None:
            return None
        u = _murmur3_x86_32(s.encode("utf-8"), seed)
        return u - 0x100000000 if u >= 0x80000000 else u  # to signed 32-bit (StarRocks INT)

    spark.udf.register("sr_murmur_hash3_32", _udf, IntegerType())


def _read_stitch(spark: SparkSession):
    """Deterministic cart-stitch map from the PG export (ops.silver_journey_stitch).

    silver_touchpoint.sql LEFT JOINs the journey-stitch export. brain_ops moved to the PG `ops` schema
    (PG operational-only store), so we read ops.silver_journey_stitch directly over PG JDBC — the join is
    against the identical stitch SoR. Returns None when the export table is absent/empty (→ all stitch
    NULL, dbt parity when the stitch map has 0 rows, which is the current local state)."""
    query = (
        "(SELECT brand_id, stitched_anon_id, order_id, brain_id AS stitched_brain_id, created_at "
        "FROM ops.silver_journey_stitch) s"
    )
    try:
        return (
            spark.read.format("jdbc")
            .option("url", PG_JDBC_URL)
            .option("user", PG_USER)
            .option("password", PG_PASSWORD)
            .option("driver", "org.postgresql.Driver")
            .option("dbtable", query)
            .load()
        )
    except Exception as exc:  # noqa: BLE001 — export absent → no stitch (dbt parity when 0 stitch rows)
        print(f"[silver_touchpoint] silver_journey_stitch unavailable ({exc}); stitch → null", flush=True)
        return None


def _fold_and_merge(spark: SparkSession, fqtn: str, stitch_join: str, stitched_order: str, stitched_brain: str) -> None:
    """Run the touchpoint sessionization fold + idempotent MERGE over whatever `bronze_events` view is
    CURRENTLY registered. For ENTITY-INCREMENTAL the caller registers it as one hash-bucket of the
    visitors (brand_id, brain_anon_id) that have NEW touchpoint events, carrying each visitor's FULL
    history — so sessionization (session_seq / touch_seq / first-last) is complete and never mis-split.
    The murmur UDF + the stitch_one view are registered ONCE by build() (bucket-independent)."""
    # ── stg_touchpoint_events: type payload.properties.* (carrying pj for replay), Stage-1 gate, dedup ──
    # The typed `source` projection — carries pj so the Stage-1 gate can quarantine a replayable original.
    source_sql = f"""
        with raw as (
            select brand_id, event_id, event_type, occurred_at, payload as pj
            from bronze_events
            where event_type in ({TOUCHPOINT_EVENT_TYPES})
        )
        select
            brand_id, event_id, event_type, occurred_at, pj,
            get_json_object(pj, '$.properties.brain_anon_id')       as brain_anon_id,
            get_json_object(pj, '$.properties.session_id')          as session_id_raw,
            get_json_object(pj, '$.properties.utm.source')          as utm_source,
            get_json_object(pj, '$.properties.utm.medium')          as utm_medium,
            get_json_object(pj, '$.properties.utm.campaign')        as utm_campaign,
            get_json_object(pj, '$.properties.utm.term')            as utm_term,
            get_json_object(pj, '$.properties.utm.content')         as utm_content,
            get_json_object(pj, '$.properties.click_ids.fbclid')    as fbclid,
            get_json_object(pj, '$.properties.click_ids.gclid')     as gclid,
            get_json_object(pj, '$.properties.click_ids.ttclid')    as ttclid,
            get_json_object(pj, '$.properties.click_ids.msclkid')   as msclkid,
            get_json_object(pj, '$.properties.click_ids.gbraid')    as gbraid,
            get_json_object(pj, '$.properties.click_ids.wbraid')    as wbraid,
            get_json_object(pj, '$.properties.click_ids.dclid')     as dclid,
            get_json_object(pj, '$.properties.referrer')            as referrer,
            get_json_object(pj, '$.properties.landing_path')        as landing_path,
            get_json_object(pj, '$.properties.page_type')           as page_type,
            get_json_object(pj, '$.properties.product_handle')      as product_handle,
            get_json_object(pj, '$.properties.collection_handle')   as collection_handle,
            get_json_object(pj, '$.properties.query')               as search_query,
            case when get_json_object(pj, '$.properties._synthetic') = 'true'
                 then true else false end                           as is_synthetic
        from raw
    """
    src = spark.sql(source_sql).where(col("brand_id").isNotNull() & col("event_id").isNotNull())

    # ── Stage-1 empty_identifier: REPLACE the silent no-anon drop with a routed quarantine (observable) ──
    anon_missing = src.where(col("brain_anon_id").isNull() | (col("brain_anon_id") == lit("")))
    write_quarantine(
        spark,
        anon_missing.select(
            col("brand_id"),
            col("event_type").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE_NAME).alias("canonical_target"),
            lit("empty_identifier:brain_anon_id").alias("reason"),
            col("pj").alias("payload"),
        ),
        stage="dq",
    )
    keyed = src.where(col("brain_anon_id").isNotNull() & (col("brain_anon_id") != lit("")))

    # ── Stage-1 DQ gate (per touch): future/unparseable occurred_at → quarantine(stage='dq') ──
    gated = keyed.withColumn(
        "_dq",
        dq_violations_udf()(
            lit(None).cast("bigint"), lit(None).cast("string"),
            col("occurred_at").cast("string"), lit(None).cast("bigint"),
        ),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            col("event_type").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE_NAME).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("pj").alias("payload"),
        ),
        stage="dq",
    )
    gated.where(size(col("_dq")) == 0).drop("_dq", "pj").createOrReplaceTempView("stg_touchpoint_events_gated")

    # Dedup the Bronze idempotency key (brand_id, event_id) over the gated rows — the exact dbt stg dedup.
    spark.sql(
        """
        select
            brand_id, event_id, event_type, occurred_at, brain_anon_id, session_id_raw,
            utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            fbclid, gclid, ttclid, msclkid, gbraid, wbraid, dclid,
            referrer, landing_path, page_type, product_handle, collection_handle,
            search_query, is_synthetic
        from (
            select *,
                row_number() over (
                    partition by brand_id, event_id
                    order by occurred_at asc
                ) as _dedup_rn
            from stg_touchpoint_events_gated
        )
        where _dedup_rn = 1
        """
    ).createOrReplaceTempView("stg_touchpoint_events")

    # ── int_touchpoint_sessionized: 30-min sessionization + channel ladder + first/last + referrer_host ──
    sessionized_sql = """
        with boundaries as (
            select *,
                lag(occurred_at) over (
                    partition by brand_id, brain_anon_id order by occurred_at asc
                ) as prev_occurred_at
            from stg_touchpoint_events
        ),
        flagged as (
            select *,
                case
                    when prev_occurred_at is null then 1
                    when (cast(unix_timestamp(occurred_at) as bigint)
                          - cast(unix_timestamp(prev_occurred_at) as bigint)) > 1800 then 1
                    else 0
                end as is_session_start
            from boundaries
        ),
        sessionized as (
            select *,
                sum(is_session_start) over (
                    partition by brand_id, brain_anon_id
                    order by occurred_at asc
                    rows between unbounded preceding and current row
                ) as session_seq
            from flagged
        ),
        ordered as (
            select
                brand_id, brain_anon_id, event_id, event_type, occurred_at, session_id_raw, session_seq,
                sr_murmur_hash3_32(
                    concat_ws('|', brand_id, brain_anon_id, cast(session_seq as string))
                ) as session_key,
                row_number() over (
                    partition by brand_id, brain_anon_id order by occurred_at asc, event_id asc
                ) as touch_seq,
                row_number() over (
                    partition by brand_id, brain_anon_id order by occurred_at desc, event_id desc
                ) as touch_seq_desc,
                case
                    when fbclid is not null and fbclid <> '' then 'paid_meta'
                    when (gclid  is not null and gclid  <> '')
                      or (gbraid is not null and gbraid <> '')
                      or (wbraid is not null and wbraid <> '')
                      or (dclid  is not null and dclid  <> '')            then 'paid_google'
                    when ttclid is not null and ttclid <> '' then 'paid_tiktok'
                    when msclkid is not null and msclkid <> '' then 'paid_bing'
                    when lower(coalesce(utm_medium, '')) in ('cpc', 'ppc', 'paid')      then 'paid'
                    when lower(coalesce(utm_medium, '')) = 'email'                      then 'email'
                    when lower(coalesce(utm_medium, '')) in ('social', 'paid_social')   then 'organic_social'
                    when lower(coalesce(utm_medium, '')) = 'referral'                   then 'referral'
                    when referrer is not null and referrer <> ''                        then 'referral'
                    else 'direct'
                end as channel,
                utm_source, utm_medium, utm_campaign, utm_term, utm_content,
                fbclid, gclid, ttclid, msclkid, gbraid, wbraid, dclid,
                referrer, landing_path, page_type, product_handle, collection_handle,
                search_query, is_synthetic
            from sessionized
        )
        select
            brand_id, brain_anon_id, event_id, event_type, occurred_at, session_id_raw,
            session_seq, session_key, touch_seq,
            (touch_seq = 1)      as is_first_touch,
            (touch_seq_desc = 1) as is_last_touch,
            channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            fbclid, gclid, ttclid, msclkid, gbraid, wbraid, dclid, referrer,
            case
                when referrer is null or referrer = '' then null
                else regexp_replace(referrer, '^[a-zA-Z]+://([^/]+).*$', '$1')
            end as referrer_host,
            landing_path, page_type, product_handle, collection_handle, search_query, is_synthetic
        from ordered
    """
    spark.sql(sessionized_sql).createOrReplaceTempView("int_touchpoint_sessionized")

    # stitch_one is registered ONCE by build() (bucket-independent); stitch_join/stitched_* are params.
    # ── silver_touchpoint: the stitch join + the 400-day TTL/partition-window guard ──
    final_sql = f"""
        select
            t.brand_id, t.brain_anon_id, t.touch_seq, t.session_key, t.session_seq,
            t.is_first_touch, t.is_last_touch, t.occurred_at, t.event_type, t.channel,
            t.utm_source, t.utm_medium, t.utm_campaign, t.utm_term, t.utm_content,
            t.fbclid, t.gclid, t.ttclid, t.msclkid, t.gbraid, t.wbraid, t.dclid,
            t.referrer_host, t.landing_path, t.page_type, t.product_handle, t.collection_handle,
            t.search_query,
            {stitched_order} as stitched_order_id,
            {stitched_brain} as stitched_brain_id,
            t.is_synthetic, t.session_id_raw,
            current_timestamp() as updated_at
        from int_touchpoint_sessionized t
        {stitch_join}
        where t.occurred_at is not null
          and t.occurred_at >= current_timestamp() - interval 400 day
    """
    spark.sql(final_sql).createOrReplaceTempView("silver_touchpoint_new")

    # Idempotent MERGE on the (brand_id, brain_anon_id, touch_seq) PK — replay-safe upsert. touch_seq is
    # monotonic (touches are append-only), so re-folding a visitor's FULL history only updates existing
    # touch_seqs + inserts new ones — never orphans a row.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING silver_touchpoint_new s
        ON t.brand_id = s.brand_id AND t.brain_anon_id = s.brain_anon_id AND t.touch_seq = s.touch_seq
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def build(spark: SparkSession) -> str:
    """ENTITY-INCREMENTAL touchpoint sessionization. The fold is per-VISITOR (brand_id, brain_anon_id) —
    session_seq / touch_seq depend on a visitor's full ordered touchpoints — so a time slice would mis-split
    sessions. Instead: (1) find visitors with NEW touchpoint events since the watermark, (2) adaptively
    hash-bucket them (all of a visitor's events land in ONE bucket), (3) re-sessionize each bucket reading
    those visitors' FULL history. Idempotent MERGE; touch_seq only grows so no orphans. FULL_REFRESH=1 (or
    no watermark) re-folds ALL visitors, still bucketed. See docs/ops/local-memory-budget.md.

    Watermark lives in the shared silver_job_watermark side-table (this target carries no ingested_at).
    Knobs: FULL_REFRESH, SILVER_INCREMENTAL_OVERLAP_HOURS (default 2), SILVER_BATCH_TARGET_ROWS
    (visitors/bucket; default 500000), SILVER_MAX_CHUNKS (default 48)."""
    import math

    fqtn = create_iceberg_table(
        spark, SILVER_NAMESPACE, TABLE_NAME, _COLUMNS,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )
    _register_murmur_udf(spark)

    # Stitch map (bucket-independent) → register stitch_one ONCE + derive the join clause.
    stitch = _read_stitch(spark)
    if stitch is not None:
        stitch.createOrReplaceTempView("silver_journey_stitch")
        spark.sql(
            """
            with stitch as (
                select brand_id, stitched_anon_id, order_id, stitched_brain_id,
                    row_number() over (
                        partition by brand_id, stitched_anon_id order by created_at asc, order_id asc
                    ) as _stitch_rn
                from silver_journey_stitch
            )
            select brand_id, stitched_anon_id, order_id, stitched_brain_id from stitch where _stitch_rn = 1
            """
        ).createOrReplaceTempView("stitch_one")
        stitch_join = "left join stitch_one s on t.brand_id = s.brand_id and t.brain_anon_id = s.stitched_anon_id"
        stitched_order, stitched_brain = "s.order_id", "s.stitched_brain_id"
    else:
        stitch_join, stitched_order, stitched_brain = "", "cast(null as string)", "cast(null as string)"

    bronze_all = spark.read.table(BRONZE_TABLE)
    tp_evt = col("event_type").isin(*_TP_TYPES)
    anon = get_json_object(col("payload"), "$.properties.brain_anon_id")

    # ── Which visitors to re-fold? (watermark on the SOURCE ingested_at via the side-table) ───────────
    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    overlap_hours = int(os.environ.get("SILVER_INCREMENTAL_OVERLAP_HOURS", "2"))
    wm = None if full_refresh else read_job_watermark(spark, TABLE_NAME)

    src = bronze_all.where(tp_evt)
    new_wm = src.selectExpr("max(ingested_at) AS m").collect()[0]["m"]  # advance the watermark to here after success
    affected = src
    if wm is not None:
        affected = affected.where(col("ingested_at") >= lit(wm - timedelta(hours=overlap_hours)))
    affected_anons = (
        affected.select(anon.alias("anon")).where(col("anon").isNotNull() & (col("anon") != "")).distinct()
    )
    affected_anons.persist()
    n_anons = affected_anons.count()
    if n_anons == 0:
        affected_anons.unpersist()
        n = spark.table(fqtn).count()
        print(f"[silver_touchpoint] ENTITY-INCREMENTAL: no visitors with new touchpoints — 0 buckets ({n} rows)", flush=True)
        write_job_watermark(spark, TABLE_NAME, new_wm)
        return fqtn

    target_per_bucket = max(1, int(os.environ.get("SILVER_BATCH_TARGET_ROWS", "500000")))
    max_chunks = max(1, int(os.environ.get("SILVER_MAX_CHUNKS", "48")))
    n_buckets = max(1, min(max_chunks, math.ceil(n_anons / target_per_bucket)))
    print(
        f"[silver_touchpoint] ENTITY-INCREMENTAL ({'FULL' if (full_refresh or wm is None) else 'delta'}): "
        f"{n_anons} affected visitor(s) → {n_buckets} adaptive bucket(s)",
        flush=True,
    )

    bronze_anon = bronze_all.withColumn("_anon", anon)
    bronze_affected = bronze_anon.join(
        affected_anons.withColumnRenamed("anon", "_aanon"), bronze_anon["_anon"] == col("_aanon"), "left_semi",
    )
    for b in range(n_buckets):
        bucket = bronze_affected if n_buckets == 1 else bronze_affected.where(
            (abs_(hash_(col("_anon"))) % lit(n_buckets)) == lit(b)
        )
        bucket.drop("_anon").createOrReplaceTempView("bronze_events")
        _fold_and_merge(spark, fqtn, stitch_join, stitched_order, stitched_brain)

    affected_anons.unpersist()
    write_job_watermark(spark, TABLE_NAME, new_wm)  # advance ONLY after all buckets merged
    n = spark.table(fqtn).count()
    print(f"[silver_touchpoint] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("silver-touchpoint")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)


if __name__ == "__main__":
    main()
