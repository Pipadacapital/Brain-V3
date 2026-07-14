"""
gold_cohorts.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_cohorts.py.

Acquisition cohorts: ONE row per (brand_id, cohort_month) — the customers first seen in that calendar
month + their lifetime value/orders. Reads the sibling Silver spine {CATALOG}.brain_silver.silver_customer
DIRECTLY (NOT the gated keystone / raw Bronze), exactly like the Spark job reads it via spark.table().

THE TRANSFORM (verbatim from the Spark job, which reproduces db/dbt/models/marts/gold_cohorts.sql):
  FROM silver_customer WHERE first_seen_at IS NOT NULL, GROUP BY (brand_id, cohort_month):
      cohort_month       = date_format(first_seen_at, '%Y-%m')     -- 'YYYY-MM' calendar string
      currency_code      = max(currency_code)                       -- AGGREGATE inside the group, NOT a key
      cohort_size        = count(*)::bigint
      cohort_value_minor = sum(lifetime_value_minor)::bigint        -- MONEY: bigint MINOR units, pure Σ
      cohort_orders      = sum(lifetime_orders)::bigint
      updated_at         = current_timestamp()

GRAIN (verbatim): GROUP BY (brand_id, cohort_month) ONLY. currency_code is max() inside the group, NOT a
  grouping key (the dbt/Spark grouping the money Σ + row identity are byte-for-byte identical to). The
  'YYYY-MM' bucket is built with DuckDB strftime(first_seen_at, '%Y-%m') — the same calendar bucketing as
  Spark date_format(...,'yyyy-MM') / MySQL/StarRocks '%Y-%m'.

MONEY: cohort_value_minor is a bigint MINOR-unit additive Σ of silver_customer.lifetime_value_minor — a
  pure sum, no rounding, no float. brand_id is the first column / tenant key.

UTC: silver_customer.first_seen_at is Iceberg timestamptz (a UTC instant). `AT TIME ZONE 'UTC'` pins the
  wall-clock to UTC before bucketing regardless of session TZ, so the 'YYYY-MM' bucket + cross-engine
  checksum are TZ-artifact-free (parity with the other ported jobs; the connection is SET TimeZone='UTC').

IDEMPOTENT / REPLAY-SAFE: the Spark job full-recomputes the rollup then MERGEs on (brand_id, cohort_month)
  — UPDATE on restatement, INSERT new cohorts. An idempotent MERGE on that same PK is parity-equivalent
  to Spark's full-rebuild MERGE (the GROUP BY already yields exactly 1 row per PK). Re-run yields identical
  rows. (Spark also has a partition-incremental `gold_partition_filter` + orphan-DELETE branch; NOT ported —
  the DuckDB parallel-run is a full recompute, which is the FULL_REFRESH-equivalent of the Spark path.)

QUARANTINE: the Spark job has NO Stage-1 quarantine side-write here (silver_customer is already gated).
  This framework has no quarantine side-write either — nothing to skip.

Parity target: brain_gold.gold_cohorts.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_cohorts_duckdb_test
# instead of the live table. Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_cohorts{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"

# Mirrors the Spark _COLUMNS order/types (naive timestamp; money is bigint minor units).
COLUMNS_SQL = """
  brand_id           string    NOT NULL,
  cohort_month       string    NOT NULL,
  currency_code      string,
  cohort_size        bigint,
  cohort_value_minor bigint,
  cohort_orders      bigint,
  updated_at         timestamp
""".strip("\n")

COLUMNS = [
    "brand_id", "cohort_month", "currency_code", "cohort_size",
    "cohort_value_minor", "cohort_orders", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(4, brand_id)")

    # GROUP the silver_customer spine (first_seen_at present) up to the cohort grain (verbatim dbt/Spark
    # fold). strftime(... AT TIME ZONE 'UTC', '%Y-%m') == Spark date_format(first_seen_at,'yyyy-MM').
    # currency_code = max() inside the group (an aggregate, NOT a grouping key). Money is a pure bigint Σ.
    staged = f"""
      SELECT
        brand_id,
        strftime(first_seen_at AT TIME ZONE 'UTC', '%Y-%m')            AS cohort_month,
        max(currency_code)                                             AS currency_code,
        CAST(count(*) AS BIGINT)                                       AS cohort_size,
        CAST(sum(lifetime_value_minor) AS BIGINT)                      AS cohort_value_minor,
        CAST(sum(lifetime_orders) AS BIGINT)                           AS cohort_orders,
        now() AT TIME ZONE 'UTC'                                       AS updated_at
      FROM {SOURCE}
      WHERE first_seen_at IS NOT NULL
      GROUP BY brand_id, strftime(first_seen_at AT TIME ZONE 'UTC', '%Y-%m')
    """

    # Idempotent MERGE on the (brand_id, cohort_month) PK — parity-equivalent to Spark's full-rebuild MERGE.
    # The GROUP BY already yields one row per PK, so order_by_desc (updated_at then cohort_month) is a
    # stable no-op tie-break for the in-batch dedup.
    return merge_on_pk(con, TARGET, staged, COLUMNS,
                       ["brand_id", "cohort_month"],
                       order_by_desc=["updated_at", "cohort_month"])


if __name__ == "__main__":
    run_job("gold-cohorts", build, target_table="gold_cohorts")
