"""
bronze_maintenance.py — Iceberg Bronze maintenance (ADR-0002 Slice 7).

Two modes (MODE env):

  "maintain" (default) — the periodic housekeeping (Argo CronWorkflow):
    1. rewrite_data_files  — compaction: coalesce the many small per-micro-batch parquet files the
       streaming writer produces into target-sized files (read performance + S3 cost).
    2. expire_snapshots    — 24-month TTL (I-E02): drop snapshots older than the retention window and
       delete the data/manifest files only they referenced (the rolling retention guarantee).

  "erase" (ERASE_BRAND_ID set) — RIGHT-TO-ERASURE / crypto-shred companion (D13, I-S05). After a
    brand's per-brand DEK is destroyed (crypto-shred makes the ciphertext unreadable), this PHYSICALLY
    removes that brand's rows from the open Bronze Parquet so no plaintext-derivable bytes remain:
      1. DELETE FROM ... WHERE brand_id = <erased>   (format-v2 merge-on-read delete)
      2. rewrite_data_files  — rewrite the affected partitions so the deleted rows are gone from the
         live data files (not just masked by delete files).
      3. expire_snapshots    — expire the pre-deletion snapshots so the OLD files (which still hold the
         rows) are deleted from S3 — without this, time-travel could still read the erased data.
    This is the Iceberg half of erasure; the ledger/audit survive on a surrogate id (handled elsewhere).

Run via spark-submit inside the Spark+Iceberg image — see run-bronze-maintenance.sh. The Iceberg
`system.*` stored procedures are called through the REST catalog (named `rest` here).
"""
import os
import sys
from datetime import datetime, timedelta, timezone

from pyspark.sql import SparkSession

# UNIFIED-BRONZE: the split sinks are replaced by bronze_landing.py → ONE table brain_bronze.events.
# Maintain that unified table (compaction + snapshot-expiry over the single Bronze table). Import the
# shared factory from bronze_landing (bronze_materialize is retired). Env BRONZE_TABLE overrides for a
# one-off against a legacy table during the bake. Rollback: BRONZE_TABLE=collector_events.
from bronze_landing import CATALOG, NAMESPACE, build_spark

_TABLE_NAME = os.environ.get("BRONZE_TABLE", "events")
TABLE = f"{CATALOG}.{NAMESPACE}.{_TABLE_NAME}"
QUALIFIED = f"{NAMESPACE}.{_TABLE_NAME}"  # what the system procedures expect (within the catalog)
MODE = os.environ.get("MODE", "maintain")
# 24-month retention (ms) — matches db/iceberg/bronze_table.sql history.expire.max-snapshot-age-ms.
RETAIN_MS = int(os.environ.get("RETENTION_MS", str(63_072_000_000)))


def _rewrite(spark: SparkSession) -> None:
    print(f"[maintenance] rewrite_data_files {TABLE} …", flush=True)
    spark.sql(
        f"CALL {CATALOG}.system.rewrite_data_files("
        f"  table => '{QUALIFIED}',"
        f"  options => map('min-input-files','5','target-file-size-bytes','134217728')"
        f")"
    ).show(truncate=False)


def _expire(spark: SparkSession) -> None:
    # The CALL parser wants a TIMESTAMP literal (not a function expression), so compute the cutoff here.
    cutoff = (datetime.now(timezone.utc) - timedelta(milliseconds=RETAIN_MS)).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[maintenance] expire_snapshots {TABLE} older_than '{cutoff}' retain_last=1 …", flush=True)
    spark.sql(
        f"CALL {CATALOG}.system.expire_snapshots("
        f"  table => '{QUALIFIED}',"
        f"  older_than => TIMESTAMP '{cutoff}',"
        f"  retain_last => 1"
        f")"
    ).show(truncate=False)


def maintain(spark: SparkSession) -> None:
    _rewrite(spark)
    _expire(spark)
    print("[maintenance] DONE (compaction + snapshot expiry)", flush=True)


def erase(spark: SparkSession, brand_id: str) -> None:
    # Guard: a UUID-shaped brand id only (defense-in-depth on an interpolated identifier).
    safe = "".join(ch for ch in brand_id if ch in "0123456789abcdefABCDEF-")
    if safe != brand_id or len(safe) < 32:
        raise SystemExit(f"[erase] refusing — ERASE_BRAND_ID is not a UUID: {brand_id!r}")
    before = spark.table(TABLE).where(f"brand_id = '{safe}'").count()
    print(f"[erase] brand={safe} rows_before={before}", flush=True)
    spark.sql(f"DELETE FROM {TABLE} WHERE brand_id = '{safe}'")
    _rewrite(spark)   # rewrite affected partitions so live files no longer contain the rows
    _expire(spark)    # expire pre-deletion snapshots so the old files are purged from S3 (no time-travel back)
    after = spark.table(TABLE).where(f"brand_id = '{safe}'").count()
    print(f"[erase] brand={safe} rows_after={after} — {'OK ✓' if after == 0 else 'STILL PRESENT ✗'}", flush=True)
    if after != 0:
        sys.exit(1)


def main() -> None:
    spark = build_spark()
    spark.sparkContext.setLogLevel("WARN")
    if MODE == "erase":
        brand = os.environ.get("ERASE_BRAND_ID", "")
        if not brand:
            raise SystemExit("[erase] ERASE_BRAND_ID is required for MODE=erase")
        erase(spark, brand)
    else:
        maintain(spark)


if __name__ == "__main__":
    main()
