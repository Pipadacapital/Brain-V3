"""
bronze_maintenance.py — Iceberg Bronze maintenance (ADR-0002 Slice 7; ADR-0010 Connect-era scope).

Under ADR-0010 the Bronze writer is the Kafka Connect Iceberg sink: the collector lane lands in
brain_bronze.collector_events_connect and each of the 9 connector raw lanes lands in its own
brain_bronze.<lane>_raw_connect table (auto-created on the lane's FIRST record). The retired Spark-SS
landing tables (brain_bronze.events, collector_events, the legacy *_raw) are RETAINED as history until
a separate data-retirement decision. This job maintains BOTH generations: in "maintain" mode it sweeps
EVERY table in the Bronze namespace (SHOW TABLES) — so a *_raw_connect table created after this job
last shipped is covered automatically — unless BRONZE_TABLE pins a single table for a one-off run.

Two modes (MODE env):

  "maintain" (default) — the periodic housekeeping (Argo CronWorkflow):
    1. rewrite_data_files  — compaction: coalesce the many small parquet files the writer produces
       (the Connect sink commits per flush interval, exactly like the old streaming micro-batches)
       into target-sized files (read performance + S3 cost).
    2. expire_snapshots    — drop snapshots older than the retention window and delete the
       data/manifest files only they referenced (the rolling retention guarantee).

  "erase" (ERASE_BRAND_ID set) — RIGHT-TO-ERASURE / crypto-shred companion (D13, I-S05). Targets the
    ONE table BRONZE_TABLE selects (default: the retained historical `events`); per-subject erasure
    across the *_raw / *_raw_connect lanes is erasure_raw_delete.py. After a brand's per-brand DEK is
    destroyed (crypto-shred makes the ciphertext unreadable), this PHYSICALLY removes that brand's
    rows from the open Bronze Parquet so no plaintext-derivable bytes remain:
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ADR-0010: the retired Spark-SS landing modules are DELETED — the writer is the Kafka Connect
# Iceberg sink. The session factory is the shared iceberg_base.build_spark (identical
# REST-catalog/MinIO wiring to the old landing factory, plus the fleet perf configs); the Bronze
# namespace constant is inlined here. Env BRONZE_TABLE pins a one-off run to a single table (and is
# the erase-mode target selector); when unset, maintain mode sweeps the whole namespace.
from iceberg_base import CATALOG, build_spark  # noqa: E402

NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")

_TABLE_NAME = os.environ.get("BRONZE_TABLE", "events")
TABLE = f"{CATALOG}.{NAMESPACE}.{_TABLE_NAME}"
QUALIFIED = f"{NAMESPACE}.{_TABLE_NAME}"  # what the system procedures expect (within the catalog)
MODE = os.environ.get("MODE", "maintain")
# SNAPSHOT TTL ≠ DATA RETENTION (AUD-PERF-013). expire_snapshots only drops HISTORY — superseded files
# + snapshot metadata; it NEVER deletes rows from current table state, so the previous 24-month cutoff
# (matching bronze_table.sql history.expire.max-snapshot-age-ms, the DATA "retention contract")
# delivered no data retention while keeping every commit snapshot + its files for 2 years. Snapshots
# need only a short, bounded time-travel window; the DATA retention is a row/partition DELETE concern
# (the raw-lane D4 window lives in bronze_raw_retention.py — rows in the durable collector lane are
# NEVER deleted: no event loss).
SNAPSHOT_TTL_MS = int(os.environ.get("SNAPSHOT_TTL_MS", str(604_800_000)))  # 7 days


def _rewrite(spark: SparkSession, qualified: str = None) -> None:
    q = qualified or QUALIFIED
    print(f"[maintenance] rewrite_data_files {CATALOG}.{q} …", flush=True)
    spark.sql(
        f"CALL {CATALOG}.system.rewrite_data_files("
        f"  table => '{q}',"
        f"  options => map('min-input-files','5','target-file-size-bytes','134217728')"
        f")"
    ).show(truncate=False)


def _expire(spark: SparkSession, ttl_ms: int = SNAPSHOT_TTL_MS, qualified: str = None) -> None:
    q = qualified or QUALIFIED
    # The CALL parser wants a TIMESTAMP literal (not a function expression), so compute the cutoff here.
    cutoff = (datetime.now(timezone.utc) - timedelta(milliseconds=ttl_ms)).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[maintenance] expire_snapshots {CATALOG}.{q} older_than '{cutoff}' retain_last=1 …", flush=True)
    spark.sql(
        f"CALL {CATALOG}.system.expire_snapshots("
        f"  table => '{q}',"
        f"  older_than => TIMESTAMP '{cutoff}',"
        f"  retain_last => 1"
        f")"
    ).show(truncate=False)


def _maintenance_tables(spark: SparkSession) -> "list[str]":
    """The tables this run maintains. BRONZE_TABLE pins ONE (one-off / erase target); otherwise scan
    the namespace so BOTH generations are covered without enumeration: the Connect-written tables
    (collector_events_connect + the auto-created *_raw_connect lanes — a lane's table appears on its
    first record, so a fresh lane joins the sweep automatically) AND the retained historical tables
    (events, collector_events, the legacy *_raw)."""
    if os.environ.get("BRONZE_TABLE"):
        return [_TABLE_NAME]
    rows = spark.sql(f"SHOW TABLES IN {CATALOG}.{NAMESPACE}").collect()
    return sorted(r["tableName"] for r in rows)


def maintain(spark: SparkSession) -> None:
    tables = _maintenance_tables(spark)
    print(f"[maintenance] sweeping {len(tables)} table(s) in {CATALOG}.{NAMESPACE}: {tables}", flush=True)
    failures = []
    for t in tables:
        q = f"{NAMESPACE}.{t}"
        try:
            _rewrite(spark, qualified=q)
            _expire(spark, qualified=q)
        except Exception as exc:  # noqa: BLE001 — one table must never abort the housekeeping sweep
            failures.append(t)
            print(f"[maintenance] WARN {CATALOG}.{q}: {exc}", flush=True)
    if failures:
        raise SystemExit(f"[maintenance] FAILED on {len(failures)} table(s): {failures}")
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
    # ttl_ms=0 → cutoff=now: purge the pre-deletion snapshots immediately (no time-travel back to the
    # erased rows). With the old 24-month cutoff this step was silently a no-op.
    _expire(spark, ttl_ms=0)
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
