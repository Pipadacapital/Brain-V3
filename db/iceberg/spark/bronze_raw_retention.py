"""
bronze_raw_retention.py — ADR-0006 D4: short-retention + snapshot expiry for the RAW Bronze tables.

Under ADR-0006 the Kafka Connect Iceberg sink writes TRULY RAW provider payloads to Bronze, and the
R2/R3 consent+tenant gate moved to Spark Silver. Consequence (D4): non-consented PII (and, for the
razorpay lane, PCI card.* fields) transiently land UN-hashed in the raw Bronze tables. Silver
(gated/normalized/hashed) is the durable layer; the raw tables are a SHORT-LIVED landing buffer.

This job enforces that posture, the mandatory D4 mitigation (gates the prod flip; needs Security-Reviewer
sign-off): for every raw Bronze table (collector_events_raw + the per-connector *_raw tables + the
UNIFIED brain_bronze.events raw connector lanes bronze_landing.py now lands) it
  1. DELETEs rows whose ingest time (written_at) is older than RAW_RETENTION_HOURS (default 168h = 7
     days) — snapshot expiry alone never removes rows from CURRENT table state, and
  2. expires Iceberg snapshots older than the same window (so the deleted rows are not recoverable
     via time-travel and the superseded files are freed),
so raw PII does not persist beyond the buffer window. Idempotent; run on a cron (Argo) in prod and on
the daily guard-file cadence inside tools/dev/v4-refresh-loop.sh locally (AUD-PERF-003).

On the unified events table the row TTL applies ONLY to the raw connector lanes (connector <>
'collector'): the collector lane is the system-of-record event stream ("Bronze is source of truth /
no event loss"); its consent gate + quarantine live in Silver (silver_collector_event /
silver_consent_rejected).

RTBF: this is the retention half. The erasure half (a subject's right-to-be-forgotten DELETE across the
raw tables) is handled by the existing erase tooling extended to the raw namespace — see the cutover
runbook (docs/runbooks/adr-0006-cutover-and-prod.md).
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import CATALOG, build_spark  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_RETENTION_HOURS = int(os.environ.get("RAW_RETENTION_HOURS", "168"))  # 7 days; tighten per region/regime
# Row-level TTL DELETE (the D4 mitigation proper). Default ON: without it raw un-hashed PII persists in
# current table state indefinitely. RAW_ROW_TTL=0 falls back to snapshot-expiry-only (e.g. while a lane's
# Silver admission is still baking — per ADR-0006 the gated Silver is the durable layer, so a lane must
# be admitted into Silver before its raw rows may age out).
RAW_ROW_TTL = os.environ.get("RAW_ROW_TTL", "1") == "1"

# Every RAW Bronze table the Kafka Connect Iceberg sink writes (ADR-0006). Add a lane here when its
# Connect connector ships. These hold raw provider payloads incl. transient un-hashed PII / PCI.
RAW_TABLES = [
    "collector_events_raw",
    "shopify_orders_raw",
    "woocommerce_orders_raw",
    "meta_spend_raw",
    "google_spend_raw",
    "ga4_rows_raw",
    "shiprocket_shipments_raw",
    "gokwik_events_raw",
    "shopflo_checkout_raw",
    "razorpay_settlement_raw",
]

# UNIFIED-BRONZE (AUD-PERF-003): bronze_landing.py lands the nine connector raw lanes into ONE table
# brain_bronze.events with a `connector` discriminator. Its row TTL is restricted to the raw connector
# lanes — the collector lane (connector='collector') is the durable event stream and is NEVER deleted.
UNIFIED_EVENTS_TABLE = os.environ.get("BRONZE_EVENTS_TABLE", "events")
UNIFIED_EVENTS_ROW_PREDICATE = "connector <> 'collector'"

# Candidate ingest-time columns for the row-TTL cutoff, in preference order. Every legacy *_raw table
# and the unified events table carry written_at NOT NULL (bronze_raw_landing.py / bronze_landing.py);
# the fallbacks are defensive for any older table shape.
_TTL_COLUMNS = ("written_at", "kafka_timestamp", "received_at")


def _exists(spark: SparkSession, table: str) -> bool:
    try:
        spark.sql(f"DESCRIBE TABLE {CATALOG}.{BRONZE_NAMESPACE}.{table}")
        return True
    except Exception:  # noqa: BLE001
        return False


def _ttl_column(spark: SparkSession, fq: str) -> "str | None":
    cols = {f.name for f in spark.table(fq).schema.fields}
    for c in _TTL_COLUMNS:
        if c in cols:
            return c
    return None


def _delete_expired_rows(spark: SparkSession, fq: str, extra_predicate: str = "") -> None:
    """Row-level D4 TTL: hard-DELETE rows older than the retention window (Iceberg v2 delete)."""
    col = _ttl_column(spark, fq)
    if col is None:
        print(
            f"[bronze-raw-retention] WARN {fq}: no ingest-time column ({'/'.join(_TTL_COLUMNS)}) — row TTL skipped",
            flush=True,
        )
        return
    predicate = f"{col} < TIMESTAMPADD(HOUR, -{RAW_RETENTION_HOURS}, current_timestamp())"
    if extra_predicate:
        predicate = f"{extra_predicate} AND {predicate}"
    expired = spark.table(fq).where(predicate).count()  # compliance evidence (daily job; tables are small)
    spark.sql(f"DELETE FROM {fq} WHERE {predicate}")
    print(f"[bronze-raw-retention] row TTL on {fq}: deleted {expired} row(s) WHERE {predicate}", flush=True)


def main() -> None:
    spark = build_spark("bronze-raw-retention")
    spark.sparkContext.setLogLevel("WARN")
    # (table, extra row-TTL predicate) — the unified events table restricts the TTL to raw connector lanes.
    targets = [(t, "") for t in RAW_TABLES] + [(UNIFIED_EVENTS_TABLE, UNIFIED_EVENTS_ROW_PREDICATE)]
    for t, extra in targets:
        fq = f"{CATALOG}.{BRONZE_NAMESPACE}.{t}"
        if not _exists(spark, t):
            continue
        # 1. Row-level TTL DELETE (D4 proper): remove expired raw rows from CURRENT table state.
        if RAW_ROW_TTL:
            try:
                _delete_expired_rows(spark, fq, extra)
            except Exception as exc:  # noqa: BLE001 — never let one table abort the sweep
                print(f"[bronze-raw-retention] WARN {fq} row TTL: {exc}", flush=True)
        # 2. Expire snapshots older than the retention window (frees the underlying data files → raw PII is
        # not recoverable via time-travel beyond the window, including the rows step 1 just deleted).
        # The CALL parser wants a TIMESTAMP literal (not a function expression) — compute the cutoff here.
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=RAW_RETENTION_HOURS)).strftime("%Y-%m-%d %H:%M:%S")
        try:
            spark.sql(
                f"CALL {CATALOG}.system.expire_snapshots("
                f"table => '{BRONZE_NAMESPACE}.{t}', "
                f"older_than => TIMESTAMP '{cutoff}', "
                f"retain_last => 1)"
            )
            print(f"[bronze-raw-retention] expired snapshots > {RAW_RETENTION_HOURS}h on {fq}", flush=True)
        except Exception as exc:  # noqa: BLE001 — never let one table abort the sweep
            print(f"[bronze-raw-retention] WARN {fq}: {exc}", flush=True)


if __name__ == "__main__":
    main()
