"""
gold_cac.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_cac.py.

GOLD mart (not a Bronze/keystone read): READS two sibling Silver Iceberg tables DIRECTLY —
{CATALOG}.brain_silver.silver_customer (newly-acquired customers, first_seen_at) and
{CATALOG}.brain_silver.silver_marketing_spend (acquisition spend, stat_date/spend_minor) — and
WRITES {CATALOG}.brain_gold.gold_cac via an idempotent MERGE on the mart PK. Reproduces the dbt
model db/dbt/models/marts/gold_cac.sql, byte/minor-unit exact.

THE TRANSFORM (verbatim from the Spark job / dbt model):
  new_customers = FROM silver_customer WHERE first_seen_at IS NOT NULL AND currency_code IS NOT NULL
                  GROUP BY brand_id, date_format(first_seen_at,'%Y-%m') AS acquisition_month, currency_code
                    → count(*) AS new_customers
  spend         = FROM silver_marketing_spend WHERE stat_date IS NOT NULL AND currency_code IS NOT NULL
                  GROUP BY brand_id, date_format(stat_date,'%Y-%m') AS acquisition_month, currency_code
                    → sum(spend_minor) AS acquisition_spend_minor
  result        = new_customers FULL OUTER JOIN spend ON (brand_id, acquisition_month, currency_code):
                  coalesce keys; coalesce(new_customers,0); coalesce(acquisition_spend_minor,0);
                  data_source='live'; updated_at=current_timestamp()

GRAIN / PK: exactly one row per (brand_id, acquisition_month, currency_code) — the mart PK. The FULL
  OUTER JOIN keeps months with ONLY spend (no new customer) and months with ONLY new customers (no
  spend); the coalesce on each side gives 0 for the missing measure, exactly as dbt/Spark does.

MONEY: acquisition_spend_minor = Σ(spend_minor) as BIGINT MINOR units, per (brand, month, currency) —
  NEVER blended across currencies (currency_code is in both GROUP BYs + the join key). Paired with
  currency_code on-row. brand_id is the tenant key, FIRST column. No float touches money — a pure
  bigint Σ. This mart has NO integer division / ratio (the CAC ratio = spend ÷ new_customers is
  NON-additive and is derived at READ by the metric-engine, NEVER precomputed here), so there is no
  Spark CAST(a/b AS bigint) truncation to reconcile.

MONTH BUCKET: strftime(first_seen_at AT TIME ZONE 'UTC', '%Y-%m') == Spark date_format(...,'yyyy-MM')
  == dbt '%Y-%m' — the same zero-padded 'YYYY-MM' calendar string. AT TIME ZONE 'UTC' pins the
  wall-clock to UTC before bucketing (the Iceberg cols are timestamptz UTC instants; the connection is
  SET TimeZone='UTC') so the bucket + cross-engine checksum are TZ-artifact-free.

IDEMPOTENT / REPLAY-SAFE: the Spark job full-recomputes then MERGEs on
  (brand_id, acquisition_month, currency_code) — UPDATE on restatement, INSERT new cells. An idempotent
  MERGE on that same PK is parity-equivalent to Spark's full-overwrite MERGE (the join yields exactly 1
  row per PK). Re-run yields identical rows.

QUARANTINE: the Spark job has NO Stage-1/quarantine side-write here (both Silver sources are already
  gated). This framework has no quarantine side-write either — nothing to skip.

Parity target: brain_gold.gold_cac (41 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_cac_duckdb_test instead of
# the live mart (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_cac{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SILVER_CUSTOMER = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"
SILVER_MARKETING_SPEND = f"{CATALOG}.{SILVER_NAMESPACE}.silver_marketing_spend"

# Column contract — byte-for-byte the Spark mart's _COLUMNS (dbt output projection). brand_id tenant
# key first; money = bigint minor + currency.
COLUMNS_SQL = """
  brand_id                string    NOT NULL,
  acquisition_month       string    NOT NULL,
  currency_code           string    NOT NULL,
  new_customers           bigint,
  acquisition_spend_minor bigint,
  data_source             string    NOT NULL,
  updated_at              timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "acquisition_month", "currency_code", "new_customers",
    "acquisition_spend_minor", "data_source", "updated_at",
]


def build(con):
    # brand-first tenant partitioning (mirrors Spark bucket(8, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(8, brand_id)")

    # ── new_customers: newly-acquired customers per brand × acquisition_month × currency ──
    new_customers = f"""
      SELECT
        brand_id,
        strftime(first_seen_at AT TIME ZONE 'UTC', '%Y-%m')   AS acquisition_month,
        currency_code,
        CAST(count(*) AS BIGINT)                              AS new_customers
      FROM {SILVER_CUSTOMER}
      WHERE first_seen_at IS NOT NULL
        AND currency_code IS NOT NULL
      GROUP BY brand_id, strftime(first_seen_at AT TIME ZONE 'UTC', '%Y-%m'), currency_code
    """

    # ── spend: acquisition spend per brand × acquisition_month × currency (money = Σ minor units) ──
    spend = f"""
      SELECT
        brand_id,
        strftime(stat_date AT TIME ZONE 'UTC', '%Y-%m')       AS acquisition_month,
        currency_code,
        CAST(sum(spend_minor) AS BIGINT)                      AS acquisition_spend_minor
      FROM {SILVER_MARKETING_SPEND}
      WHERE stat_date IS NOT NULL
        AND currency_code IS NOT NULL
        -- GAP-C: silver_marketing_spend carries the SAME money at both 'campaign' and 'adset' levels
        -- (adsets roll up to their campaign). Summing both double-counts spend (~2×) and inflates CAC.
        -- Pin to the canonical top-of-hierarchy 'campaign' level for the true account spend total.
        AND level = 'campaign'
      GROUP BY brand_id, strftime(stat_date AT TIME ZONE 'UTC', '%Y-%m'), currency_code
    """

    # ── full outer join + coalesce (mirrors the dbt/Spark final select EXACTLY) ──
    staged = f"""
      SELECT
        coalesce(n.brand_id, s.brand_id)                     AS brand_id,
        coalesce(n.acquisition_month, s.acquisition_month)   AS acquisition_month,
        coalesce(n.currency_code, s.currency_code)           AS currency_code,
        coalesce(n.new_customers, 0)                         AS new_customers,
        coalesce(s.acquisition_spend_minor, 0)               AS acquisition_spend_minor,
        CAST('live' AS VARCHAR)                              AS data_source,
        now() AT TIME ZONE 'UTC'                             AS updated_at
      FROM ({new_customers}) n
      FULL OUTER JOIN ({spend}) s
        ON  n.brand_id          = s.brand_id
        AND n.acquisition_month = s.acquisition_month
        AND n.currency_code     = s.currency_code
    """

    # Idempotent MERGE on the (brand_id, acquisition_month, currency_code) PK — replay-safe restatement.
    # The FULL OUTER JOIN already yields one row per PK, so order_by_desc is a stable no-op tie-break.
    # delete_orphans=True (2026-07-17): this job is ALWAYS a full recompute of both Silver sources, so a
    # cell whose sources vanished (removed seed/test spend — live orphan: d1517a01 INR spend=20,000 with 0
    # silver_marketing_spend rows) must be shed after the MERGE; an empty recompute never sheds (guard).
    return merge_on_pk(con, TARGET, staged, COLUMNS,
                       ["brand_id", "acquisition_month", "currency_code"],
                       order_by_desc=["updated_at", "new_customers"],
                       delete_orphans=True)


if __name__ == "__main__":
    run_job("gold-cac", build, target_table="gold_cac")
