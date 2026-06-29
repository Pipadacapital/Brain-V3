"""
gold_marketing_attribution.py — Spark reimplementation of the dbt gold_marketing_attribution mart
(Brain V4 Phase 2, GROUP attribution). Reproduces db/dbt/models/marts/gold_marketing_attribution.sql
EXACTLY: that dbt model is a thin VIEW over brain_gold.gold_attribution_credit (the TS-written credit
ledger) projecting the metric-engine read shape — one row per (brand_id, credit_id) with the SAME
columns + casts (touch_seq→int, credited_revenue_minor/realized_revenue_minor→bigint, attribution_confidence
kept as the numeric string) WHERE credit_id IS NOT NULL.

Because the CURRENT side is a StarRocks VIEW (not a base table), this Spark mart MATERIALIZES the identical
projection over the Iceberg brain_gold.gold_attribution_credit this group builds (gold_attribution_credit.py),
written to Iceberg brain_gold.gold_marketing_attribution via MERGE on the PK (brand_id, credit_id). It runs
BESIDE the live dbt view (dual-run, NON-BREAKING): repoints NO reader, changes NO dbt, touches NO app code.

MONEY (I-S07): credited_revenue_minor (SIGNED: +credit / -clawback) + realized_revenue_minor are bigint
MINOR units paired with currency_code — carried VERBATIM from the credit ledger (NO re-derivation; this is a
pure projection, so the per-(brand,currency) Σ equals the credit ledger's exactly, zero drift). brand_id is
the first column / tenant key.

PARITY: current side = StarRocks VIEW brain_gold.gold_marketing_attribution (= gold_attribution_credit).
PK (brand_id, credit_id); money columns credited_revenue_minor, realized_revenue_minor. Since both the NEW
Iceberg view-mart AND the CURRENT view resolve to the same gold_attribution_credit projection, parity is
exact iff the underlying credit ledgers match (which gold_attribution_credit.py guarantees).

Run via run-gold-attribution.sh.
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG, GOLD_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # gold/ — for _gold_base
from _gold_base import gold_partition_filter  # noqa: E402

TABLE_NAME = "gold_marketing_attribution"
SRC_TABLE = "gold_attribution_credit"

# Column contract — the dbt gold_marketing_attribution VIEW select list (the metric-engine read shape).
_COLUMNS = """
          brand_id               string    NOT NULL,
          credit_id              string    NOT NULL,
          order_id               string,
          brain_anon_id          string,
          touch_seq              int,
          channel                string,
          campaign_id            string,
          model_id               string,
          row_kind               string,
          credited_revenue_minor bigint,
          currency_code          string,
          realized_revenue_minor bigint,
          reversed_of_credit_id  string,
          confidence_grade       string,
          attribution_confidence string,
          model_version          string,
          occurred_at            timestamp,
          economic_effective_at  timestamp,
          billing_posted_period  string,
          updated_at             timestamp
""".strip("\n")


def _read_credit_ledger(spark: SparkSession):
    fqtn = f"{CATALOG}.{GOLD_NAMESPACE}.{SRC_TABLE}"
    try:
        df = spark.table(fqtn)
        df.schema
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            raise SystemExit(
                f"[gold_marketing_attribution] REQUIRED Iceberg table {fqtn} is absent — build "
                f"gold_attribution_credit.py first (this mart is its projection)."
            )
        raise


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(8, brand_id)"
    )
    credit = _read_credit_ledger(spark)
    credit, _commit_wm = gold_partition_filter(
        spark, credit, table_name=TABLE_NAME, source_tables=["gold_attribution_credit"],
    )

    # The dbt VIEW projection (same columns, same casts, credit_id IS NOT NULL filter).
    result = (
        credit.where(F.col("credit_id").isNotNull())
        .select(
            F.col("brand_id"),
            F.col("credit_id"),
            F.col("order_id"),
            F.col("brain_anon_id"),
            F.col("touch_seq").cast("int").alias("touch_seq"),
            F.col("channel"),
            F.col("campaign_id"),
            F.col("model_id"),
            F.col("row_kind"),
            F.col("credited_revenue_minor").cast("bigint").alias("credited_revenue_minor"),
            F.col("currency_code"),
            F.col("realized_revenue_minor").cast("bigint").alias("realized_revenue_minor"),
            F.col("reversed_of_credit_id"),
            F.col("confidence_grade"),
            F.col("attribution_confidence"),
            F.col("model_version"),
            F.col("occurred_at"),
            F.col("economic_effective_at"),
            F.col("billing_posted_period"),
            F.current_timestamp().alias("updated_at"),
        )
    )
    n = result.count()
    result.createOrReplaceTempView("marketing_attribution_src")

    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING marketing_attribution_src s
        ON t.brand_id = s.brand_id AND t.credit_id = s.credit_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    total = spark.table(fqtn).count()
    print(f"[gold_marketing_attribution] MERGEd {n} rows → {fqtn} (table now {total} rows)", flush=True)
    _commit_wm()
    return fqtn


def main() -> None:
    spark = build_spark("gold-marketing-attribution")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[gold_marketing_attribution] DONE — Iceberg credit projection populated (dual-run) ✓", flush=True)


if __name__ == "__main__":
    main()
