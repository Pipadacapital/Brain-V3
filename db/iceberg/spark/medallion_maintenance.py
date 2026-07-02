"""
medallion_maintenance.py — Iceberg Silver + Gold maintenance (Brain V4 Phase 0, Area B / PR-0.2).

The Silver/Gold companion to bronze_maintenance.py: extends the SAME three maintenance operations
(compaction, snapshot-expiry, crypto-shred erasure) to the new brain_silver + brain_gold namespaces.
ADDITIVE + non-breaking — it touches NO Bronze code and reads NO existing path; it operates only on
the Silver/Gold tables provisioned by provision_silver_gold.py (and, later, the real Silver/Gold marts).

Modes (MODE env):

  "maintain" (default) — periodic housekeeping (Argo CronWorkflow shape):
    For EVERY table in brain_silver and brain_gold (auto-discovered via SHOW TABLES, so new marts are
    covered without editing this file):
      1. rewrite_data_files  — compaction: coalesce small per-batch parquet files into target-sized ones.
      2. expire_snapshots    — TTL: drop snapshots older than the retention window + delete the data/
         manifest files only they referenced.

  "erase" (ERASE_BRAND_ID set) — RIGHT-TO-ERASURE / crypto-shred companion (mirrors bronze_maintenance):
    For every Silver/Gold table that HAS a brand_id column (all of them, by the tenant-key invariant):
      1. DELETE FROM ... WHERE brand_id = <erased>   (format-v2 merge-on-read delete)
      2. rewrite_data_files  — rewrite affected partitions so live files no longer contain the rows.
      3. expire_snapshots    — expire pre-deletion snapshots so the old files are purged (no time-travel back).
    This is the Silver/Gold half of erasure; Bronze is handled by bronze_maintenance.py erase.

Run via spark-submit inside the Spark+Iceberg image — see run-medallion-maintenance.sh. The Iceberg
system.* stored procedures are called through the REST catalog (named `rest` here), exactly as Bronze does.
"""
from __future__ import annotations  # Python 3.8 (Spark image): defer `list[str]` annotation eval.

import os
import sys
from datetime import datetime, timedelta, timezone

from pyspark.sql import SparkSession

from iceberg_base import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, build_spark

MODE = os.environ.get("MODE", "maintain")
# Namespaces this maintenance run covers (comma-separated; defaults = Silver + Gold). `or` (not a
# get() default): run-medallion-maintenance.sh exports MAINT_NAMESPACES="" when unset, which must
# fall back too — an empty list made the whole job a silent no-op (AUD-PERF-004).
NAMESPACES = [
    ns.strip()
    for ns in (os.environ.get("MAINT_NAMESPACES") or f"{SILVER_NAMESPACE},{GOLD_NAMESPACE}").split(",")
    if ns.strip()
]
# SNAPSHOT TTL ≠ DATA RETENTION (AUD-PERF-013). expire_snapshots only drops HISTORY — superseded files
# + snapshot metadata; it NEVER deletes rows from current table state, so a 24-month cutoff here
# delivered no data retention while keeping every micro-batch/cycle snapshot (and every file it
# references) for 2 years: unbounded metadata + storage = mart_size × refresh cycles. Snapshots need
# only a short, bounded time-travel window; the 24-month DATA retention contract, where required, is a
# row/partition DELETE concern (the raw-Bronze D4 window lives in bronze_raw_retention.py).
SNAPSHOT_TTL_MS = int(os.environ.get("SNAPSHOT_TTL_MS", str(604_800_000)))  # 7 days
# Orphan-file removal (guarded; AUD-PERF-004): delete files under a table's location that NO snapshot
# references (leftovers of failed/killed jobs). older_than has a HARD 3-day floor so files of any
# in-flight or recently-retried commit are never candidates; ORPHAN_FILES=0 disables the sweep.
ORPHAN_FILES = os.environ.get("ORPHAN_FILES", "1") == "1"
ORPHAN_OLDER_THAN_DAYS = max(3, int(os.environ.get("ORPHAN_OLDER_THAN_DAYS", "3")))
# Compaction file-group floor. Iceberg's default (5) never fires on the marts' layout — bucket()+days()
# partitioning spreads the per-cycle MERGE output so partitions hold 2-3 tiny (~16KB) files each
# (measured: silver_collector_event = 1,726 files / 27MB over 950 partitions, max 3 files/partition).
REWRITE_MIN_INPUT_FILES = int(os.environ.get("REWRITE_MIN_INPUT_FILES", "2"))


