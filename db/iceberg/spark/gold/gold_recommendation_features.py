"""
gold_recommendation_features.py — NET-NEW gap Gold `recommendation_features` mart (Brain V4,
GROUP "NEW gap Gold products").

A Gold SERVING mart of recommendation INPUT features, RUNTIME-folded from the Silver spine on every
refresh and served via brain_serving.mv_gold_recommendation_features. This is a Gold product (a full
recompute MERGE'd onto the PK each run), NOT the BANNED permanent feature-precompute table — the
torn-down feature_customer_daily / brain_feature are NOT recreated here. The mart is the per-customer
RFM-plus-behaviour-plus-AFFINITY feature row a recommendation/ranking model reads as its input vector.

GRAIN   : 1 row per (brand_id, brain_id). brand_id first + tenant key + partition anchor.
SOURCES : silver_customer (RFM rollup of the order spine + cadence inputs) + silver_order_state (the
          order grain backing frequency/recency AND the order_id→brain_id bridge for order_line) +
          silver_order_line (purchased line economics: SKU / unit price / discount, attached to a
          customer through silver_order_state) + silver_touchpoint (behavioural channel / product /
          collection signals, attached to a customer via the deterministic stitched_brain_id read-back)
          + silver_page_view (device_class, attached to a customer through the touchpoint anon→brain
          bridge — the only Silver-spine carrier of a device signal).

COLUMNS (RFM + behaviour, unchanged):
  recency_days      — INT: days since the customer's last order (datediff over silver_customer.last_seen_at).
  frequency         — BIGINT: lifetime order count (the F of RFM; silver_customer.lifetime_orders).
  monetary_minor    — BIGINT minor units (the M of RFM; silver_customer.lifetime_value_minor) paired
                      with the sibling currency_code — NEVER a float, NEVER blended across currencies.
  currency_code     — the sibling currency for monetary_minor (AND for typical_price_minor below).
  top_channel       — the customer's most-frequent journey channel (silver_touchpoint.channel, tie→name asc).
  distinct_products — BIGINT: distinct product handles the customer browsed (silver_touchpoint.product_handle).
  tenure_days       — INT: days since the customer was first seen (datediff over silver_customer.first_seen_at).

COLUMNS (AFFINITY, NET-NEW — all DETERMINISTIC, folded at runtime):
  favourite_brand          — STRING: the customer's most-purchased SKU (silver_order_line.sku, by line
                             count, tie→sku asc). Brain Silver carries no separate vendor/brand attribute,
                             so the merchandising SKU is the deterministic brand-affinity proxy.
  favourite_category       — STRING: the customer's most-browsed collection (silver_touchpoint.collection_handle,
                             by touch count, tie→handle asc).
  category_affinity_pct    — INT 0-100: concentration of the customer's category-bearing touches on
                             favourite_category (a behavioural ratio, NOT money, NOT a confidence score).
  typical_price_minor      — BIGINT minor units: the customer's MODAL purchased unit price
                             (silver_order_line.unit_price_minor — the price they buy at most often,
                             tie→lowest price). Paired with the row's currency_code sibling; per-currency,
                             NEVER a float, NEVER blended.
  price_affinity_band      — STRING enum {'budget'|'mid'|'premium'|'luxury'}: typical_price_minor bucketed
                             on fixed nominal-minor-unit thresholds (budget <2000, mid <10000, premium
                             <50000, luxury ≥50000). The band is computed within the customer's own currency
                             (one currency_code per customer) — no cross-currency blend.
  discount_sensitivity_pct — INT 0-100: share of the customer's orders that carried any discounted line
                             (distinct discounted order_ids / distinct order_ids). A behavioural ratio.
  device_preference        — STRING: the customer's most-frequent device_class (silver_page_view.device_class
                             bridged via the touchpoint anon→brain map, by view count, tie→class asc).
  purchase_cadence_days    — INT: average days between the customer's orders
                             (datediff(last_seen, first_seen) / (frequency-1); NULL for <2 orders).

NO PII: brain_id is the only identity key (a surrogate) — no email/phone/hash rides through. Confidence
is NOT a column here (these are raw model-input features); money (monetary_minor, typical_price_minor)
stays minor+currency, never blended with the integer counts/ratios. REPLAY-SAFE: full recompute from
Silver each refresh, MERGE-UPDATE'd onto the PK. HONEST-EMPTY: a customer with no purchases/touches gets
NULL affinity columns (LEFT JOIN), never a fabricated value.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver, silver_exists

TABLE = "gold_recommendation_features"

COLUMNS_SQL = """
          brand_id                 string    NOT NULL,
          brain_id                 string    NOT NULL,
          recency_days             int,
          frequency                bigint    NOT NULL,
          monetary_minor           bigint    NOT NULL,
          currency_code            string,
          top_channel              string,
          distinct_products        bigint    NOT NULL,
          tenure_days              int,
          favourite_brand          string,
          favourite_category       string,
          category_affinity_pct    int,
          typical_price_minor      bigint,
          price_affinity_band      string,
          discount_sensitivity_pct int,
          device_preference        string,
          purchase_cadence_days    int,
          updated_at               timestamp NOT NULL
