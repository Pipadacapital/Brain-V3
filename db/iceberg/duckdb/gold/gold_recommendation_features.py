"""
gold_recommendation_features.py (DuckDB) — faithful port of
db/iceberg/spark/gold/gold_recommendation_features.py.

NET-NEW gap Gold `recommendation_features` mart (Brain V4, GROUP "NEW gap Gold products").

A Gold SERVING mart of recommendation INPUT features, RUNTIME-folded from the Silver spine on every
refresh and served via brain_serving.mv_gold_recommendation_features. This is a Gold product (a full
recompute MERGE'd onto the PK each run), NOT the BANNED permanent feature-precompute table — the
torn-down feature_customer_daily / brain_feature are NOT recreated here. The mart is the per-customer
RFM-plus-behaviour-plus-AFFINITY feature row a recommendation/ranking model reads as its input vector.

GRAIN / PK: 1 row per (brand_id, brain_id) — matches the Spark mart PK EXACTLY. brand_id first + tenant
  key + partition anchor.
SOURCES : silver_customer (RFM rollup of the order spine + cadence inputs) + silver_order_state (the
          order_id→brain_id bridge for order_line) + silver_order_line (purchased line economics: SKU /
          unit price / discount) + silver_touchpoint (behavioural channel / product / collection signals,
          attached via the deterministic stitched_brain_id read-back) + silver_page_view (device_class,
          attached through the touchpoint anon→brain bridge).

COLUMNS (RFM + behaviour):
  recency_days      — INT: days since the customer's last order (date_diff over silver_customer.last_seen_at).
  frequency         — BIGINT: lifetime order count (silver_customer.lifetime_orders).
  monetary_minor    — BIGINT minor units (silver_customer.lifetime_value_minor) + sibling currency_code —
                      NEVER a float, NEVER blended across currencies.
  currency_code     — the sibling currency for monetary_minor (AND for typical_price_minor below).
  top_channel       — most-frequent journey channel (silver_touchpoint.channel, tie→name asc).
  distinct_products — BIGINT: distinct product handles browsed (silver_touchpoint.product_handle).
  tenure_days       — INT: days since first seen (date_diff over silver_customer.first_seen_at).

COLUMNS (AFFINITY, all DETERMINISTIC, folded at runtime):
  favourite_brand          — STRING: most-purchased SKU (silver_order_line.sku, by line count, tie→sku asc).
  favourite_category       — STRING: most-browsed collection (silver_touchpoint.collection_handle, tie→asc).
  category_affinity_pct    — INT 0-100: concentration of category-bearing touches on favourite_category.
  typical_price_minor      — BIGINT minor units: MODAL purchased unit price (tie→lowest). Sibling currency.
  price_affinity_band      — STRING {'budget'|'mid'|'premium'|'luxury'}: typical_price_minor bucketed on
                             fixed nominal-minor thresholds (<2000 / <10000 / <50000 / ≥50000). Within the
                             customer's own currency — no cross-currency blend.
  discount_sensitivity_pct — INT 0-100: share of the customer's orders that carried any discounted line.
  device_preference        — STRING: most-frequent device_class (silver_page_view.device_class bridged via
                             the touchpoint anon→brain map, tie→class asc).
  purchase_cadence_days    — INT: avg days between orders (span / (frequency-1); NULL for <2 orders).

MONEY (I-S07): monetary_minor / typical_price_minor stay bigint MINOR + currency_code, per-currency, never
  blended with the integer counts/ratios, never a float. brand_id is the tenant key, first column.
DATE MATH (Spark → DuckDB): Spark DATEDIFF(end, start) = whole-day (end − start) → DuckDB
  date_diff('day', start, end) — the ARGUMENT ORDER flips (start first, end second). purchase_cadence_days
  uses integer floor-div (//) to match Spark's CAST(<double> AS INT) truncation of span/(orders-1).
NO PII: brain_id is the only identity key (a surrogate). HONEST-EMPTY: a customer with no purchases/touches
  gets NULL affinity columns (LEFT JOIN), never a fabricated value.
REPLAY-SAFE: full recompute from Silver each refresh, MERGE-UPDATE'd onto the PK.

SCHEMA-EVOLUTION note: the Spark job carries _add_missing_columns (an additive ALTER guard for a mart
  materialized by an EARLIER RFM-only build). The DuckDB port creates the FULL (RFM + affinity) schema up
  front via ensure_table, so there is no pre-existing narrower table to widen — the guard is unnecessary
  and intentionally omitted (parity-preserving: the end-state schema is identical).

FULL RECOMPUTE vs Spark's entity_incremental wrapper: parity-equivalent (the MERGE on the mart PK is
  idempotent and restates every (brand_id, brain_id)).

QUARANTINE: none — reads already-gated Silver. VENDORED: nothing — pure built-in SQL.

Parity target: brain_gold.gold_recommendation_features (NEW — no Spark-produced oracle).
  PK (brand_id, brain_id); money cols monetary_minor + typical_price_minor.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to
# gold_recommendation_features_duckdb_test instead of the live mart. Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_recommendation_features{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_CUSTOMER = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
SILVER_ORDER_LINE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line"
SILVER_TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
SILVER_PAGE_VIEW = f"{CATALOG}.{SILVER_NAMESPACE}.silver_page_view"

# Column contract — byte-for-byte the Spark mart's COLUMNS_SQL (RFM + affinity, full schema up front).
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

COLUMNS = [
    "brand_id", "brain_id", "recency_days", "frequency", "monetary_minor", "currency_code",
    "top_channel", "distinct_products", "tenure_days", "favourite_brand", "favourite_category",
    "category_affinity_pct", "typical_price_minor", "price_affinity_band", "discount_sensitivity_pct",
    "device_preference", "purchase_cadence_days", "updated_at",
]

PK = ["brand_id", "brain_id"]


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent optional source degrades to a typed empty inline source
        return False


def _src_or_empty(con, fq: str, empty_select: str) -> str:
    """Real FQTN if present, else a typed empty inline source (WHERE 1=0) — the DuckDB analogue of the
    Spark job's _src_or_empty honest-empty degrade (a brand with no order lines / pageviews contributes
    NULL affinity via the LEFT JOINs instead of raising on a missing table)."""
    if _table_exists(con, fq):
        return fq
    return f"(SELECT {empty_select} WHERE 1=0)"


def build(con):
    # brand-first tenant bucketing (mirrors the Spark bucket(64, brand_id) hidden partitioning).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    order_state_src = _src_or_empty(
        con, SILVER_ORDER_STATE,
        "CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS order_id, "
        "CAST(NULL AS VARCHAR) AS brain_id",
    )
    order_line_src = _src_or_empty(
        con, SILVER_ORDER_LINE,
        "CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS order_id, "
        "CAST(NULL AS VARCHAR) AS sku, CAST(NULL AS BIGINT) AS unit_price_minor, "
        "CAST(NULL AS BIGINT) AS line_discount_minor",
    )
    page_view_src = _src_or_empty(
        con, SILVER_PAGE_VIEW,
        "CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS brain_anon_id, "
        "CAST(NULL AS VARCHAR) AS device_class",
    )
    # silver_touchpoint is the behavioural spine; degrade it the same honest-empty way if absent.
    touchpoint_src = _src_or_empty(
        con, SILVER_TOUCHPOINT,
        "CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS stitched_brain_id, "
        "CAST(NULL AS VARCHAR) AS brain_anon_id, CAST(NULL AS VARCHAR) AS channel, "
        "CAST(NULL AS VARCHAR) AS product_handle, CAST(NULL AS VARCHAR) AS collection_handle",
    )

    staged = f"""
      WITH customer AS (
        -- The RFM rollup of the order spine (1 row per (brand_id, brain_id)). frequency / the
        -- first/last seen timestamps also feed purchase_cadence_days.
        SELECT
          brand_id,
          brain_id,
          CAST(COALESCE(lifetime_orders, 0)      AS BIGINT) AS frequency,
          CAST(COALESCE(lifetime_value_minor, 0) AS BIGINT) AS monetary_minor,
          currency_code,
          last_seen_at,
          first_seen_at
        FROM {SILVER_CUSTOMER}
        WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL
      ),
      -- Behavioural touchpoints attached to a known customer via the deterministic stitch read-back.
      tp AS (
        SELECT
          brand_id,
          stitched_brain_id AS brain_id,
          brain_anon_id,
          channel,
          product_handle,
          collection_handle
        FROM {touchpoint_src}
        WHERE brand_id IS NOT NULL AND stitched_brain_id IS NOT NULL
      ),
      -- Most-frequent channel per customer (tie-break: count desc, then channel name asc).
      chan_counts AS (
        SELECT
          brand_id, brain_id, channel,
          COUNT(*) AS touches,
          ROW_NUMBER() OVER (PARTITION BY brand_id, brain_id
                             ORDER BY COUNT(*) DESC, channel ASC) AS _rn
        FROM tp
        WHERE channel IS NOT NULL AND channel <> ''
        GROUP BY brand_id, brain_id, channel
      ),
      top_chan AS (
        SELECT brand_id, brain_id, channel AS top_channel FROM chan_counts WHERE _rn = 1
      ),
      prod AS (
        SELECT
          brand_id, brain_id,
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
          ROW_NUMBER() OVER (PARTITION BY brand_id, brain_id
                             ORDER BY COUNT(*) DESC, collection_handle ASC) AS _rn
        FROM cat_base
        GROUP BY brand_id, brain_id, collection_handle
      ),
      cat_totals AS (
        SELECT brand_id, brain_id, COUNT(*) AS total_touches
        FROM cat_base GROUP BY brand_id, brain_id
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
          ROW_NUMBER() OVER (PARTITION BY ab.brand_id, ab.brain_id
                             ORDER BY COUNT(*) DESC, pv.device_class ASC) AS _rn
        FROM {page_view_src} pv
        JOIN anon_brain ab
          ON ab.brand_id = pv.brand_id AND ab.brain_anon_id = pv.brain_anon_id
        WHERE pv.device_class IS NOT NULL AND pv.device_class <> ''
        GROUP BY ab.brand_id, ab.brain_id, pv.device_class
      ),
      device_pref AS (
        SELECT brand_id, brain_id, device_class AS device_preference
        FROM device_counts WHERE _rn = 1
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
          ROW_NUMBER() OVER (PARTITION BY brand_id, brain_id
                             ORDER BY COUNT(*) DESC, sku ASC) AS _rn
        FROM cust_lines
        WHERE sku IS NOT NULL AND sku <> ''
        GROUP BY brand_id, brain_id, sku
      ),
      fav_brand AS (
        SELECT brand_id, brain_id, sku AS favourite_brand FROM brand_counts WHERE _rn = 1
      ),
      -- typical_price_minor = MODAL purchased unit price (deterministic mode, tie→lowest price).
      price_counts AS (
        SELECT
          brand_id, brain_id, unit_price_minor,
          COUNT(*) AS lines,
          ROW_NUMBER() OVER (PARTITION BY brand_id, brain_id
                             ORDER BY COUNT(*) DESC, unit_price_minor ASC) AS _rn
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
        FROM price_counts WHERE _rn = 1
      ),
      -- discount_sensitivity_pct = share of the customer's orders that carried any discounted line.
      disc AS (
        SELECT
          brand_id, brain_id,
          COUNT(DISTINCT order_id) AS total_orders,
          COUNT(DISTINCT CASE WHEN line_discount_minor > 0 THEN order_id END) AS disc_orders
        FROM cust_lines GROUP BY brand_id, brain_id
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
        -- recency/tenure are integer day counts. Spark DATEDIFF(CURRENT_DATE(), <date>) →
        -- date_diff('day', <date>, current_date). NULL last/first → NULL.
        CAST(date_diff('day', CAST(c.last_seen_at  AS DATE), current_date) AS INT) AS recency_days,
        c.frequency,
        c.monetary_minor,
        c.currency_code,
        tc.top_channel,
        CAST(COALESCE(p.distinct_products, 0) AS BIGINT)                            AS distinct_products,
        CAST(date_diff('day', CAST(c.first_seen_at AS DATE), current_date) AS INT)  AS tenure_days,
        fb.favourite_brand,
        fcat.favourite_category,
        fcat.category_affinity_pct,
        pa.typical_price_minor,
        pa.price_affinity_band,
        ds.discount_sensitivity_pct,
        dp.device_preference,
        -- average days between orders: span / (orders-1). <2 orders → NULL. Integer floor-div (//)
        -- matches Spark's CAST(<double> AS INT) truncation (span non-negative).
        CASE WHEN c.frequency >= 2 AND c.first_seen_at IS NOT NULL AND c.last_seen_at IS NOT NULL
             THEN CAST(
                    date_diff('day', CAST(c.first_seen_at AS DATE), CAST(c.last_seen_at AS DATE))
                    // (c.frequency - 1) AS INT)
             ELSE NULL END                                                          AS purchase_cadence_days,
        now() AT TIME ZONE 'UTC'                                                    AS updated_at
      FROM customer c
      LEFT JOIN top_chan    tc   ON tc.brand_id   = c.brand_id AND tc.brain_id   = c.brain_id
      LEFT JOIN prod        p    ON p.brand_id    = c.brand_id AND p.brain_id    = c.brain_id
      LEFT JOIN fav_brand   fb   ON fb.brand_id   = c.brand_id AND fb.brain_id   = c.brain_id
      LEFT JOIN fav_cat     fcat ON fcat.brand_id = c.brand_id AND fcat.brain_id = c.brain_id
      LEFT JOIN price_aff   pa   ON pa.brand_id   = c.brand_id AND pa.brain_id   = c.brain_id
      LEFT JOIN disc_sens   ds   ON ds.brand_id   = c.brand_id AND ds.brain_id   = c.brain_id
      LEFT JOIN device_pref dp   ON dp.brand_id   = c.brand_id AND dp.brain_id   = c.brain_id
    """

    # Idempotent MERGE on the (brand_id, brain_id) PK — the customer CTE yields one row per PK, so the
    # in-batch dedup order_by is a stable tie-break no-op.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK,
                       order_by_desc=["updated_at", "frequency"])


if __name__ == "__main__":
    run_job("gold-recommendation-features", build, target_table="gold_recommendation_features")
