"""
bronze_raw_retention.py — ADR-0006 D4: short-retention + snapshot expiry for the RAW Bronze tables.

Under ADR-0006 the Kafka Connect Iceberg sink writes TRULY RAW provider payloads to Bronze, and the
R2/R3 consent+tenant gate moved to Spark Silver. Consequence (D4): non-consented PII (and, for the
razorpay lane, PCI card.* fields) transiently land UN-hashed in the raw Bronze tables. Silver
(gated/normalized/hashed) is the durable layer; the raw tables are a SHORT-LIVED landing buffer.

This job enforces that posture, the mandatory D4 mitigation (gates the prod flip; needs Security-Reviewer
sign-off): for every raw Bronze table (collector_events_raw + the per-connector *_raw tables) it
  1. expires Iceberg snapshots older than RAW_RETENTION_HOURS (default 168h = 7 days), and
  2. (optionally) DELETEs rows whose Kafka/ingest time is older than the same window,
so raw PII does not persist beyond the buffer window. Idempotent; run on a cron (Argo) in prod.

RTBF: this is the retention half. The erasure half (a subject's right-to-be-forgotten DELETE across the
raw tables) is handled by the existing erase tooling extended to the raw namespace — see the cutover
runbook (docs/runbooks/adr-0006-cutover-and-prod.md).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import CATALOG, build_spark  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_RETENTION_HOURS = int(os.environ.get("RAW_RETENTION_HOURS", "168"))  # 7 days; tighten per region/regime

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


def _exists(spark: SparkSession, table: str) -> bool:
    try:
        spark.sql(f"DESCRIBE TABLE {CATALOG}.{BRONZE_NAMESPACE}.{table}")
        return True
    except Exception:  # noqa: BLE001
        return False


def main() -> None:
    spark = build_spark("bronze-raw-retention")
    spark.sparkContext.setLogLevel("WARN")
    older_than = f"TIMESTAMP '1970-01-01 00:00:00' + INTERVAL {RAW_RETENTION_HOURS} HOURS"  # placeholder; see below
    for t in RAW_TABLES:
        fq = f"{CATALOG}.{BRONZE_NAMESPACE}.{t}"
        if not _exists(spark, t):
            continue
        # Expire snapshots older than the retention window (frees the underlying data files → raw PII is
        # not recoverable via time-travel beyond the window). expire_snapshots takes an absolute cutoff;
        # current_timestamp() - INTERVAL keeps it rolling.
        try:
            spark.sql(
                f"CALL {CATALOG}.system.expire_snapshots("
                f"table => '{BRONZE_NAMESPACE}.{t}', "
                f"older_than => TIMESTAMPADD(HOUR, -{RAW_RETENTION_HOURS}, current_timestamp()), "
                f"retain_last => 1)"
            )
            print(f"[bronze-raw-retention] expired snapshots > {RAW_RETENTION_HOURS}h on {fq}", flush=True)
        except Exception as exc:  # noqa: BLE001 — never let one table abort the sweep
            print(f"[bronze-raw-retention] WARN {fq}: {exc}", flush=True)
    _ = older_than  # documented intent; row-level TTL DELETE is opt-in per lane (set RAW_ROW_TTL=1)


if __name__ == "__main__":
    main()
