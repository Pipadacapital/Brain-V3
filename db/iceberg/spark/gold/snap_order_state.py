"""
snap_order_state.py — Brain V4 Phase 2 (Spark Gold, dual-run). GROUP=executive+cac.

Reimplements the dbt model db/dbt/models/marts/snap_order_state.sql as a Spark job that READS Iceberg
brain_silver.silver_order_state (built by the Phase-1 Spark job) and WRITES Iceberg
brain_silver.snap_order_state via an idempotent MERGE on the snapshot PK. It runs BESIDE the live
dbt→StarRocks brain_silver.snap_order_state (dual-run, NON-BREAKING): repoints no reader, changes no
dbt model, changes no app code. ADDITIVE only.

NOTE on the namespace: in the dbt model snap_order_state is configured schema='brain_silver' (it is a
Silver-layer SCD snapshot, not a Gold mart). We mirror that: this Spark job WRITES to brain_silver, not
brain_gold, so the table address matches the dbt side exactly. (This group OWNS it per the V4 Phase-2
ownership split; the medallion layer is Silver because it is point-in-time history of a Silver entity.)

THE dbt TRANSFORM (reproduced exactly):
  select brand_id, order_id, current_date() as snapshot_date, brain_id, lifecycle_state, is_terminal,
         order_value_minor, currency_code, state_effective_at, current_timestamp() as computed_at
  from silver_order_state

This is an INCREMENTAL, append-PER-DAY snapshot: each run stamps the run-date as snapshot_date and
captures every order's CURRENT state on that day. Prior snapshot_dates are preserved; a same-day re-run is
idempotent (the PK includes snapshot_date → MERGE UPDATEs the existing today-row, never duplicates it).

GRAIN / PK: exactly one row per (brand_id, order_id, snapshot_date) — the snapshot PK.
MONEY: order_value_minor is carried verbatim as bigint MINOR units, paired with currency_code on-row
  (no aggregation here — a pass-through snapshot). brand_id is the tenant key, FIRST column.
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, order_id, snapshot_date) — re-running on the SAME day is a
  no-op-on-identity (UPDATE the today-row); running on a LATER day appends that day's snapshot, leaving
  all prior days intact. Mirrors the dbt PRIMARY-key upsert-on-the-full-grain semantics.

PARITY NOTE: snapshot_date = the RUN date on BOTH sides. The Spark job and the dbt job must be run on the
  SAME calendar day for a like-for-like parity comparison (the oracle keys on the full PK incl.
  snapshot_date). On a given day both sides snapshot the same silver_order_state → same rows. If the two
  jobs ran on different days the per-(brand,order) state may legitimately differ (that IS the SCD value);
  the parity oracle scopes by PK so cross-day rows are simply "missing on the other side", which is the
  honest dual-run signal until both run same-day.

Run via run-gold-executive-cac.sh (pure Iceberg read+write; no Kafka / no PG JDBC).
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import (  # noqa: E402 — sys.path tweak above
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

TABLE_NAME = "snap_order_state"

# Source AND target both live in brain_silver (the dbt model is schema='brain_silver').
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"

# Column contract — byte-for-byte the dbt model's output projection (verified against the live StarRocks
# DESC brain_silver.snap_order_state). brand_id tenant key first; money = bigint minor + currency.
_COLUMNS = """
          brand_id            string    NOT NULL,
          order_id            string    NOT NULL,
          snapshot_date       date      NOT NULL,
          brain_id            string,
          lifecycle_state     string,
          is_terminal         boolean,
          order_value_minor   bigint,
          currency_code       string,
          state_effective_at  timestamp,
          computed_at         timestamp NOT NULL
""".strip("\n")


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        # PF-1: brand-first tenant bucketing + day-partition on the snapshot grain (mirrors the dbt
        # RANGE/Expr partition on snapshot_date; bounds storage, prunes by day).
        partitioned_by="bucket(8, brand_id), days(snapshot_date)",
    )

    spark.read.table(SILVER_ORDER_STATE).createOrReplaceTempView("silver_order_state")

    # ── the dbt snapshot projection, reproduced verbatim (run-date stamp + pass-through state) ──
    result = spark.sql(
        """
        select
            brand_id,
            order_id,
            current_date()       as snapshot_date,
            brain_id,
            lifecycle_state,
            is_terminal,
            order_value_minor,
            currency_code,
            state_effective_at,
            current_timestamp()  as computed_at
        from silver_order_state
        """
    )
    result.createOrReplaceTempView("snap_order_state_new")

    # Idempotent MERGE on the FULL snapshot PK (brand_id, order_id, snapshot_date) — same-day re-run
    # UPDATEs the today-row; a later-day run INSERTs that day's snapshot, prior days untouched.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING snap_order_state_new s
        ON t.brand_id = s.brand_id
           AND t.order_id = s.order_id
           AND t.snapshot_date = s.snapshot_date
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[snap_order_state] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("snap-order-state")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)
    print("[snap_order_state] DONE ✓", flush=True)


if __name__ == "__main__":
    main()
