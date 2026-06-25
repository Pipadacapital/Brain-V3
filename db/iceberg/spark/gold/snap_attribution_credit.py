"""
snap_attribution_credit.py — Spark reimplementation of the dbt snap_attribution_credit mart (Brain V4
Phase 2, GROUP attribution). Reproduces db/dbt/models/marts/snap_attribution_credit.sql EXACTLY: the
daily attribution-result history SNAPSHOT — one row per (brand_id, credit_id, snapshot_date) capturing
the credit-as-of each date, so attribution can be reproduced as-of a report date and compared across
model versions over time.

NOTE: snap_attribution_credit is a brain_SILVER mart (config schema='brain_silver'), even though it lives
in the attribution group and reads the gold credit ledger — so this Spark job WRITES Iceberg
brain_silver.snap_attribution_credit (NOT brain_gold). It reads the dbt ref() source
gold_marketing_attribution (the Iceberg projection this group builds in gold_marketing_attribution.py),
adds snapshot_date = current_date() + computed_at = current_timestamp(), and MERGEs on the PK.

This runs BESIDE the live dbt→StarRocks brain_silver.snap_attribution_credit (dual-run, NON-BREAKING):
repoints NO reader, changes NO dbt, touches NO app code. The dbt model is INCREMENTAL (append-per-day,
prior days preserved, same-day re-run idempotent on the PK) — the Spark MERGE on (brand_id, credit_id,
snapshot_date) reproduces that exact idempotent same-day upsert.

THE TRANSFORM (folded from the dbt model — the exact select list):
  from gold_marketing_attribution:
    brand_id, credit_id, current_date() as snapshot_date, order_id, channel, campaign_id, model_id,
    model_version, row_kind, credited_revenue_minor, currency_code, confidence_grade, occurred_at,
    current_timestamp() as computed_at

MONEY (I-S07): credited_revenue_minor is SIGNED bigint MINOR units paired with currency_code — carried
VERBATIM from the gold credit projection (NO re-derivation → the per-(brand,currency) Σ for a given
snapshot_date equals the gold ledger's exactly). brand_id is the first column / tenant key.

PARITY: current side = StarRocks brain_silver.snap_attribution_credit (dbt). PK (brand_id, credit_id,
snapshot_date); money column credited_revenue_minor. With 0 credit rows in the current ledger the snapshot
is also empty → parity-exact. CAVEAT: snapshot_date = current_date() is RUN-DATE-dependent — if the Spark
job and the dbt build run on DIFFERENT calendar days, the PK (which includes snapshot_date) differs by the
date even with identical credit content. Run both same-day (the parity harness re-runs the Spark job right
before the check) so the snapshot_date matches.

Run via run-gold-attribution.sh.
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402

TABLE_NAME = "snap_attribution_credit"
SRC_TABLE = "gold_marketing_attribution"  # the dbt ref() source (a gold projection)

# Column contract — the dbt snap_attribution_credit select list. brand_id first; PK adds snapshot_date.
_COLUMNS = """
          brand_id               string    NOT NULL,
          credit_id              string    NOT NULL,
          snapshot_date          date      NOT NULL,
          order_id               string,
          channel                string,
          campaign_id            string,
          model_id               string,
          model_version          string,
          row_kind               string,
          credited_revenue_minor bigint,
          currency_code          string,
          confidence_grade       string,
          occurred_at            timestamp,
          computed_at            timestamp NOT NULL
""".strip("\n")


def _read_marketing_attribution(spark: SparkSession):
    fqtn = f"{CATALOG}.{GOLD_NAMESPACE}.{SRC_TABLE}"
    try:
        df = spark.table(fqtn)
        df.schema
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            raise SystemExit(
                f"[snap_attribution_credit] REQUIRED Iceberg table {fqtn} is absent — build "
                f"gold_marketing_attribution.py first (this snapshot reads it)."
            )
        raise


def materialize(spark: SparkSession) -> str:
    # snap_attribution_credit is a brain_SILVER mart (config schema='brain_silver').
    fqtn = create_iceberg_table(
        spark, SILVER_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(8, brand_id), days(snapshot_date)"
    )
    src = _read_marketing_attribution(spark)

    result = src.select(
        F.col("brand_id"),
        F.col("credit_id"),
        F.current_date().alias("snapshot_date"),
        F.col("order_id"),
        F.col("channel"),
        F.col("campaign_id"),
        F.col("model_id"),
        F.col("model_version"),
        F.col("row_kind"),
        F.col("credited_revenue_minor").cast("bigint").alias("credited_revenue_minor"),
        F.col("currency_code"),
        F.col("confidence_grade"),
        F.col("occurred_at"),
        F.current_timestamp().alias("computed_at"),
    )
    n = result.count()
    result.createOrReplaceTempView("snap_attribution_credit_src")

    # Idempotent same-day upsert on the PK (brand_id, credit_id, snapshot_date) — the dbt incremental
    # default-strategy semantic (prior days preserved; same-day re-run overwrites that day's snapshot).
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING snap_attribution_credit_src s
        ON t.brand_id = s.brand_id AND t.credit_id = s.credit_id AND t.snapshot_date = s.snapshot_date
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    total = spark.table(fqtn).count()
    print(f"[snap_attribution_credit] MERGEd {n} snapshot rows → {fqtn} (table now {total} rows)", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("snap-attribution-credit")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[snap_attribution_credit] DONE — Iceberg attribution snapshot populated (dual-run) ✓", flush=True)


if __name__ == "__main__":
    main()
