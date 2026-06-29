"""
gold_ai_features.py — NET-NEW gap Gold `ai_features` SERVING mart (Brain V4 Phase 2, GROUP "NEW gap
Gold products"). A Gold SERVING product (served via mv_gold_ai_features), NOT the BANNED feature-precompute
table — there is NO permanent feature_customer_daily / brain_feature here. This is a RUNTIME Silver fold:
a FULL recompute of a compact, deterministic ML-input feature vector from the Silver spine on every refresh,
MERGE-UPDATE'd onto the PK. Downstream models read the served vector; NO model inference happens here.

NO dbt predecessor (parity status=NEW; matrix §3/4 GAP product). Reads the canonical Iceberg Silver marts:
  - silver_customer      — the (brand_id, brain_id) customer entity universe (the mart spine).
  - silver_order_state   — the order spine; the authoritative order rollup per (brand_id, brain_id):
                           order_count, lifetime_value_minor (Σ signed recognized money), currency_code,
                           last order recency.
  - silver_touchpoint    — journey touches; distinct marketing channels reached, mapped to brain_id via the
                           deterministic cart-stitch (stitched_brain_id). Optional (absent → 0 channels).
  - silver_journey       — the journey ENTITY conversion signal, mapped to brain_id through the same stitch.
                           Optional (absent → journey_converted false).

GRAIN   : exactly 1 row per (brand_id, brain_id). brand_id first column + bucket() partition anchor.
COLUMNS :
  order_count            — bigint  : lifetime resolved order count.
  lifetime_value_minor   — bigint  : Σ recognized order value, MINOR units, paired with currency_code.
  currency_code          — string  : the sibling ISO-4217 currency for BOTH money columns (single per
                                     customer; never blended across currencies).
  avg_order_value_minor  — bigint  : lifetime_value_minor INTEGER-divided by order_count (per-currency,
                                     NEVER float; 0 when the customer has no orders). Sibling currency_code.
  recency_days           — int     : whole days since the last order/state effective date (nullable).
  distinct_channels      — bigint  : distinct deterministic channels this customer's stitched journey hit.
  converted_flag         — boolean : has the customer converted (≥1 order) OR did the stitched journey reach
                                     a conversion event — a deterministic OR fold over the order + journey
                                     signals. NEVER a model output.

PII      : aggregate mart — brain_id is the ONLY identity key; NO raw/hashed email/phone rides through.
MONEY    : bigint MINOR units + sibling currency_code (I-S07); per-currency, integer division for AOV.
REPLAY-SAFE: full recompute from Silver each run, MERGE-UPDATE'd on the (brand_id, brain_id) PK.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver, silver_exists

TABLE = "gold_ai_features"

COLUMNS_SQL = """
          brand_id              string    NOT NULL,
          brain_id              string    NOT NULL,
          order_count           bigint    NOT NULL,
          lifetime_value_minor  bigint    NOT NULL,
          currency_code         string,
          avg_order_value_minor bigint    NOT NULL,
          recency_days          int,
          distinct_channels     bigint    NOT NULL,
          converted_flag        boolean   NOT NULL,
          updated_at            timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ── order rollup from the order spine (silver_order_state), brain_id-resolved only ──
    # The authoritative per-customer order aggregate: count, Σ recognized money (per-currency), recency.
    spark.sql(
        f"""
        SELECT
            brand_id,
            brain_id,
            COUNT(order_id)                          AS order_count,
            CAST(SUM(order_value_minor) AS BIGINT)   AS lifetime_value_minor,
            MAX(currency_code)                       AS currency_code,
            MAX(state_effective_at)                  AS last_order_at
        FROM {silver('silver_order_state')}
        WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL
        GROUP BY brand_id, brain_id
        """
    ).createOrReplaceTempView("_aif_orders")

    # ── distinct channels + anon→brain stitch map from silver_touchpoint (optional source) ──
    if silver_exists(spark, "silver_touchpoint"):
        spark.sql(
            f"""
            SELECT
                brand_id,
                stitched_brain_id AS brain_id,
                COUNT(DISTINCT channel) AS distinct_channels
            FROM {silver('silver_touchpoint')}
            WHERE brand_id IS NOT NULL AND stitched_brain_id IS NOT NULL
            GROUP BY brand_id, stitched_brain_id
            """
        ).createOrReplaceTempView("_aif_channels")
        spark.sql(
            f"""
            SELECT DISTINCT brand_id, brain_anon_id, stitched_brain_id
            FROM {silver('silver_touchpoint')}
            WHERE stitched_brain_id IS NOT NULL
            """
        ).createOrReplaceTempView("_aif_anon_map")
    else:
        spark.createDataFrame(
            [], "brand_id string, brain_id string, distinct_channels bigint"
        ).createOrReplaceTempView("_aif_channels")
        spark.createDataFrame(
            [], "brand_id string, brain_anon_id string, stitched_brain_id string"
        ).createOrReplaceTempView("_aif_anon_map")

    # ── journey conversion signal, mapped to brain_id via the stitch (optional source) ──
    if silver_exists(spark, "silver_journey"):
        spark.sql(
            f"""
            SELECT
                m.brand_id,
                m.stitched_brain_id AS brain_id,
                MAX(CASE WHEN j.converted THEN true ELSE false END) AS journey_converted
            FROM _aif_anon_map m
            JOIN {silver('silver_journey')} j
              ON j.brand_id = m.brand_id AND j.brain_anon_id = m.brain_anon_id
            GROUP BY m.brand_id, m.stitched_brain_id
            """
        ).createOrReplaceTempView("_aif_converted")
    else:
        spark.createDataFrame(
            [], "brand_id string, brain_id string, journey_converted boolean"
        ).createOrReplaceTempView("_aif_converted")

    # ── the feature vector: silver_customer entity spine LEFT JOIN the order/channel/journey folds ──
    staged = spark.sql(
        f"""
        SELECT
            c.brand_id,
            c.brain_id,
            CAST(COALESCE(o.order_count, c.lifetime_orders, 0) AS BIGINT)                AS order_count,
            CAST(COALESCE(o.lifetime_value_minor, c.lifetime_value_minor, 0) AS BIGINT)  AS lifetime_value_minor,
            COALESCE(o.currency_code, c.currency_code)                                   AS currency_code,
            -- AOV = lifetime_value_minor INTEGER-divided by order_count (per-currency, NEVER float).
            -- 0 when the customer has no orders (guard the divide-by-zero with the order-count CASE).
            CAST(
              CASE WHEN COALESCE(o.order_count, c.lifetime_orders, 0) > 0
                   THEN COALESCE(o.lifetime_value_minor, c.lifetime_value_minor, 0)
                        DIV COALESCE(o.order_count, c.lifetime_orders)
                   ELSE 0 END
            AS BIGINT)                                                                   AS avg_order_value_minor,
            CAST(DATEDIFF(CURRENT_DATE(),
                          CAST(COALESCE(o.last_order_at, c.last_seen_at) AS DATE)) AS INT) AS recency_days,
            CAST(COALESCE(ch.distinct_channels, 0) AS BIGINT)                            AS distinct_channels,
            (COALESCE(o.order_count, c.lifetime_orders, 0) > 0
             OR COALESCE(cv.journey_converted, false))                                   AS converted_flag,
            current_timestamp()                                                          AS updated_at
        FROM {silver('silver_customer')} c
        LEFT JOIN _aif_orders    o  ON o.brand_id  = c.brand_id AND o.brain_id  = c.brain_id
        LEFT JOIN _aif_channels  ch ON ch.brand_id = c.brand_id AND ch.brain_id = c.brain_id
        LEFT JOIN _aif_converted cv ON cv.brand_id = c.brand_id AND cv.brain_id = c.brain_id
        WHERE c.brand_id IS NOT NULL AND c.brain_id IS NOT NULL
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "brain_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-ai-features", build, entity_incremental={
        "table_name": "gold_ai_features", "source_tables": ["silver_customer", "silver_order_state", "silver_touchpoint", "silver_journey"],
    })
