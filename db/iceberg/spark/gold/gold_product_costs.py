"""
gold_product_costs.py — SPEC:C.2.4 per-SKU COGS dimension (Brain V4 Wave C).

The brand-configured cost-of-goods catalogue: {brand_id, sku, cost_minor, currency, valid_from, valid_to}
(the `cost_input` sku-scope is its ancestor). This is the COGS source gold_measurement_costs (and, in C.3,
gold_order_economics CM1) joins order lines against. Additive Gold dimension; no reader repointed.

SOURCE: PG billing.cost_input WHERE scope='sku' AND cost_type='cogs' (the governed, RLS-isolated cost seam,
migration 0055). amount_minor is the per-unit COGS in bigint minor units + currency_code (char(3)); pct_bps
rows are NOT product costs (a percentage-of-revenue cost is a variable fee, handled elsewhere) so they are
excluded here. effective_from/effective_to become valid_from/valid_to (an open cost has valid_to = NULL →
current). A future catalog-cost mapper (Shopify variant cost) or a CSV cost-sheet ingest lands the SAME
shape under source_system — no schema change.

MONEY: cost_minor bigint minor units + currency_code, per-currency, never blended/float. brand_id first.
KEY: (brand_id, sku, valid_from) — a SKU may have a cost history (re-costing); each interval is one row.
Read over PG JDBC (superuser ETL read, same posture as gold_revenue_ledger's dimension reads).

DATA NOTE: billing.cost_input is currently EMPTY live → this writes a correct EMPTY dimension. Configuring a
per-SKU cost (POST /api/v1/costs, scope='sku') populates it on the next refresh with no code change.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _gold_base import GOLD_NAMESPACE, merge_on_pk, run_job  # noqa: E402
from iceberg_base import create_iceberg_table  # noqa: E402

TABLE = "gold_product_costs"

PG_JDBC_URL = os.environ.get("GOLD_PG_JDBC_URL", os.environ.get("SILVER_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain"))
PG_USER = os.environ.get("GOLD_PG_USER", os.environ.get("SILVER_PG_USER", "brain"))
PG_PASSWORD = os.environ.get("GOLD_PG_PASSWORD", os.environ.get("SILVER_PG_PASSWORD", "brain"))

COLUMNS_SQL = """
          brand_id         string    NOT NULL,
          sku              string    NOT NULL,
          cost_minor       bigint    NOT NULL,
          currency_code    string,
          valid_from       date      NOT NULL,
          valid_to         date,
          cost_confidence  string,
          source_system    string,
          source_event_id  string,
          updated_at       timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = create_iceberg_table(spark, GOLD_NAMESPACE, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    query = (
        "(SELECT brand_id::text AS brand_id, scope_ref AS sku, amount_minor AS cost_minor, "
        "currency_code, effective_from AS valid_from, effective_to AS valid_to, "
        "cost_confidence, cost_input_id AS source_event_id "
        "FROM billing.cost_input "
        "WHERE scope = 'sku' AND cost_type = 'cogs' AND amount_minor IS NOT NULL AND scope_ref <> '') c"
    )
    src = (
        spark.read.format("jdbc")
        .option("url", PG_JDBC_URL)
        .option("user", PG_USER)
        .option("password", PG_PASSWORD)
        .option("driver", "org.postgresql.Driver")
        .option("dbtable", query)
        .load()
    )
    src.createOrReplaceTempView("_product_costs_src")

    staged = spark.sql(
        """
        SELECT
            brand_id,
            sku,
            cast(cost_minor AS bigint)        AS cost_minor,
            currency_code,
            cast(valid_from AS date)          AS valid_from,
            cast(valid_to AS date)            AS valid_to,
            cost_confidence,
            'cost_input'                      AS source_system,
            source_event_id,
            current_timestamp()               AS updated_at
        FROM _product_costs_src
        WHERE brand_id IS NOT NULL AND sku IS NOT NULL
        """
    )
    merge_on_pk(spark, fqtn, staged, ["brand_id", "sku", "valid_from"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-product-costs", build)