""".strip("\n")

# The NET-NEW affinity columns (name, Iceberg type) — used to schema-evolve a table that was created
# by an EARLIER (RFM-only) build. ALTER TABLE ... ADD COLUMN is additive/non-breaking; existing rows
# read the new columns as NULL until the next recompute MERGE-updates them.
_NEW_COLUMNS = [
    ("favourite_brand", "string"),
    ("favourite_category", "string"),
    ("category_affinity_pct", "int"),
    ("typical_price_minor", "bigint"),
    ("price_affinity_band", "string"),
    ("discount_sensitivity_pct", "int"),
    ("device_preference", "string"),
    ("purchase_cadence_days", "int"),
]


def _add_missing_columns(spark, fqtn: str) -> None:
    """Additively ALTER in any affinity column missing from a pre-existing (RFM-only) mart.

    create_iceberg_table is CREATE TABLE IF NOT EXISTS, so a mart materialized before this extension
    keeps its old schema. This guard makes the extension replay/backfill-safe: it adds only the columns
    that are absent (never drops, never retypes), so the MERGE's `INSERT */UPDATE *` always sees a table
    whose columns match the staged rollup.
    """
    existing = {f.name.lower() for f in spark.table(fqtn).schema.fields}
    for name, ddl_type in _NEW_COLUMNS:
        if name.lower() not in existing:
            spark.sql(f"ALTER TABLE {fqtn} ADD COLUMN {name} {ddl_type}")


def _src_or_empty(spark, table: str, empty_select: str) -> str:
    """Return the real Silver FQTN if present, else a typed empty inline source (WHERE 1=0).

    Honest-empty / graceful degrade (mirrors silver_exists usage across the gap-Gold jobs): if an
    upstream Silver table is absent (e.g. a brand that has never had order lines or pageviews), the
    affinity CTE folds over an empty, correctly-typed source so the LEFT JOINs simply contribute NULLs
    instead of raising on a missing table.
    """
    if silver_exists(spark, table):
        return silver(table)
    return f"(SELECT {empty_select} WHERE 1=0)"


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")
    _add_missing_columns(spark, fqtn)

    order_state_src = _src_or_empty(
        spark,
        "silver_order_state",
        "CAST(NULL AS string) AS brand_id, CAST(NULL AS string) AS order_id, "
        "CAST(NULL AS string) AS brain_id",
    )
    order_line_src = _src_or_empty(
        spark,
        "silver_order_line",
        "CAST(NULL AS string) AS brand_id, CAST(NULL AS string) AS order_id, "
        "CAST(NULL AS string) AS sku, CAST(NULL AS bigint) AS unit_price_minor, "
        "CAST(NULL AS bigint) AS line_discount_minor",
    )
    page_view_src = _src_or_empty(
        spark,
        "silver_page_view",
        "CAST(NULL AS string) AS brand_id, CAST(NULL AS string) AS brain_anon_id, "
        "CAST(NULL AS string) AS device_class",
    )

    staged = spark.sql(
        f"""
        WITH customer AS (
            -- The RFM rollup of the order spine (1 row per (brand_id, brain_id)). brain_id NOT NULL by
            -- the silver_customer contract (unlinked orders are excluded upstream). frequency / the
            -- first/last seen timestamps also feed purchase_cadence_days.
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
        -- Carries collection_handle (favourite_category) + brain_anon_id (the device bridge key).
        tp AS (
            SELECT
                brand_id,
                stitched_brain_id AS brain_id,
                brain_anon_id,
                channel,
                product_handle,
                collection_handle
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
        ),
        -- ── favourite_category + category_affinity_pct (touchpoint collection_handle) ──
        cat_base AS (
            SELECT brand_id, brain_id, collection_handle
            FROM tp
            WHERE collection_handle IS NOT NULL AND collection_handle <> ''
        ),
        cat_counts AS (
            SELECT
                brand_id, brain_id, collection_handle,
                COUNT(*) AS touches,
                ROW_NUMBER() OVER (
                    PARTITION BY brand_id, brain_id
                    ORDER BY COUNT(*) DESC, collection_handle ASC
                ) AS _rn
            FROM cat_base
            GROUP BY brand_id, brain_id, collection_handle
        ),
        cat_totals AS (
            SELECT brand_id, brain_id, COUNT(*) AS total_touches
            FROM cat_base
            GROUP BY brand_id, brain_id
        ),
        fav_cat AS (
            SELECT
                c.brand_id, c.brain_id,
                c.collection_handle AS favourite_category,
                -- concentration ratio as an INTEGER percent (count/count, never money/confidence).
                CAST(ROUND(100.0 * c.touches / t.total_touches) AS INT) AS category_affinity_pct
            FROM cat_counts c
            JOIN cat_totals t ON t.brand_id = c.brand_id AND t.brain_id = c.brain_id
            WHERE c._rn = 1
        ),
        -- ── device_preference (page_view device_class, bridged via the touchpoint anon→brain map) ──
        anon_brain AS (
            SELECT DISTINCT brand_id, brain_anon_id, brain_id
            FROM tp
            WHERE brain_anon_id IS NOT NULL AND brain_anon_id <> ''
        ),
        device_counts AS (
            SELECT
                ab.brand_id, ab.brain_id, pv.device_class,
                COUNT(*) AS views,
                ROW_NUMBER() OVER (
                    PARTITION BY ab.brand_id, ab.brain_id
                    ORDER BY COUNT(*) DESC, pv.device_class ASC
                ) AS _rn
            FROM {page_view_src} pv
            JOIN anon_brain ab
              ON ab.brand_id = pv.brand_id AND ab.brain_anon_id = pv.brain_anon_id
            WHERE pv.device_class IS NOT NULL AND pv.device_class <> ''
            GROUP BY ab.brand_id, ab.brain_id, pv.device_class
        ),
        device_pref AS (
            SELECT brand_id, brain_id, device_class AS device_preference
            FROM device_counts
            WHERE _rn = 1
        ),
        -- ── purchased-line economics (order_line ⋈ order_state for the order_id→brain_id bridge) ──
        cust_lines AS (
            SELECT
                os.brand_id, os.brain_id, ol.order_id, ol.sku,
                ol.unit_price_minor, ol.line_discount_minor
            FROM {order_line_src} ol
            JOIN {order_state_src} os
              ON os.brand_id = ol.brand_id AND os.order_id = ol.order_id
            WHERE os.brain_id IS NOT NULL
        ),
        -- favourite_brand = the customer's most-purchased SKU (brand-affinity proxy; no vendor attr).
        brand_counts AS (
            SELECT
                brand_id, brain_id, sku,
                COUNT(*) AS lines,
                ROW_NUMBER() OVER (
                    PARTITION BY brand_id, brain_id
                    ORDER BY COUNT(*) DESC, sku ASC
                ) AS _rn
            FROM cust_lines
            WHERE sku IS NOT NULL AND sku <> ''
            GROUP BY brand_id, brain_id, sku
        ),
        fav_brand AS (
            SELECT brand_id, brain_id, sku AS favourite_brand
            FROM brand_counts
            WHERE _rn = 1
        ),
        -- typical_price_minor = MODAL purchased unit price (deterministic mode, tie→lowest price).
        price_counts AS (
            SELECT
                brand_id, brain_id, unit_price_minor,
                COUNT(*) AS lines,
                ROW_NUMBER() OVER (
                    PARTITION BY brand_id, brain_id
                    ORDER BY COUNT(*) DESC, unit_price_minor ASC
                ) AS _rn
            FROM cust_lines
            WHERE unit_price_minor IS NOT NULL AND unit_price_minor > 0
            GROUP BY brand_id, brain_id, unit_price_minor
        ),
        price_aff AS (
            SELECT
                brand_id, brain_id,
                CAST(unit_price_minor AS BIGINT) AS typical_price_minor,
                CASE
                    WHEN unit_price_minor < 2000  THEN 'budget'
                    WHEN unit_price_minor < 10000 THEN 'mid'
                    WHEN unit_price_minor < 50000 THEN 'premium'
                    ELSE 'luxury'
                END AS price_affinity_band
            FROM price_counts
            WHERE _rn = 1
        ),
        -- discount_sensitivity_pct = share of the customer's orders that carried any discounted line.
        disc AS (
            SELECT
                brand_id, brain_id,
                COUNT(DISTINCT order_id) AS total_orders,
                COUNT(DISTINCT CASE WHEN line_discount_minor > 0 THEN order_id END) AS disc_orders
            FROM cust_lines
            GROUP BY brand_id, brain_id
        ),
        disc_sens AS (
            SELECT
                brand_id, brain_id,
                CASE WHEN total_orders > 0
                     THEN CAST(ROUND(100.0 * disc_orders / total_orders) AS INT)
                     ELSE NULL END AS discount_sensitivity_pct
            FROM disc
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
            fb.favourite_brand,
            fcat.favourite_category,
            fcat.category_affinity_pct,
            pa.typical_price_minor,
            pa.price_affinity_band,
            ds.discount_sensitivity_pct,
            dp.device_preference,
            -- average days between orders: span / (orders-1). <2 orders → NULL (no cadence to measure).
            CASE WHEN c.frequency >= 2 AND c.first_seen_at IS NOT NULL AND c.last_seen_at IS NOT NULL
                 THEN CAST(
                        DATEDIFF(CAST(c.last_seen_at AS DATE), CAST(c.first_seen_at AS DATE))
                        / (c.frequency - 1) AS INT)
                 ELSE NULL END                                                   AS purchase_cadence_days,
            CURRENT_TIMESTAMP()                                                  AS updated_at
        FROM customer c
        LEFT JOIN top_chan    tc   ON tc.brand_id   = c.brand_id AND tc.brain_id   = c.brain_id
        LEFT JOIN prod        p    ON p.brand_id    = c.brand_id AND p.brain_id    = c.brain_id
        LEFT JOIN fav_brand   fb   ON fb.brand_id   = c.brand_id AND fb.brain_id   = c.brain_id
        LEFT JOIN fav_cat     fcat ON fcat.brand_id = c.brand_id AND fcat.brain_id = c.brain_id
        LEFT JOIN price_aff   pa   ON pa.brand_id   = c.brand_id AND pa.brain_id   = c.brain_id
        LEFT JOIN disc_sens   ds   ON ds.brand_id   = c.brand_id AND ds.brain_id   = c.brain_id
        LEFT JOIN device_pref dp   ON dp.brand_id   = c.brand_id AND dp.brain_id   = c.brain_id
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "brain_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-recommendation-features", build, entity_incremental={
        "table_name": "gold_recommendation_features", "source_tables": ["silver_customer", "silver_order_state", "silver_order_line", "silver_touchpoint", "silver_page_view"],
    })