def _tables_in(spark: SparkSession, namespace: str) -> list[str]:
    """Discover every table in a namespace so new marts are maintained without editing this file."""
    rows = spark.sql(f"SHOW TABLES IN {CATALOG}.{namespace}").collect()
    # SHOW TABLES returns (namespace, tableName, isTemporary) — take the table name column.
    return [r["tableName"] for r in rows]


def _rewrite(spark: SparkSession, namespace: str, table: str) -> None:
    qualified = f"{namespace}.{table}"
    print(f"[maintenance] rewrite_data_files {CATALOG}.{qualified} …", flush=True)
    spark.sql(
        f"CALL {CATALOG}.system.rewrite_data_files("
        f"  table => '{qualified}',"
        f"  options => map('min-input-files','{REWRITE_MIN_INPUT_FILES}','target-file-size-bytes','134217728')"
        f")"
    ).show(truncate=False)


def _expire(spark: SparkSession, namespace: str, table: str, ttl_ms: int = SNAPSHOT_TTL_MS) -> None:
    qualified = f"{namespace}.{table}"
    cutoff = (datetime.now(timezone.utc) - timedelta(milliseconds=ttl_ms)).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[maintenance] expire_snapshots {CATALOG}.{qualified} older_than '{cutoff}' retain_last=1 …", flush=True)
    spark.sql(
        f"CALL {CATALOG}.system.expire_snapshots("
        f"  table => '{qualified}',"
        f"  older_than => TIMESTAMP '{cutoff}',"
        f"  retain_last => 1"
        f")"
    ).show(truncate=False)


