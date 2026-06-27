"""
gold_recommendation_features.py — NET-NEW gap Gold `recommendation_features` mart (Brain V4,
GROUP "NEW gap Gold products").

A Gold SERVING mart of recommendation INPUT features, RUNTIME-folded from the Silver spine on every
refresh and served via brain_serving.mv_gold_recommendation_features. This is a Gold product (a full
recompute MERGE'd onto the PK each run), NOT the BANNED permanent feature-precompute table — the
torn-down feature_customer_daily / brain_feature are NOT recreated here. The mart is the per-customer
RFM-plus-behaviour feature row a recommendation/ranking model reads as its input vector.

GRAIN   : 1 row per (brand_id, brain_id). brand_id first + tenant key + partition anchor.
SOURCES : silver_customer (RFM rollup of the order spine) + silver_order_state (the order grain
          backing frequency/recency) + silver_touchpoint (behavioural channel / product signals,
          attached to a customer via the deterministic stitched_brain_id read-back).
COLUMNS :
  recency_days      — INT: days since the customer's last order (datediff over silver_customer.last_seen_at).
  frequency         — BIGINT: lifetime order count (the F of RFM; silver_customer.lifetime_orders).
  monetary_minor    — BIGINT minor units (the M of RFM; silver_customer.lifetime_value_minor) paired
                      with the sibling currency_code — NEVER a float, NEVER blended across currencies.
  currency_code     — the sibling currency for monetary_minor.
  top_channel       — the customer's most-frequent journey channel (silver_touchpoint.channel, tie→name asc).
  distinct_products — BIGINT: distinct product handles the customer browsed (silver_touchpoint.product_handle).
  tenure_days       — INT: days since the customer was first seen (datediff over silver_customer.first_seen_at).

NO PII: brain_id is the only identity key (a surrogate) — no email/phone/hash rides through. Confidence
is NOT a column here (these are raw model-input features); money stays minor+currency, never blended with
counts. REPLAY-SAFE: full recompute from Silver each refresh, MERGE-UPDATE'd onto the PK.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_recommendation_features"

COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          brain_id          string    NOT NULL,
          recency_days      int,
          frequency         bigint    NOT NULL,
          monetary_minor    bigint    NOT NULL,
          currency_code     string,
          top_channel       string,
          distinct_products bigint    NOT NULL,
          tenure_days       int,
          updated_at        timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    staged = spark.sql(
        f"""
        WITH customer AS (
            -- The RFM rollup of the order spine (1 row per (brand_id, brain_id)). brain_id NOT NULL by
            -- the silver_customer contract (unlinked orders are excluded upstream).
            SELECT
                brand_id,
                brain_id,
                CAST(COALESCE(lifetime_orders, 0)      AS BIGINT) AS frequency,
                CAST(COALESCE(lifetime_value_minor, 0) AS BIGINT) AS monetary_minor,
                currency_code,
                last_seen_at,
                first_seen_at
            FROM {silver('silver_customer')}
            WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL
        ),
        -- Behavioural touchpoints attached to a known customer via the deterministic stitch read-back
        -- (silver_touchpoint.stitched_brain_id). Anon-only journeys (no stitch) contribute no features.
        tp AS (
            SELECT
                brand_id,
                stitched_brain_id AS brain_id,
                channel,
                product_handle
            FROM {silver('silver_touchpoint')}
            WHERE brand_id IS NOT NULL AND stitched_brain_id IS NOT NULL
        ),
        -- Most-frequent channel per customer (deterministic tie-break: count desc, then channel name asc).
        chan_counts AS (
            SELECT
                brand_id,
                brain_id,
                channel,
                COUNT(*) AS touches,
                ROW_NUMBER() OVER (
                    PARTITION BY brand_id, brain_id
                    ORDER BY COUNT(*) DESC, channel ASC
                ) AS _rn
            FROM tp
            WHERE channel IS NOT NULL AND channel <> ''
            GROUP BY brand_id, brain_id, channel
        ),
        top_chan AS (
            SELECT brand_id, brain_id, channel AS top_channel
            FROM chan_counts
            WHERE _rn = 1
        ),
        prod AS (
            SELECT
                brand_id,
                brain_id,
                CAST(COUNT(DISTINCT product_handle) AS BIGINT) AS distinct_products
            FROM tp
            WHERE product_handle IS NOT NULL AND product_handle <> ''
            GROUP BY brand_id, brain_id
        )
        SELECT
            c.brand_id,
            c.brain_id,
            -- recency/tenure are integer day counts (never money, never blended). NULL last/first → NULL.
            CAST(DATEDIFF(CURRENT_DATE(), CAST(c.last_seen_at  AS DATE)) AS INT) AS recency_days,
            c.frequency,
            c.monetary_minor,
            c.currency_code,
            tc.top_channel,
            CAST(COALESCE(p.distinct_products, 0) AS BIGINT)                     AS distinct_products,
            CAST(DATEDIFF(CURRENT_DATE(), CAST(c.first_seen_at AS DATE)) AS INT) AS tenure_days,
            CURRENT_TIMESTAMP()                                                  AS updated_at
        FROM customer c
        LEFT JOIN top_chan tc ON tc.brand_id = c.brand_id AND tc.brain_id = c.brain_id
        LEFT JOIN prod     p  ON p.brand_id  = c.brand_id AND p.brain_id  = c.brain_id
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "brain_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-recommendation-features", build)
