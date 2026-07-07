# SPEC: C.3
"""
gold_product_economics.py — NEW Wave-C product×day economics rollup (AMD-17 companion of
gold_order_economics).

Pushes each order's measured economics DOWN onto its product lines (apportioned by line-revenue share,
ZERO money leak — largest-remainder: floor per line + the per-order remainder to the highest-value line,
so Σ line parts == the order's component EXACTLY), then rolls up to one row per
(brand_id, product_key, econ_date, currency_code).

  product_key = coalesce(product_id, sku, '__unknown__')  — the product identity the catalog exposes.
  econ_date   = date(order_recognized_at)                 — the day the order's revenue was recognized.

CM1/CM2/CM3 are recomputed from the SUMMED apportioned parts at the rollup grain (linear, so they
reconcile to gold_order_economics exactly per (brand, day, currency)).

MONEY (§1.2): signed BIGINT minor units + sibling currency_code, per-currency, NEVER blended, NO float
(bigint div-based apportionment → exact fils in KWD/BHD/OMR). brand_id first + partition anchor.

DEGRADES: reads silver_order_line + gold_order_economics. If either is absent/empty → empty mart. When
an order has NO lines (line-less connector), its economics land under product_key='__unknown__' via the
left-join fallback so no revenue is dropped. Run via run-gold-product-economics.sh, AFTER
gold_order_economics.
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _gold_base import (  # noqa: E402
    CATALOG,
    GOLD_NAMESPACE,
    ensure_gold_table,
    merge_on_pk,
    run_job,
    silver,
    silver_exists,
)
from pyspark.sql import SparkSession  # noqa: E402

TABLE = "gold_product_economics"
JOB_VERSION = "c3.product_economics.v1"

COLUMNS_SQL = """
          brand_id                 string    NOT NULL,
          product_key              string    NOT NULL,
          econ_date                date      NOT NULL,
          currency_code            string    NOT NULL,
          order_count              bigint    NOT NULL,
          net_revenue_minor        bigint    NOT NULL,
          cogs_minor               bigint    NOT NULL,
          shipping_fwd_minor       bigint    NOT NULL,
          shipping_rev_minor       bigint    NOT NULL,
          packaging_minor          bigint    NOT NULL,
          fees_minor               bigint    NOT NULL,
          cm1_minor                bigint    NOT NULL,
          cm2_minor                bigint    NOT NULL,
          marketing_minor          bigint    NOT NULL,
          cm3_minor                bigint    NOT NULL,
          source_system            string    NOT NULL,
          job_version              string    NOT NULL,
          updated_at               timestamp NOT NULL
