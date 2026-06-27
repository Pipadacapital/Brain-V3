"""
gold_customer_segments.py — the deterministic customer-segments Gold mart (Brain V4 Phase 2, GROUP
customer). Reads the silver_customer spine and emits, per brand, TWO orthogonal segment dimensions as a
rollup keyed (brand_id, segment_type, segment):

  • segment_type='value_tier' — the EXISTING value-tier ladder (high_value / mid_value / low_value /
    no_realized_value), UNCHANGED, kept byte-for-byte so existing value-tier readers never break.
  • segment_type='lifecycle'  — the NEW named lifecycle/behavioral ladder (VIP / high_value / loyal /
    first_time_buyer / at_risk / churned / cart_abandoner / window_shopper) assigned by a deterministic
    first-match precedence over the RFM / recency / order-count / health signals.

The rule logic — both CASE ladders + the lifecycle precedence + every threshold — lives in the pure,
no-Spark single-source module _segment_rules.py (so the exact SQL the job runs is unit-tested against
sqlite). See that module's header for the full precedence and the gold_customer_scores RFM /
gold_customer_health band mapping. A customer holds exactly ONE value tier AND ONE primary lifecycle
segment; the segment_type discriminator keeps the two ladders distinct (the label 'high_value' exists in
BOTH — segment_type is what disambiguates).

ADDITIVE & non-breaking: the value_tier rows are identical to the prior output (same labels, same
customer_count, same segment_value_minor). The change adds (a) the segment_type column and (b) the
lifecycle rows. brand_id is the first column / tenant key (V4 rule 5).

WHY signals are folded inline from silver_customer (not read from gold_customer_scores /
gold_customer_health): this mart runs in Phase 1 (the customer-360 GOLD build) BEFORE scores/health are
built, so reading them would be a build-ordering hazard. V4 rule: features are RUNTIME — fold the SAME
RFM/recency/health signals from the Silver spine at run time (identical thresholds, see _segment_rules).
reads_from therefore stays [silver_customer] (no cross-Gold dependency).

THE THREE BASE SIGNALS (per silver_customer row, all integer):
  recency_days         = datediff(current_date, last_seen_at::date)   — recency / health signal
  lifetime_orders      = silver_customer.lifetime_orders              — order-count / frequency signal
  lifetime_value_minor = silver_customer.lifetime_value_minor (bigint MINOR units) — monetary signal

MONEY (I-S07): segment_value_minor is a bigint MINOR-unit Σ of lifetime_value_minor — a pure additive
sum, no rounding. The segment grain carries NO currency_code (it sums across all of a brand's
currencies into one per-(brand, segment_type, segment) bucket — the documented, unchanged deviation; see
parity/mart_registry.py). registry money_columns=[] for the same reason (no sibling currency_code at
this grain). PII-safe: no brain_id / hashes on this rollup grain — counts + Σ only.

PK (brand_id, segment_type, segment). brand_id is the first column / tenant key.

Run via spark-submit inside the Spark+Iceberg image — see ../run-gold-customer.sh.
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from _segment_rules import (  # noqa: E402
    SEGMENT_TYPE_LIFECYCLE,
    SEGMENT_TYPE_VALUE_TIER,
    lifecycle_segment_case_sql,
    value_tier_case_sql,
)

TABLE_NAME = "gold_customer_segments"

_COLUMNS = """
          brand_id            string    NOT NULL,
          segment_type        string    NOT NULL,
          segment             string    NOT NULL,
          customer_count      bigint,
          segment_value_minor bigint,
          updated_at          timestamp
