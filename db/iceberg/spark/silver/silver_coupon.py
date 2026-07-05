"""
silver_coupon.py — Brain V4 / WOO-3: the canonical COUPON mart (latest coupon state per code).

WHAT THIS IS: an ADDITIVE Spark Silver job that folds the NEW canonical `coupon.upsert.v1` events out of
the gated collector lane (brain_silver.silver_collector_event) into a per-(brand,coupon_code) latest-state
mart (brain_silver.silver_coupon), via an idempotent MERGE on the model PK (brand_id, coupon_code). It
mirrors silver_return.py (latest-state fold of a connector-derived canonical event) — for COUPONS, the
discount catalogue surface that was structurally starved end-to-end before WOO-3 (no mapper, no admit-list
entry, no mart). The WooCommerce connector now emits coupon.upsert.v1 server-trusted (see the gate sets in
silver_collector_event.SERVER_TRUSTED — the sole gate set under ADR-0010).

SOURCE  : brain_silver.silver_collector_event WHERE event_type = 'coupon.upsert.v1'
          Emitted by @brain/woocommerce-mapper resources.ts::mapWooCouponToDraft (WooCouponUpsertProperties):
            source, woocommerce_coupon_id, coupon_id, code, discount_type, amount_minor (FIXED coupons only,
            currency-aware minor units), amount_percent (PERCENT coupons only — a percentage, NOT money,
            carried verbatim and NEVER scaled), currency_code (null for percentage coupons), usage_count,
            usage_limit, expires_at.

GRAIN   : 1 row per (brand_id, coupon_code) — the latest coupon state. coupon_code is the human-facing,
          store-unique key a dashboard groups by; the stable WooCommerce id is carried alongside as
          coupon_id. Rows with no code are dropped (a coupon with no code cannot be applied — analogous to
          silver_return dropping a null order_id).

MONEY   : amount_minor is bigint MINOR units (FIXED-discount value) + the sibling currency_code — never a
          float, never blended. A PERCENT coupon carries amount_percent (string, verbatim) and a NULL
          amount_minor / currency_code: a percentage is NOT money and is NEVER scaled to minor units (the
          x100-corruption trap the mapper avoids), so the two discount kinds never blend.

PII     : none — a coupon code / id / discount config is not person-linkable. This job never sees a raw
          contact identifier.

STAGE-1 GATE (Brain V4 two-stage): the applicable Stage-1 DQ rules are the MONEY gate (amount_minor must be
  a non-negative bigint with a sibling currency_code — only exercised for FIXED coupons; PERCENT coupons
  pass NULL/NULL so they are never falsely flagged for a missing currency) and the TIMESTAMP gate over
  occurred_at. A violating event → quarantine (stage='dq'), NEVER written; Bronze keeps the original —
  replay-safe. Good rows fold to current state.

IDEMPOTENT: MERGE WHEN MATCHED UPDATE / WHEN NOT MATCHED INSERT on (brand_id, coupon_code). Re-running over
  the same gated lane yields identical rows (latest occurred_at wins the fold; the mapper's per-state
  date_modified identity means a restated coupon re-emits a new state that supersedes the prior one).

DATA AVAILABILITY (this session): coupon.upsert.v1 is a brand-new lane the WooCommerce connector only now
emits — current Bronze has ZERO coupon rows, so this writes a correct EMPTY table over current Bronze.
Schema + transform are the deliverable; a WooCommerce coupon backfill/webhook populates it with no code
change. Parity status=NEW (no dbt/StarRocks coupon baseline).

Run via spark-submit inside the Spark+Iceberg image (see run-silver-coupon.sh).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import array_join, col, lit, size  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)
from _silver_technical import dq_violations_udf, write_quarantine  # noqa: E402

# ADR-0006 P3: read the GATED collector lane (R2/R3 already applied in Silver), exactly like
# silver_return.py — coupon.upsert.v1 lands there server-trusted (WOO-3 admit-list).
COLLECTOR_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
SILVER_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_coupon"
COUPON_EVENT_TYPE = "coupon.upsert.v1"

# Canonical Silver column contract for the coupon mart. brand_id-first; money = bigint minor +
# sibling currency_code; amount_percent is a verbatim percentage STRING (never money, never scaled).
_COLUMNS = """
          brand_id        string    NOT NULL,
          coupon_code     string    NOT NULL,
          coupon_id       string,
          source          string,
          discount_type   string,
          amount_minor    bigint,
          amount_percent  string,
          currency_code   string,
          usage_count     bigint,
          usage_limit     bigint,
          expires_at      timestamp,
          first_event_at  timestamp,
          last_state_at   timestamp NOT NULL,
          updated_at      timestamp NOT NULL
