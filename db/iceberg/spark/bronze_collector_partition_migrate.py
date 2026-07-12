"""
bronze_collector_partition_migrate.py — AUD-IMPL-025: ONE-TIME metadata migration that adds a
`days(kafka_timestamp)` partition spec to brain_bronze.collector_events_connect, with a parity check.

WHY: the collector Bronze table was AUTO-CREATED by the ADR-0010 Kafka Connect Iceberg sink with NO
partition spec (the sink's auto-create-props carried only a compression codec), and it is retained
FOREVER by design (system-of-record; deliberately excluded from bronze_raw_retention.py). Every
reader that filters on time — the hourly silver_collector_event incremental, the Trino lift-view
health endpoints — therefore full-scans the whole history. The sink DOES insert a PHYSICAL
`kafka_timestamp` column (the InsertField transform), so a `days(kafka_timestamp)` partition spec
gives Spark AND Trino real file/partition pruning on exactly the column the (AUD-IMPL-025) watermark
in silver_collector_event.py now filters on.

WHAT (Iceberg semantics — why this is safe):
  • `ALTER TABLE … ADD PARTITION FIELD` is a METADATA-ONLY commit: no data files are rewritten, no
    rows move, readers are never blocked. Existing files stay under the old (unpartitioned) spec —
    they still match a full-history scan, they just don't prune. NEW writes (the Connect sink's
    ongoing commits) land day-partitioned immediately.
  • The routine bronze-maintenance compaction (rewrite_data_files) rewrites old files INTO the new
    spec over time, so pruning coverage of the history improves with every daily maintenance pass —
    no separate backfill rewrite is required (and none is performed here).
  • Bronze stays APPEND-ONLY: this job never inserts/updates/deletes a row.

SAFETY GATES:
  • DRY-RUN BY DEFAULT — prints the table's current spec, the planned DDL and the pre-stats, then
    exits. Set PARTITION_MIGRATE_EXECUTE=1 to actually apply (the prod run is an explicit,
    runbook-driven apply decision — never wired to a cron).
  • IDEMPOTENT — a kafka_timestamp partition field already present → loud no-op, exit 0.
  • PARITY CHECK — row count + kafka_timestamp null-count + min/max are captured immediately before
    and after the ALTER and MUST be identical (a metadata-only commit cannot change data; any drift
    aborts loudly with exit ≠ 0 as evidence the commit raced something unexpected).

Run (compose lane): db/iceberg/spark/run-bronze-collector-partition-migrate.sh
Prod: one-off spark-submit of this file from the brain-spark-bronze image (same env as the
bronze-maintenance CronWorkflow) — see the apply-decision note in the Wave-3 audit summary.
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer annotation eval.

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import CATALOG, build_spark  # noqa: E402
from job_log import emit_job_log  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
TABLE = os.environ.get("COLLECTOR_CONNECT_TABLE", "collector_events_connect")
FQ = f"{CATALOG}.{BRONZE_NAMESPACE}.{TABLE}"
# The partition transform column + spec. kafka_timestamp is the sink's PHYSICAL InsertField column —
# the only pushdown-capable time column on this table (everything else lives inside the payload JSON).
PARTITION_COLUMN = "kafka_timestamp"
PARTITION_DDL = f"ALTER TABLE {FQ} ADD PARTITION FIELD days({PARTITION_COLUMN})"
EXECUTE = os.environ.get("PARTITION_MIGRATE_EXECUTE", "") == "1"


def partition_fields_from_describe(rows):
    """PURE: extract the partition-field expressions from `DESCRIBE TABLE` output rows.

    Spark's Iceberg DESCRIBE emits a `# Partitioning` section whose rows are (col_name='Part N',
    data_type='<transform>'), e.g. ('Part 0', 'days(kafka_timestamp)'). Rows are (col_name,
    data_type) tuples (comment ignored). An unpartitioned table has no such section → [].
    """
    fields = []
    in_partitioning = False
    for row in rows:
        name = (row[0] or "").strip()
        if name.startswith("#"):
            in_partitioning = name.lower().startswith("# partition")
            continue
        if not name:
            continue
        if in_partitioning and name.lower().startswith("part "):
            fields.append((row[1] or "").strip())
    return fields


def has_partition_on(fields, column):
    """PURE: True iff any existing partition-field expression references `column`
    (e.g. 'days(kafka_timestamp)' / 'day(kafka_timestamp)' / a future 'hours(kafka_timestamp)')."""
    return any(column in f for f in fields)


def parity_stats(spark: SparkSession):
    """Row count + kafka_timestamp null-count + min/max — the parity fingerprint. One scan."""
    row = spark.sql(
        f"SELECT COUNT(*) AS n, "
        f"SUM(CASE WHEN {PARTITION_COLUMN} IS NULL THEN 1 ELSE 0 END) AS nulls, "
        f"CAST(MIN({PARTITION_COLUMN}) AS STRING) AS lo, "
        f"CAST(MAX({PARTITION_COLUMN}) AS STRING) AS hi "
        f"FROM {FQ}"
    ).collect()[0]
    return {"n": row["n"], "nulls": row["nulls"], "lo": row["lo"], "hi": row["hi"]}


def main() -> None:
    spark = build_spark("bronze-collector-partition-migrate")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        # Existence guard: a fresh env where the sink hasn't landed its first record yet → loud skip.
        try:
            describe_rows = [(r[0], r[1]) for r in spark.sql(f"DESCRIBE TABLE {FQ}").collect()]
        except Exception:  # noqa: BLE001
            print(f"[partition-migrate] {FQ} does not exist yet — nothing to migrate (skip)", flush=True)
            emit_job_log("bronze-collector-partition-migrate", status="ok", rows_out=0, fqtn=FQ,
                         duration_ms=int((time.monotonic() - started) * 1000))
            return

        existing = partition_fields_from_describe(describe_rows)
        print(f"[partition-migrate] {FQ} current partition fields: {existing or '(unpartitioned)'}", flush=True)
        if has_partition_on(existing, PARTITION_COLUMN):
            print(f"[partition-migrate] {PARTITION_COLUMN} partition field already present — idempotent no-op", flush=True)
            emit_job_log("bronze-collector-partition-migrate", status="ok", rows_out=0, fqtn=FQ,
                         duration_ms=int((time.monotonic() - started) * 1000))
            return

        before = parity_stats(spark)
        print(f"[partition-migrate] pre-stats: {before}", flush=True)
        print(f"[partition-migrate] planned DDL: {PARTITION_DDL}", flush=True)

        if not EXECUTE:
            print(
                "[partition-migrate] DRY RUN (default) — set PARTITION_MIGRATE_EXECUTE=1 to apply. "
                "No metadata was changed.",
                flush=True,
            )
            emit_job_log("bronze-collector-partition-migrate", status="ok", rows_out=before["n"], fqtn=FQ,
                         duration_ms=int((time.monotonic() - started) * 1000))
            return

        spark.sql(PARTITION_DDL)
        print(f"[partition-migrate] applied: {PARTITION_DDL}", flush=True)

        # ── PARITY CHECK: a metadata-only commit must not change a single row ──────────────────────
        after = parity_stats(spark)
        if after != before:
            raise RuntimeError(
                f"[partition-migrate] PARITY FAILED — pre={before} post={after}. "
                "A metadata-only ADD PARTITION FIELD cannot change data; investigate before re-running."
            )
        print(f"[partition-migrate] parity OK (post-stats identical): {after}", flush=True)

        # Evidence the spec landed (loud, greppable).
        post_fields = partition_fields_from_describe(
            [(r[0], r[1]) for r in spark.sql(f"DESCRIBE TABLE {FQ}").collect()]
        )
        if not has_partition_on(post_fields, PARTITION_COLUMN):
            raise RuntimeError(
                f"[partition-migrate] ALTER committed but DESCRIBE shows no {PARTITION_COLUMN} "
                f"partition field (fields={post_fields})"
            )
        print(f"[partition-migrate] DONE — {FQ} partition fields now: {post_fields}", flush=True)
        emit_job_log("bronze-collector-partition-migrate", status="ok", rows_out=after["n"], fqtn=FQ,
                     duration_ms=int((time.monotonic() - started) * 1000))
    except Exception as exc:  # noqa: BLE001
        emit_job_log("bronze-collector-partition-migrate", status="fail", fqtn=FQ,
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