""".strip("\n")


def _read_silver_customer(spark: SparkSession):
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"
    try:
        df = spark.table(fqtn)
        df.schema
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            raise SystemExit(f"[gold_customer_segments] REQUIRED Iceberg {fqtn} absent — build silver_customer first.")
        raise


def _evolve_schema(spark: SparkSession, fqtn: str) -> None:
    """Additively add segment_type to a PRE-EXISTING table (create_iceberg_table is CREATE-IF-NOT-EXISTS
    only and will not evolve an already-deployed table). Idempotent / best-effort: a fresh table already
    has the column, an older one gets it added; the full-recompute MERGE then backfills every row's value
    ('value_tier' / 'lifecycle'). NO-OP-safe — never break the build on an already-present column."""
    try:
        spark.sql(f"ALTER TABLE {fqtn} ADD COLUMNS (segment_type string)")
        print(f"[gold_customer_segments] evolved {fqtn}: added segment_type column", flush=True)
    except Exception:  # noqa: BLE001 — column already exists (fresh table) → nothing to do
        pass


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(4, brand_id)"
    )
    _evolve_schema(spark, fqtn)

    customers = _read_silver_customer(spark)
    customers.createOrReplaceTempView("silver_customer_src")

    # The three base signals per customer (V4 runtime feature fold — identical thresholds to
    # gold_customer_scores / gold_customer_health, applied inside the shared CASE strings).
    #   recency_days = datediff(current_date, last_seen_at::date); NULL last_seen_at → a large sentinel
    #   so the customer falls into 'churned' (never silently mis-bucketed as recent).
    value_tier_case = value_tier_case_sql("lifetime_value_minor")
    lifecycle_case = lifecycle_segment_case_sql("recency_days", "lifetime_orders", "lifetime_value_minor")

    result = spark.sql(
        f"""
        WITH signals AS (
            SELECT
                brand_id,
                COALESCE(lifetime_orders, 0)                                              AS lifetime_orders,
                COALESCE(lifetime_value_minor, 0)                                         AS lifetime_value_minor,
                COALESCE(
                    CAST(datediff(current_date(), CAST(last_seen_at AS DATE)) AS INT),
                    {int(10 ** 6)}
                )                                                                          AS recency_days
            FROM silver_customer_src
            WHERE brand_id IS NOT NULL
        ),
        labelled AS (
            SELECT
                brand_id,
                lifetime_value_minor,
                '{SEGMENT_TYPE_VALUE_TIER}' AS segment_type,
                {value_tier_case}           AS segment
            FROM signals
            UNION ALL
            SELECT
                brand_id,
                lifetime_value_minor,
                '{SEGMENT_TYPE_LIFECYCLE}'  AS segment_type,
                {lifecycle_case}            AS segment
            FROM signals
        )
        SELECT
            brand_id,
            segment_type,
            segment,
            CAST(COUNT(*) AS BIGINT)                       AS customer_count,
            CAST(SUM(lifetime_value_minor) AS BIGINT)      AS segment_value_minor,
            current_timestamp()                            AS updated_at
        FROM labelled
        GROUP BY brand_id, segment_type, segment
        """
    )

    n = result.count()
    result.createOrReplaceTempView("seg_src")

    # Full-recompute MERGE on (brand_id, segment_type, segment): UPDATE the aggregate when it restates,
    # INSERT new tiers/segments. Replay-safe (the rollup is authoritative, never an incremental add).
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING seg_src s
        ON t.brand_id = s.brand_id AND t.segment_type = s.segment_type AND t.segment = s.segment
        WHEN MATCHED THEN UPDATE SET
          t.customer_count      = s.customer_count,
          t.segment_value_minor = s.segment_value_minor,
          t.updated_at          = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
          brand_id, segment_type, segment, customer_count, segment_value_minor, updated_at
        ) VALUES (
          s.brand_id, s.segment_type, s.segment, s.customer_count, s.segment_value_minor, s.updated_at
        )
        """
    )
    total = spark.table(fqtn).count()
    print(
        f"[gold_customer_segments] MERGEd {n} (value_tier + lifecycle) segment rows → {fqtn} "
        f"(table now {total} rows)",
        flush=True,
    )
    return fqtn


def main() -> None:
    spark = build_spark("gold-customer-segments")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[gold_customer_segments] DONE — Iceberg value-tier + lifecycle segments populated ✓", flush=True)


if __name__ == "__main__":
    main()