""".strip("\n")


def _build_event_df(spark: SparkSession):
    """Project the canonical coupon properties out of the gated collector lane (1 row per upsert state).
    get_json_object(payload,'$.properties.X') matches the WooCouponUpsertProperties shape exactly."""
    return spark.sql(
        f"""
        WITH raw AS (
            SELECT brand_id, event_id, event_type, occurred_at, payload
            FROM {COLLECTOR_TABLE}
            WHERE event_type = '{COUPON_EVENT_TYPE}'
        ),
        src AS (
            SELECT
                brand_id,
                event_id,
                occurred_at,
                payload,
                get_json_object(payload, '$.properties.source')         AS source,
                get_json_object(payload, '$.properties.code')           AS coupon_code,
                coalesce(get_json_object(payload, '$.properties.coupon_id'),
                         get_json_object(payload, '$.properties.woocommerce_coupon_id')) AS coupon_id,
                get_json_object(payload, '$.properties.discount_type')  AS discount_type,
                -- money: BIGINT minor units (FIXED coupons); NULL for PERCENT coupons.
                cast(get_json_object(payload, '$.properties.amount_minor') AS bigint)    AS amount_minor,
                -- percentage: verbatim STRING, NEVER scaled to money (avoids the x100 corruption).
                get_json_object(payload, '$.properties.amount_percent') AS amount_percent,
                get_json_object(payload, '$.properties.currency_code')  AS currency_code,
                cast(get_json_object(payload, '$.properties.usage_count') AS bigint)     AS usage_count,
                cast(get_json_object(payload, '$.properties.usage_limit') AS bigint)     AS usage_limit,
                cast(get_json_object(payload, '$.properties.expires_at') AS timestamp)   AS expires_at
            FROM raw
        )
        SELECT * FROM src
        WHERE coupon_code IS NOT NULL AND coupon_code <> ''
        """
    )


def _fold_latest_per_code(spark: SparkSession):
    """Fold the per-upsert events to the LATEST state per (brand,coupon_code): latest occurred_at wins,
    then highest event_id — a deterministic tie-break, mirroring silver_return.py. first_event_at carries
    the earliest occurred_at (coupon first-seen) for cohorting."""
    return spark.sql(
        """
        WITH events AS (
            SELECT * FROM _silver_coupon_events
        ),
        ranked AS (
            SELECT *,
                row_number() OVER (
                    PARTITION BY brand_id, coupon_code
                    ORDER BY occurred_at DESC, event_id DESC
                ) AS _win_rn,
                min(occurred_at) OVER (PARTITION BY brand_id, coupon_code) AS first_event_at
            FROM events
        )
        SELECT
            brand_id,
            coupon_code,
            coupon_id,
            source,
            discount_type,
            amount_minor,
            amount_percent,
            currency_code,
            usage_count,
            usage_limit,
            expires_at,
            first_event_at,
            occurred_at         AS last_state_at,
            current_timestamp() AS updated_at
        FROM ranked
        WHERE _win_rn = 1
        """
    )


def run(spark: SparkSession) -> None:
    create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        "silver_coupon",
        _COLUMNS,
        partitioned_by="bucket(256, brand_id), days(first_event_at)",
    )

    df = _build_event_df(spark)

    # ── Stage-1 DQ gate: money (amount_minor + sibling currency_code — FIXED coupons only) + timestamp.
    #    A PERCENT coupon passes NULL amount_minor / NULL currency_code, so the missing_currency rule is
    #    never falsely tripped (the UDF omits NULL columns from the checked record). ────────────────────
    gated = df.withColumn(
        "_dq",
        dq_violations_udf()(
            col("amount_minor"), col("currency_code"), col("occurred_at").cast("string")
        ),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            col("source"),
            col("event_id").alias("bronze_event_id"),
            lit("silver_coupon").alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("payload"),
        ),
        stage="dq",
    )
    good = gated.where(size(col("_dq")) == 0).drop("_dq", "payload")
    good.createOrReplaceTempView("_silver_coupon_events")

    folded = _fold_latest_per_code(spark)
    folded.createOrReplaceTempView("silver_coupon_batch")

    spark.sql(
        f"""
        MERGE INTO {SILVER_TABLE} t
        USING silver_coupon_batch s
        ON t.brand_id = s.brand_id AND t.coupon_code = s.coupon_code
        WHEN MATCHED THEN UPDATE SET
            t.coupon_id = s.coupon_id,
            t.source = s.source,
            t.discount_type = s.discount_type,
            t.amount_minor = s.amount_minor,
            t.amount_percent = s.amount_percent,
            t.currency_code = s.currency_code,
            t.usage_count = s.usage_count,
            t.usage_limit = s.usage_limit,
            t.expires_at = s.expires_at,
            t.first_event_at = s.first_event_at,
            t.last_state_at = s.last_state_at,
            t.updated_at = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
            brand_id, coupon_code, coupon_id, source, discount_type, amount_minor, amount_percent,
            currency_code, usage_count, usage_limit, expires_at, first_event_at, last_state_at, updated_at
        ) VALUES (
            s.brand_id, s.coupon_code, s.coupon_id, s.source, s.discount_type, s.amount_minor, s.amount_percent,
            s.currency_code, s.usage_count, s.usage_limit, s.expires_at, s.first_event_at, s.last_state_at, s.updated_at
        )
        """
    )
    print(f"[silver_coupon] MERGE done — {SILVER_TABLE} now has {spark.table(SILVER_TABLE).count()} rows", flush=True)


def main() -> None:
    spark = build_spark("silver-coupon")
    spark.sparkContext.setLogLevel("WARN")
    run(spark)


if __name__ == "__main__":
    main()
