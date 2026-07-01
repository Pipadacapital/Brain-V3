"""
silver_ga4_normalize.py — ADR-0006 P4: normalize RAW GA4 runReport rows in Spark Silver.

Reads the RAW GA4 Bronze (brain_bronze.ga4_rows_raw, written by the connector record / Kafka Connect
Iceberg sink from {env}.ga4.rows.raw.v1) and produces the canonical ga4.session.v1 rows the traffic /
spend marts consume — replacing the TS @brain/ga4-mapper::mapGa4RowToEvent normalization (which the
connector used to do before emitting a canonical event). The connector now archives the verbatim GA4
runReport row; ALL normalization happens HERE (ADR-0006 D3), modelled EXACTLY on the proven Shopify
exemplar (silver_shopify_order_normalize.py).

Output: the SAME column contract as silver_collector_event (the gated collector lane), so the GA4 traffic
marts read it with ZERO change — `payload` is the reconstructed canonical ga4.session.v1 envelope
(event_name + properties.*), event_type='ga4.session.v1', brand_id server-trusted from the envelope.

GRAIN: flat session/traffic grain — one row per (date × source × medium × campaign × channel × device ×
country) dimension tuple. NO PII (GA4 runReport rows carry no contact identifiers; I-S02 / D-10) — so,
unlike the Shopify exemplar, there is NO per-brand salt join and NO hashed identifier columns.

CORRECTNESS: most fields go through the SHARED, GOLDEN-VECTOR-VERIFIED ports in _raw_normalize.py
(udf-wrapped → Spark output == the verified Python == the TS). GA4 has four connector-LOCAL ports that
are NOT in the shared framework and are byte-verified in _p4_golden/test_ga4-golden.py instead:
  - major_decimal_to_minor_string  ← @brain/ga4-mapper majorDecimalToMinorString  (TRUNCATES >2 frac
    digits, '0' for null/empty/'0', malformed→quarantine. DIFFERENT from the shared
    decimal_to_minor_strict, which REJECTS >2 frac digits — they must never be confused.)
  - to_count_string                ← @brain/ga4-mapper toCountString  (integer-part-only count → str|None)
  - resolve_bounces                ← @brain/ga4-mapper resolveBounces (bounces || round(bounceRate*sessions))
  - event_id_ga4_session           ← @brain/ga4-mapper uuidV5FromGa4Row (uuid_shaped over the ga4 dim seed)
These are listed in new_framework_primitives_needed for later consolidation into _raw_normalize.py.

MONEY: revenue_minor is bigint MINOR units, never float, emitted with a sibling currency_code; never
blended across currencies. PII: none. brand_id is server-trusted (MT-1) from the envelope ONLY — never
the GA4 row body; property_id + currency_code come from the connector record (MT-1), never the row.

DUAL-RUN (P4): writes to a SHADOW table by default (TARGET_TABLE override) so parity can be checked
against the live canonical silver_collector_event ga4 rows before the connector cutover.

STAGE-1 GATE (Brain V4 two-stage): GA4's normalizers RETURN None for a malformed revenue decimal or an
empty report date (the TS THROWS), which the inline `.where(event_id & revenue_minor & occurred_at_iso
isNotNull)` gate then SILENTLY DROPPED. Those drops are now ROUTED through
_silver_technical.write_quarantine (stage='dq') to brain_silver.silver_quarantine: malformed revenue →
non_integer_amount, empty/absent date → unparseable_timestamp, un-seedable event_id →
empty_identifier:event_id. The admitted set is IDENTICAL (good rows byte-identical / parity-faithful).
GA4 runReport rows carry NO PII, so the diagnostic payload is the verbatim dimension/metric tuple; Bronze
keeps the untouched original (replay-safe).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import col, concat_ws, lit, to_json, struct, udf, upper, trim, when  # noqa: E402
from pyspark.sql.types import LongType, StringType, BooleanType  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
from _silver_technical import write_quarantine  # noqa: E402
import _raw_normalize as rn  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.ga4_rows_raw"
# Shadow by default (dual-run parity). Set TARGET_TABLE=silver_collector_event at the ga4-lane cutover.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get("TARGET_TABLE", "silver_collector_event_ga4_shadow")

COLUMNS_SQL = """
  event_id          string  NOT NULL,
  brand_id          string  NOT NULL,
  occurred_at       timestamp NOT NULL,
  ingested_at       timestamp NOT NULL,
  schema_name       string  NOT NULL,
  schema_version    int     NOT NULL,
  event_type        string  NOT NULL,
  correlation_id    string,
  partition_key     string  NOT NULL,
  payload           string  NOT NULL
