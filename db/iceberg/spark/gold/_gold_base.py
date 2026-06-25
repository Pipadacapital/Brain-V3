"""
_gold_base.py — the shared READ-Silver / WRITE-Gold MERGE helpers for the Brain V4 Phase-2 NET-NEW
gap Gold Spark jobs (GROUP "NEW gap Gold products": contribution_margin / logistics_performance /
cod_rto / settlement_summary / funnel / abandoned_cart / engagement / behavior / conversion_feedback /
campaign_performance).

These ten Gold marts have NO dbt predecessor (parity status=NEW — the matrix §3/4 GAP products). Each job
READS Iceberg brain_silver.<entity> (built in Phase 1/1b) and idempotently MERGEs into Iceberg
brain_gold.<mart> on the mart PK — the SAME append-only-on-no-match MERGE discipline as
bronze_materialize.py / _silver_base.py (write.upsert.enabled=false) plus an explicit WHEN MATCHED UPDATE
so a re-run over a growing Silver carries the latest rollup. ADDITIVE / dual-run / non-breaking: it
repoints NO reader, changes NO dbt model or app code, and writes ONLY into brain_gold.<these marts>.

WHY a thin shared module (non-breaking): the Silver→Gold READ wiring + the "recompute-the-rollup then
MERGE on the mart PK" shape is identical across all ten jobs. Factoring it here means each Gold job is
just (a) its Silver read SQL, (b) its money/credit math, (c) its mart PK + column contract. It imports
ONLY from iceberg_base (the Phase-0 seam) so it can never perturb Bronze, Silver or the dbt path.

HARD RULES honored by every caller (V4 rule 5):
  - brand_id is the tenant key, FIRST column on every row.
  - money is bigint MINOR units + a sibling currency_code (never a float / bare number); per-currency,
    NEVER blended across currencies.
  - largest-remainder rounding where the TS apportions (attribution credit must sum EXACTLY to the
    parent — no rounding drift; see largest_remainder_split below).
  - replay-safe: a Gold rollup is a FULL recompute from Silver each run, MERGE-UPDATE'd onto the PK →
    re-running over the same Silver is a no-op on identity and refreshes the latest rollup (never
    double-counts — the rollup is authoritative, not an incremental add).
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer `str | None` annotation eval.

import os
import sys

# The shared Phase-0 base lives one directory up; add it to the path so a spark-submit of a file in
# gold/ (cwd=/opt/gold) can import iceberg_base from the mounted spark/ root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import DataFrame, SparkSession  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG,
    GOLD_NAMESPACE,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

# The Silver namespace these Gold jobs READ from (Iceberg-sole SoR, built Phase 1/1b).
SILVER_NS = os.environ.get("SILVER_NAMESPACE", SILVER_NAMESPACE)

# Re-export the catalog + Gold namespace so a Gold job that needs to address a sibling Gold table
# (e.g. gold_campaign_performance reading the optional gold_attribution_credit) imports them from here.
__all__ = [
    "CATALOG", "GOLD_NAMESPACE", "SILVER_NAMESPACE", "SILVER_NS",
    "silver", "silver_exists", "ensure_gold_table", "merge_on_pk", "run_job",
]


def silver(table: str) -> str:
    """Fully-qualified Iceberg Silver table identifier: rest.brain_silver.<table>."""
    return f"{CATALOG}.{SILVER_NS}.{table}"


def silver_exists(spark: SparkSession, table: str) -> bool:
    """True iff the Silver source table exists (a job over an absent/empty Silver still writes an empty
    Gold mart — but a TOTALLY absent upstream table would raise; we probe so the job degrades gracefully)."""
    try:
        spark.table(silver(table)).schema
        return True
    except Exception:  # noqa: BLE001 — absent table → False (job writes an empty Gold mart, parity SKIPs)
        return False


def ensure_gold_table(spark: SparkSession, table: str, columns_sql: str, *, partitioned_by: str) -> str:
    """Create the brain_gold.<table> Iceberg table (brand_id-first, Bronze-parity props) if absent."""
    return create_iceberg_table(
        spark, GOLD_NAMESPACE, table, columns_sql, partitioned_by=partitioned_by
    )


def merge_on_pk(spark: SparkSession, fqtn: str, staged: DataFrame, pk: list[str]) -> None:
    """Idempotent MERGE of a fully-recomputed Gold rollup `staged` into `fqtn` on the mart PK.

    The rollup is already 1 row per PK (a GROUP BY upstream), so there is no in-batch dedup to do —
    MERGE: WHEN MATCHED UPDATE * (refresh the latest authoritative rollup), WHEN NOT MATCHED INSERT *.
    Replay-safe: a re-run over the same Silver yields identical rows.
    """
    staged.createOrReplaceTempView("_gold_stage")
    on_clause = " AND ".join(f"t.{c} = s.{c}" for c in pk)
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING _gold_stage s
        ON {on_clause}
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def run_job(app_name: str, build_fn) -> None:
    """Standard entrypoint: build a Spark session, run build_fn(spark), report the row count."""
    spark = build_spark(app_name)
    spark.sparkContext.setLogLevel("WARN")
    fqtn, n = build_fn(spark)
    print(f"[{app_name}] DONE — {fqtn} now has {n} rows", flush=True)