def _remove_orphans(spark: SparkSession, namespace: str, table: str) -> None:
    qualified = f"{namespace}.{table}"
    cutoff = (datetime.now(timezone.utc) - timedelta(days=ORPHAN_OLDER_THAN_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[maintenance] remove_orphan_files {CATALOG}.{qualified} older_than '{cutoff}' …", flush=True)
    spark.sql(
        f"CALL {CATALOG}.system.remove_orphan_files("
        f"  table => '{qualified}',"
        f"  older_than => TIMESTAMP '{cutoff}'"
        f")"
    ).show(truncate=False)


def maintain(spark: SparkSession) -> None:
    failures = 0
    for namespace in NAMESPACES:
        tables = _tables_in(spark, namespace)
        print(f"[maintenance] {CATALOG}.{namespace}: {len(tables)} table(s) → {tables}", flush=True)
        for table in tables:
            # One broken table must not abort the whole sweep — log, count, keep going, exit non-zero.
            try:
                _rewrite(spark, namespace, table)
                _expire(spark, namespace, table)
                if ORPHAN_FILES:
                    _remove_orphans(spark, namespace, table)
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"[maintenance] WARN {CATALOG}.{namespace}.{table}: {exc}", flush=True)
    if failures:
        print(f"[maintenance] DONE with {failures} failed table(s) ✗", flush=True)
        sys.exit(1)
    print("[maintenance] DONE (compaction + snapshot expiry + orphan sweep over Silver + Gold)", flush=True)


def erase(spark: SparkSession, brand_id: str) -> None:
    # Guard: a UUID-shaped brand id only (defense-in-depth on an interpolated identifier) — same as Bronze.
    safe = "".join(ch for ch in brand_id if ch in "0123456789abcdefABCDEF-")
    if safe != brand_id or len(safe) < 32:
        raise SystemExit(f"[erase] refusing — ERASE_BRAND_ID is not a UUID: {brand_id!r}")

    failures = 0
    for namespace in NAMESPACES:
        for table in _tables_in(spark, namespace):
            fqtn = f"{CATALOG}.{namespace}.{table}"
            cols = [f.name for f in spark.table(fqtn).schema.fields]
            if "brand_id" not in cols:
                print(f"[erase] skip {fqtn} — no brand_id column", flush=True)
                continue
            before = spark.table(fqtn).where(f"brand_id = '{safe}'").count()
            print(f"[erase] {fqtn} brand={safe} rows_before={before}", flush=True)
            spark.sql(f"DELETE FROM {fqtn} WHERE brand_id = '{safe}'")
            _rewrite(spark, namespace, table)
            # ttl_ms=0 → cutoff=now: the pre-deletion snapshots MUST be purged immediately or the erased
            # rows stay time-travel-readable for the whole snapshot TTL (with the old 24-month cutoff this
            # step was silently a no-op — nothing was ever younger than the cutoff).
            _expire(spark, namespace, table, ttl_ms=0)
            after = spark.table(fqtn).where(f"brand_id = '{safe}'").count()
            status = "OK ✓" if after == 0 else "STILL PRESENT ✗"
            print(f"[erase] {fqtn} brand={safe} rows_after={after} — {status}", flush=True)
            if after != 0:
                failures += 1
    if failures:
        sys.exit(1)
    print(f"[erase] DONE — brand {safe} erased from Silver + Gold ✓", flush=True)


def main() -> None:
    spark = build_spark("medallion-maintenance")
    spark.sparkContext.setLogLevel("WARN")
    if ORPHAN_FILES:
        # remove_orphan_files lists the table location via the HADOOP FileSystem (NOT the catalog's
        # S3FileIO) — map the s3:// scheme onto S3A. Requires hadoop-aws on the classpath
        # (run-medallion-maintenance.sh adds the package; the prod image pre-bakes it).
        #
        # AUD-COST-020: the S3A wiring is CONDITIONAL on S3_ENDPOINT. Previously the MinIO
        # endpoint + the 'brain'/'brainbrain' static keys were unconditional DEFAULTS, which
        # broke prod (IRSA pods have no static keys and must talk to real S3, not minio:9000).
        #   - S3_ENDPOINT set (local compose / MinIO): custom endpoint + path-style + the
        #     static keys IF provided (exactly the old behavior — the run script sets all).
        #   - S3_ENDPOINT unset/empty (prod): NO endpoint override; credentials resolve via
        #     com.amazonaws.auth.DefaultAWSCredentialsProviderChain, which includes
        #     WebIdentityTokenCredentialsProvider — i.e. the pod's IRSA role, zero static keys.
        hconf = spark.sparkContext._jsc.hadoopConfiguration()  # noqa: SLF001
        hconf.set("fs.s3.impl", "org.apache.hadoop.fs.s3a.S3AFileSystem")
        endpoint = (os.environ.get("S3_ENDPOINT") or "").strip()
        if endpoint:
            hconf.set("fs.s3a.endpoint", endpoint)
            hconf.set("fs.s3a.path.style.access", "true")
            access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
            secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
            if access_key and secret_key:
                hconf.set("fs.s3a.access.key", access_key)
                hconf.set("fs.s3a.secret.key", secret_key)
        else:
            hconf.set(
                "fs.s3a.aws.credentials.provider",
                "com.amazonaws.auth.DefaultAWSCredentialsProviderChain",
            )
    if MODE == "erase":
        brand = os.environ.get("ERASE_BRAND_ID", "")
        if not brand:
            raise SystemExit("[erase] ERASE_BRAND_ID is required for MODE=erase")
        erase(spark, brand)
    else:
        maintain(spark)


if __name__ == "__main__":
    main()