"""


# ── Connector-LOCAL ports (NOT in _raw_normalize.py — byte-verified in test_ga4-golden.py) ────────────
# These mirror @brain/ga4-mapper exactly. They are LOCAL (not shared) because the agent that owns
# _raw_normalize.py is being edited concurrently; they are flagged for later consolidation.

_GA4_DECIMAL_RE = rn.re.compile(r"^(\d+)(?:\.(\d+))?$")
_GA4_COUNT_RE = rn.re.compile(r"^(\d+)(?:\.\d+)?$")


def major_decimal_to_minor_string(value):
    """@brain/ga4-mapper majorDecimalToMinorString — GA4 major-unit decimal revenue → int minor units.
    null/undefined/''/'0' → 0. Valid decimal: whole*100 + frac.padEnd(2)[:2] (TRUNCATE >2, no rounding,
    no float — BigInt arithmetic ported to int). Malformed → None (the TS THROWS; Silver quarantines).
    NOTE: distinct from the shared decimal_to_minor_strict, which REJECTS >2 fractional digits."""
    if value is None:
        return 0
    s = str(value).strip()
    if s == "" or s == "0":
        return 0
    m = _GA4_DECIMAL_RE.match(s)
    if not m:
        return None  # quarantine (TS throws I-S07)
    whole = m.group(1)
    frac = (m.group(2) or "")
    frac = (frac + "00")[:2]  # padEnd(2,'0').slice(0,2) — truncate beyond 2, no rounding
    return int(whole) * 100 + int(frac)


def to_count_string(value):
    """@brain/ga4-mapper toCountString — integer-part-only count → str, or None if absent/invalid."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    m = _GA4_COUNT_RE.match(s)
    if not m:
        return None
    return m.group(1)


def resolve_bounces(bounces, bounce_rate, sessions):
    """@brain/ga4-mapper resolveBounces — prefer `bounces` directly; else round(bounceRate*sessions).
    bounceRate*sessions mirrors the TS float math (a COUNT, not money — float is acceptable here)."""
    if bounces is not None and str(bounces).strip() != "":
        return to_count_string(bounces)
    if bounce_rate is not None and sessions is not None:
        try:
            rate = float(str(bounce_rate))
            sess = int(str(sessions))
        except (ValueError, TypeError):
            return None
        # JS Math.round: round half up (toward +inf). int(x + 0.5) matches for non-negative values.
        return str(int(rate * sess + 0.5))
    return None


def ga4_occurred_at(date):
    """@brain/ga4-mapper occurred_at — UTC midnight of the report date: `${date}T00:00:00.000Z`.
    (new Date(`${date}T00:00:00.000Z`).toISOString() is byte-identical to the seed for a valid date.)
    Empty/absent date → None: the TS would stamp Date.now() (non-deterministic) → we quarantine instead."""
    if date is None:
        return None
    d = str(date).strip()
    if d == "":
        return None
    return f"{d}T00:00:00.000Z"


def event_id_ga4_session(brand_id, property_id, date, source, medium, campaign, channel, device, country):
    """@brain/ga4-mapper uuidV5FromGa4Row — uuid_shaped over the ga4 dimension seed (absent dim → '').
    Reuses the SHARED rn.uuid_shaped (hashToUuidShaped) so the crypto is the verified shared port."""
    def _s(x):
        return "" if x is None else str(x)
    seed = (
        f"{brand_id}:ga4:{property_id}:{_s(date)}:{_s(source)}:{_s(medium)}:"
        f"{_s(campaign)}:{_s(channel)}:{_s(device)}:{_s(country)}:ga4.session.v1"
    )
    return rn.uuid_shaped(seed)