""".strip("\n")

# The money components apportioned from order → line (each an exact-sum split).
_COMPONENTS = [
    "net_revenue_minor", "cogs_minor", "shipping_fwd_minor", "shipping_rev_minor",
    "packaging_minor", "fees_minor", "marketing_minor",
]


def build(spark: SparkSession):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    econ_fqtn = f"{CATALOG}.{GOLD_NAMESPACE}.gold_order_economics"
    try:
        spark.table(econ_fqtn).schema
    except Exception:  # noqa: BLE001 — economics not built yet → empty mart (graceful)
        print("[gold_product_economics] gold_order_economics absent — writing empty mart", flush=True)
        return fqtn, spark.table(fqtn).count()

    has_lines = silver_exists(spark, "silver_order_line")

    # ── lines with per-order line-revenue weights + a deterministic rank (highest line first) ──
    if has_lines:
        spark.sql(
            f"""
            SELECT brand_id, order_id,
                   coalesce(nullif(product_id, ''), nullif(sku, ''), '__unknown__') AS product_key,
                   cast(coalesce(line_total_minor, 0) AS bigint) AS line_total_minor,
                   line_index
            FROM {silver('silver_order_line')}
            WHERE brand_id IS NOT NULL AND order_id IS NOT NULL
            """
        ).createOrReplaceTempView("_pe_lines")
    else:
        spark.sql(
            "SELECT '' AS brand_id, '' AS order_id, '' AS product_key, "
            "cast(0 AS bigint) AS line_total_minor, cast(0 AS bigint) AS line_index WHERE 1=0"
        ).createOrReplaceTempView("_pe_lines")

    # ── attach economics to each line; orders with NO lines → a single synthetic '__unknown__' line
    #    carrying the whole order (weight 1) so no revenue is dropped ──
    spark.sql(
        f"""
        WITH econ AS (
            SELECT brand_id, order_id, currency_code,
                   cast(order_recognized_at AS date) AS econ_date,
                   {', '.join(_COMPONENTS)}
            FROM {econ_fqtn}
        ),
        lines AS (
            SELECT e.brand_id, e.order_id, e.currency_code, e.econ_date,
                   {', '.join('e.' + c for c in _COMPONENTS)},
                   coalesce(l.product_key, '__unknown__') AS product_key,
                   coalesce(l.line_total_minor, 0)        AS line_total_minor,
                   coalesce(l.line_index, 0)              AS line_index
            FROM econ e
            LEFT JOIN _pe_lines l ON l.brand_id = e.brand_id AND l.order_id = e.order_id
        ),
        weighted AS (
            SELECT *,
                   sum(line_total_minor) OVER (PARTITION BY brand_id, order_id) AS order_line_total,
                   count(*)              OVER (PARTITION BY brand_id, order_id) AS n_lines,
                   row_number() OVER (
                     PARTITION BY brand_id, order_id
                     ORDER BY line_total_minor DESC, line_index ASC
                   ) AS _lr
            FROM lines
        ),
        floored AS (
            SELECT brand_id, order_id, currency_code, econ_date, product_key, _lr, n_lines,
                   {', '.join(
                       f'''CASE WHEN order_line_total > 0
                               THEN ({c} * line_total_minor) div order_line_total
                               ELSE {c} div n_lines END AS f_{c}'''
                       for c in _COMPONENTS
                   )},
                   {', '.join(c for c in _COMPONENTS)}
            FROM weighted
        ),
        remainder AS (
            SELECT *,
                   {', '.join(
                       f'({c} - sum(f_{c}) OVER (PARTITION BY brand_id, order_id)) AS r_{c}'
                       for c in _COMPONENTS
                   )}
            FROM floored
        ),
        apportioned AS (
            SELECT brand_id, order_id, currency_code, econ_date, product_key,
                   {', '.join(
                       f'(f_{c} + CASE WHEN _lr = 1 THEN r_{c} ELSE 0 END) AS a_{c}'
                       for c in _COMPONENTS
                   )}
            FROM remainder
        )
        SELECT
            brand_id, product_key, econ_date, currency_code,
            cast(count(DISTINCT order_id) AS bigint)                         AS order_count,
            {', '.join(f'cast(sum(a_{c}) AS bigint) AS {c}' for c in _COMPONENTS)}
        FROM apportioned
        GROUP BY brand_id, product_key, econ_date, currency_code
        """
    ).createOrReplaceTempView("_pe_rollup")

    # ── recompute CM waterfall from the summed apportioned parts (linear → reconciles exactly) ──
    staged = spark.sql(
        f"""
        SELECT
            brand_id, product_key, econ_date, currency_code, order_count,
            net_revenue_minor, cogs_minor, shipping_fwd_minor, shipping_rev_minor,
            packaging_minor, fees_minor,
            (net_revenue_minor - cogs_minor) AS cm1_minor,
            (net_revenue_minor - cogs_minor - shipping_fwd_minor - shipping_rev_minor
              - packaging_minor - fees_minor) AS cm2_minor,
            marketing_minor,
            (net_revenue_minor - cogs_minor - shipping_fwd_minor - shipping_rev_minor
              - packaging_minor - fees_minor - marketing_minor) AS cm3_minor,
            'gold_order_economics'  AS source_system,
            '{JOB_VERSION}'         AS job_version,
            current_timestamp()     AS updated_at
        FROM _pe_rollup
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "product_key", "econ_date", "currency_code"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-product-economics", build)
