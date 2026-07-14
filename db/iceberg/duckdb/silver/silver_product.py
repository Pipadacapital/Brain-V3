"""
silver_product.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_product.py.

ENTITY-INCREMENTAL AGGREGATE. Unlike the gated-event jobs, this reads the ICEBERG Silver mart
brain_silver.silver_order_line (built by silver_order_line.py) and rolls it up to 1 row per
(brand_id, product_key, currency_code) — reproducing db/dbt/models/marts/silver_product.sql exactly:

  product_key = coalesce(nullif(product_id,''), nullif(sku,''), 'unknown')
  filter currency_code is not null
  group by (brand_id, product_key, currency_code):
    sku = max(sku), title = max(title), order_count = count(distinct order_id),
    units_sold = sum(quantity), gross_revenue_minor = sum(line_total_minor),
    discount_minor = sum(line_discount_minor), first_sold_at = min(occurred_at),
    last_sold_at = max(occurred_at), updated_at = current_timestamp()

GRAIN: 1 row per (brand_id, product_key, currency_code). MONEY: gross_revenue_minor / discount_minor
are BIGINT minor units + currency_code (non-null, in the PK). brand_id is the tenant key, first column.
IDEMPOTENT: MERGE on the (brand_id, product_key, currency_code) PK.

STAGE-1 DQ GATE (currency only — see the Spark docstring): the amount-sign and impossible_quantity
rules are intentionally N/A at this AGGREGATE grain (sums can be net-negative post-returns / exceed the
per-record ceiling). Since amount_minor is passed as NULL, only `invalid_currency` can fire — i.e. a
rolled-up row whose currency_code is not ISO-4217 alpha-3 (^[A-Z]{3}$) is diverted. The Spark job side-
writes those to brain_silver.silver_quarantine(stage='dq'); this port SKIPS the quarantine side-write
(noted; parity is over the good rows) and simply filters them out of silver_product. sku/title are
parity-faithful max() passthroughs (clean_string NOT applied). Parity target: brain_silver.silver_product.

updated_at = current_timestamp() is non-deterministic → NOT a parity-compared column.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write to silver_product_duckdb_test. Empty in prod.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_product{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
ORDER_LINE_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line"

COLUMNS_SQL = """
  brand_id             string    NOT NULL,
  product_key          string    NOT NULL,
  currency_code        string    NOT NULL,
  sku                  string,
  title                string,
  order_count          bigint    NOT NULL,
  units_sold           bigint,
  gross_revenue_minor  bigint,
  discount_minor       bigint,
  first_sold_at        timestamptz,
  last_sold_at         timestamptz,
  updated_at           timestamptz NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "product_key", "currency_code", "sku", "title", "order_count", "units_sold",
    "gross_revenue_minor", "discount_minor", "first_sold_at", "last_sold_at", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

    # dbt silver_product.sql, verbatim: product_key coalesce, currency-not-null filter, group rollup.
    # ── Stage-1 DQ gate (currency only): non-ISO-4217 currency_code → dropped (Spark: quarantined). ──
    agg_sql = f"""
        WITH lines AS (
            SELECT *,
                   coalesce(nullif(product_id, ''), nullif(sku, ''), 'unknown') AS product_key
            FROM {ORDER_LINE_TABLE}
            WHERE currency_code IS NOT NULL
        )
        SELECT
            brand_id,
            product_key,
            currency_code,
            max(sku)                    AS sku,
            max(title)                  AS title,
            count(DISTINCT order_id)    AS order_count,
            sum(quantity)               AS units_sold,
            sum(line_total_minor)       AS gross_revenue_minor,
            sum(line_discount_minor)    AS discount_minor,
            min(occurred_at)            AS first_sold_at,
            max(occurred_at)            AS last_sold_at,
            now()                       AS updated_at
        FROM lines
        GROUP BY brand_id, product_key, currency_code
        HAVING regexp_full_match(currency_code, '^[A-Z]{{3}}$')
    """

    return merge_on_pk(con, TARGET, agg_sql, COLUMNS,
                       ["brand_id", "product_key", "currency_code"],
                       order_by_desc=["last_sold_at"])


if __name__ == "__main__":
    run_job("silver-product", build, target_table="silver_product")