# ── UDFs over the verified ports (Spark output == verified python == TS) ───────────────────────────────
u_minor = udf(lambda s: major_decimal_to_minor_string(s), LongType())
u_count = udf(lambda s: to_count_string(s), StringType())
u_bounces = udf(lambda b, r, s: resolve_bounces(b, r, s), StringType())
u_occurred = udf(lambda d: ga4_occurred_at(d), StringType())
u_eid = udf(
    lambda brand, prop, d, src, med, camp, chan, dev, cty:
        event_id_ga4_session(brand, prop, d, src, med, camp, chan, dev, cty)
        if (brand and d) else None,
    StringType(),
)
u_sampled = udf(lambda src_cnt, space: (src_cnt is not None) or (space is not None), BooleanType())


def build(spark: SparkSession):
    create_iceberg_table(spark, SILVER_NAMESPACE, TARGET.rsplit(".", 1)[1], COLUMNS_SQL,
                         partitioned_by="bucket(256, brand_id), days(occurred_at)")

    raw = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, "ga4_rows_raw", "ga4")
    # Skip-guard: connector raw lanes are EMPTY until a connector syncs + the V4 raw-lane producer (G1)
    # lands payload-schema records. No source rows → nothing to normalize; return cleanly instead of
    # failing on the legacy struct columns this job still reads. Full payload-JSON normalize is G1.
    if raw.limit(1).count() == 0:
        print(f"[silver-ga4-normalize] {RAW_TABLE} has 0 rows — skipping (awaiting connector data / G1)", flush=True)
        return TARGET, 0
    r = "row"  # the verbatim GA4 runReport row is nested under `row` (the connector wraps it)

    # Envelope columns (server-trusted / connector record) + the verbatim GA4 dimension/metric fields.
    df = raw.select(
        col("brand_id").cast("string").alias("brand_id"),                 # MT-1: server-trusted envelope ONLY
        col("fetched_at").cast("string").alias("fetched_at"),
        col("property_id").cast("string").alias("property_id"),           # connector record, NEVER the row
        col("currency_code").cast("string").alias("currency_code_raw"),   # connector record, NEVER the row
        col("samples_read_count").cast("string").alias("samples_read_count"),    # runReport-level sampling
        col("sampling_space_size").cast("string").alias("sampling_space_size"),
        col(f"{r}.date").cast("string").alias("date"),
        col(f"{r}.sessionSource").cast("string").alias("session_source"),
        col(f"{r}.sessionMedium").cast("string").alias("session_medium"),
        col(f"{r}.sessionCampaignName").cast("string").alias("session_campaign_name"),
        col(f"{r}.sessionDefaultChannelGroup").cast("string").alias("session_default_channel_group"),
        col(f"{r}.deviceCategory").cast("string").alias("device_category"),
        col(f"{r}.country").cast("string").alias("country"),
        col(f"{r}.sessions").cast("string").alias("sessions"),
        col(f"{r}.engagedSessions").cast("string").alias("engaged_sessions"),
        col(f"{r}.bounces").cast("string").alias("bounces_raw"),
        col(f"{r}.bounceRate").cast("string").alias("bounce_rate"),
        col(f"{r}.totalUsers").cast("string").alias("total_users"),
        col(f"{r}.newUsers").cast("string").alias("new_users"),
        col(f"{r}.screenPageViews").cast("string").alias("screen_page_views"),
        col(f"{r}.eventCount").cast("string").alias("event_count"),
        col(f"{r}.conversions").cast("string").alias("conversions"),
        col(f"{r}.totalRevenue").cast("string").alias("total_revenue"),
    )

    canon = (
        df.withColumn("occurred_at_iso", u_occurred(col("date")))
        .withColumn("revenue_minor", u_minor(col("total_revenue")))
        .withColumn("currency_code", upper(trim(col("currency_code_raw"))))
        .withColumn("c_sessions", u_count(col("sessions")))
        .withColumn("c_engaged", u_count(col("engaged_sessions")))
        .withColumn("c_bounces", u_bounces(col("bounces_raw"), col("bounce_rate"), col("sessions")))
        .withColumn("c_total_users", u_count(col("total_users")))
        .withColumn("c_new_users", u_count(col("new_users")))
        .withColumn("c_page_views", u_count(col("screen_page_views")))
        .withColumn("c_event_count", u_count(col("event_count")))
        .withColumn("c_conversions", u_count(col("conversions")))
        .withColumn("is_sampled", u_sampled(col("samples_read_count"), col("sampling_space_size")))
        .withColumn("property_id_t", trim(col("property_id")))
        .withColumn("date_t", trim(col("date")))
        .withColumn("event_id", u_eid(
            col("brand_id"), col("property_id"), col("date_t"),
            col("session_source"), col("session_medium"), col("session_campaign_name"),
            col("session_default_channel_group"), col("device_category"), col("country")))
    )

    # ── Stage-1 DQ gate: route the inline drops to brain_silver.silver_quarantine (stage='dq') instead of
    #    silently dropping. Same admission set; good rows byte-identical; GA4 is PII-free → verbatim payload.
    _ok = col("event_id").isNotNull() & col("revenue_minor").isNotNull() & col("occurred_at_iso").isNotNull()
    _reason = concat_ws(
        ",",
        when(col("event_id").isNull(), lit("empty_identifier:event_id")),
        when(col("revenue_minor").isNull(), lit("non_integer_amount")),
        when(col("occurred_at_iso").isNull(), lit("unparseable_timestamp")),
    )
    write_quarantine(
        spark,
        canon.where(~_ok).select(
            col("brand_id"),
            lit("ga4").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TARGET.rsplit(".", 1)[1]).alias("canonical_target"),
            _reason.alias("reason"),
            to_json(struct(
                col("property_id"), col("date"), col("session_source"), col("session_medium"),
                col("session_campaign_name"), col("session_default_channel_group"),
                col("device_category"), col("country"), col("sessions"), col("total_revenue"),
                col("currency_code_raw"),
            )).alias("payload"),
        ),
        stage="dq",
    )
    canon = canon.where(_ok)

    # Reconstruct the canonical ga4.session.v1 envelope as the `payload` JSON the traffic marts read.
    props = struct(
        lit("ga4").alias("source"),
        col("property_id_t").alias("property_id"),
        col("date_t").alias("date"),
        col("session_source").alias("session_source"),
        col("session_medium").alias("session_medium"),
        col("session_campaign_name").alias("session_campaign_name"),
        col("session_default_channel_group").alias("session_default_channel_group"),
        col("device_category").alias("device_category"),
        col("country").alias("country"),
        col("c_sessions").alias("sessions"),
        col("c_engaged").alias("engaged_sessions"),
        col("c_bounces").alias("bounces"),
        col("c_total_users").alias("total_users"),
        col("c_new_users").alias("new_users"),
        col("c_page_views").alias("screen_page_views"),
        col("c_event_count").alias("event_count"),
        col("c_conversions").alias("conversions"),
        col("revenue_minor").cast("string").alias("revenue_minor"),
        col("currency_code").alias("currency_code"),
        col("is_sampled").alias("is_sampled"),
        col("samples_read_count").alias("samples_read_count"),
        col("sampling_space_size").alias("sampling_space_size"),
        col("occurred_at_iso").alias("occurred_at"),
    )
    envelope = to_json(struct(
        lit("ga4.session.v1").alias("event_name"),
        col("occurred_at_iso").alias("occurred_at"),
        props.alias("properties"),
    ))

    out = canon.select(
        col("event_id"),
        col("brand_id"),
        col("occurred_at_iso").cast("timestamp").alias("occurred_at"),
        col("fetched_at").cast("timestamp").alias("ingested_at"),
        lit("brain.collector.event.v1").alias("schema_name"),
        lit(1).alias("schema_version"),
        lit("ga4.session.v1").alias("event_type"),
        lit(None).cast("string").alias("correlation_id"),
        col("brand_id").alias("_b"),  # placeholder for partition_key build below
        envelope.alias("payload"),
    ).withColumn("partition_key", col("brand_id")).drop("_b")

    out.createOrReplaceTempView("_ga4_canon")
    spark.sql(
        f"""
        MERGE INTO {TARGET} t USING _ga4_canon s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.sql(f"SELECT COUNT(*) AS n FROM {TARGET}").collect()[0]["n"]
    return TARGET, n


def main() -> None:
    import time

    spark = build_spark("silver-ga4-normalize")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("silver-ga4-normalize", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
        print(f"[silver-ga4-normalize] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-ga4-normalize", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
