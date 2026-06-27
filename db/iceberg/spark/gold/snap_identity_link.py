"""
snap_identity_link.py — Brain V4 Spark Gold-group SCD snapshot. GROUP=executive+cac.

The AS-OF (point-in-time) identity-link snapshot — the identity-graph mirror of snap_order_state. Each
run stamps the run-date as snapshot_date and captures every active identity LINK's CURRENT (brain_id,
is_active) on that day, appending a new day-slice while leaving prior days intact. Reading the table
WHERE snapshot_date <= D and taking the latest row per identifier reconstructs the identity link AS-OF
date D — the HISTORICAL brain_id an identifier resolved to on that day, NOT today's state. That is the
point of a snapshot: deterministic time-travel over the identity graph (e.g. "which customer did this
email hash belong to when the order was placed?") without trusting a mutable current-state table.

NAMESPACE: like snap_order_state, this is a point-in-time history of a SILVER entity, so it WRITES to
  the brain_silver namespace (not brain_gold). It lives in the gold/ directory and runs in the gold
  refresh group, but its medallion layer is Silver (registry layer='silver').

SOURCE (pure Spark, Iceberg-only — no JDBC):
  brain_silver.silver_identity_alias — the Spark→Iceberg projection of the Neo4j IDENTIFIES edges
  (built by silver_identity_alias.py). It is the Iceberg sibling of the StarRocks-native
  brain_ops.silver_identity_link (materialized by apps/stream-worker/.../identity-export/run.ts from
  Neo4j, the identity SoR per ADR-0004). We prefer the Iceberg source so this stays a PURE Spark read
  (no StarRocks/JDBC seam) — same grain, same columns (brand_id, identifier_type, identifier_value,
  brain_id, is_active). Neo4j remains the SoR; brain_id is only ever carried through, never minted here.

GRAIN / PK: exactly one row per (brand_id, identifier_type, identifier_value, snapshot_date) — the
  snapshot PK. brand_id is the tenant key, FIRST column.
PII: identifier_value is a 64-hex HASH only (the resolver hashes raw identifiers at the boundary) — this
  job NEVER reads or writes a raw email/phone. NO money columns (an identity mapping carries none).
IDEMPOTENT / REPLAY-SAFE: MERGE on the FULL PK (brand_id, identifier_type, identifier_value,
  snapshot_date) — re-running on the SAME day UPDATEs the today-row (no duplicate); a LATER-day run
  appends that day's snapshot, prior days untouched. Mirrors snap_order_state exactly.

Run via run-gold-executive-cac.sh (pure Iceberg read+write; no Kafka / no PG/SR JDBC).
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

TABLE_NAME = "snap_identity_link"

# Source AND target both live in brain_silver (a point-in-time history of a Silver entity).
SILVER_IDENTITY_ALIAS = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_alias"

# Column contract — the snapshot PK + carried link state. brand_id tenant key first; NO money, hash-only.
_COLUMNS = """
          brand_id            string    NOT NULL,
          identifier_type     string    NOT NULL,
          identifier_value    string    NOT NULL,
          snapshot_date       date      NOT NULL,
          brain_id            string,
          is_active           boolean,
          computed_at         timestamp NOT NULL
""".strip("\n")


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        # Brand-first tenant bucketing + day-partition on the snapshot grain (mirrors snap_order_state;
        # bounds storage, prunes the AS-OF read by day).
        partitioned_by="bucket(8, brand_id), days(snapshot_date)",
    )

    spark.read.table(SILVER_IDENTITY_ALIAS).createOrReplaceTempView("silver_identity_alias")

    # ── the snapshot projection: run-date stamp + pass-through link state ──
    result = spark.sql(
        """
        select
            brand_id,
            identifier_type,
            identifier_value,
            current_date()       as snapshot_date,
            brain_id,
            is_active,
            current_timestamp()  as computed_at
        from silver_identity_alias
        """
    )
    result.createOrReplaceTempView("snap_identity_link_new")

    # Idempotent MERGE on the FULL snapshot PK — same-day re-run UPDATEs the today-row; a later-day run
    # INSERTs that day's snapshot, prior days untouched.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING snap_identity_link_new s
        ON t.brand_id = s.brand_id
           AND t.identifier_type = s.identifier_type
           AND t.identifier_value = s.identifier_value
           AND t.snapshot_date = s.snapshot_date
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[snap_identity_link] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("snap-identity-link")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)
    print("[snap_identity_link] DONE ✓", flush=True)


if __name__ == "__main__":
    main()
