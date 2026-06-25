"""
silver_touchpoint.py — Brain V4 Phase 1 (Spark Silver, dual-run). GROUP=touchpoint+sessions.

Reimplements the dbt model db/dbt/models/marts/silver_touchpoint.sql as a Spark job that READS
Iceberg Bronze (rest.brain_bronze.collector_events) + the StarRocks brain_silver.silver_journey_stitch
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

The cart-stitch map (silver_journey_stitch) is read from the SAME StarRocks export the dbt model reads,
over the MySQL wire (cross-catalog read, the same posture dbt uses) — not a second source.

Run via run-silver-touchpoint.sh (Iceberg + MySQL JDBC packages).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession
from pyspark.sql.types import IntegerType

from iceberg_base import (  # noqa: E402 — sys.path tweak above
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.collector_events"
TABLE_NAME = "silver_touchpoint"

# CURRENT-side cart-stitch read (same JDBC posture dbt uses cross-catalog; superuser RLS-bypass ETL read).
SR_JDBC_URL = os.environ.get("SILVER_SR_JDBC_URL", "jdbc:mysql://starrocks:9030")
SR_USER = os.environ.get("SILVER_SR_USER", "root")
SR_PASSWORD = os.environ.get("SILVER_SR_PASSWORD", "")

# The exact journey/behavioral event set stg_touchpoint_events.sql admits from Bronze (verbatim).
TOUCHPOINT_EVENT_TYPES = (
    "'page.viewed', 'product.viewed', 'collection.viewed', 'cart.viewed', 'cart.item_added', "
    "'cart.item_removed', 'cart.updated', 'search.submitted', 'checkout.started', "
    "'checkout.step_viewed', 'checkout.shipping_selected', 'payment.initiated', 'payment.succeeded', "
    "'payment.failed', 'order.placed', 'purchase.completed', 'coupon.applied', 'form.submitted', "
    "'user.logged_in', 'user.signed_up', 'identify', 'scroll.depth', 'element.clicked', "
    "'rage.click', 'dead.click'"
)

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
    """Deterministic cart-stitch map from the StarRocks export (brain_silver.silver_journey_stitch).

    silver_touchpoint.sql LEFT JOINs brain_silver.silver_journey_stitch (the journey-stitch export from
    PG, read as the StarRocks projection — the lakehouse no longer reaches into PG for the journey mart).
    We read the SAME StarRocks table over the MySQL wire so the dual-run join is against the identical
    stitch SoR. Returns None when the export table is absent/empty-catalog (→ all stitch NULL, dbt parity
    when the stitch map has 0 rows, which is the current local state)."""
    query = (
        "(SELECT brand_id, stitched_anon_id, order_id, brain_id AS stitched_brain_id, created_at "
        "FROM brain_silver.silver_journey_stitch) s"
    )
    try:
        return (
            spark.read.format("jdbc")
            .option("url", SR_JDBC_URL)
            .option("user", SR_USER)
            .option("password", SR_PASSWORD)
            .option("driver", "com.mysql.cj.jdbc.Driver")
            .option("dbtable", query)
            .load()
        )
    except Exception as exc:  # noqa: BLE001 — export absent → no stitch (dbt parity when 0 stitch rows)
        print(f"[silver_touchpoint] silver_journey_stitch unavailable ({exc}); stitch → null", flush=True)
        return None


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )
    _register_murmur_udf(spark)
    spark.read.table(BRONZE_TABLE).createOrReplaceTempView("bronze_events")

    # ── stg_touchpoint_events: type payload.properties.*, drop no-anon rows, dedup (brand_id,event_id) ──
    stg_sql = f"""
        with raw as (
            select brand_id, event_id, event_type, occurred_at, payload as pj
            from bronze_events
            where event_type in ({TOUCHPOINT_EVENT_TYPES})
        ),
        source as (
            select
                brand_id, event_id, event_type, occurred_at,
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
        ),
        keyed as (
            select * from source
            where brain_anon_id is not null and brain_anon_id <> ''
        ),
        deduped as (
            select *,
                row_number() over (
                    partition by brand_id, event_id
                    order by occurred_at asc
                ) as _dedup_rn
            from keyed
        )
        select
            brand_id, event_id, event_type, occurred_at, brain_anon_id, session_id_raw,
            utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            fbclid, gclid, ttclid, msclkid, gbraid, wbraid, dclid,
            referrer, landing_path, page_type, product_handle, collection_handle,
            search_query, is_synthetic
        from deduped
        where _dedup_rn = 1
    """
    spark.sql(stg_sql).createOrReplaceTempView("stg_touchpoint_events")

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

    # ── stitch lookup (deterministic earliest per (brand_id, stitched_anon_id) — D-5 read-back) ──
    stitch = _read_stitch(spark)
    if stitch is not None:
        stitch.createOrReplaceTempView("silver_journey_stitch")
        spark.sql(
            """
            with stitch as (
                select brand_id, stitched_anon_id, order_id, stitched_brain_id,
                    row_number() over (
                        partition by brand_id, stitched_anon_id
                        order by created_at asc, order_id asc
                    ) as _stitch_rn
                from silver_journey_stitch
            )
            select brand_id, stitched_anon_id, order_id, stitched_brain_id
            from stitch where _stitch_rn = 1
            """
        ).createOrReplaceTempView("stitch_one")
        stitch_join = (
            "left join stitch_one s "
            "on t.brand_id = s.brand_id and t.brain_anon_id = s.stitched_anon_id"
        )
        stitched_order = "s.order_id"
        stitched_brain = "s.stitched_brain_id"
    else:
        stitch_join = ""
        stitched_order = "cast(null as string)"
        stitched_brain = "cast(null as string)"

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

    # Idempotent MERGE on the (brand_id, brain_anon_id, touch_seq) PK — replay-safe upsert.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING silver_touchpoint_new s
        ON t.brand_id = s.brand_id AND t.brain_anon_id = s.brain_anon_id AND t.touch_seq = s.touch_seq
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[silver_touchpoint] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("silver-touchpoint")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)


if __name__ == "__main__":
    main()
