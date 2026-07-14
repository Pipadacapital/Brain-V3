"""
bronze_raw_retention.py (Trino) — ADR-0006 D4 short-retention + snapshot expiry for the RAW Bronze
tables, ported from db/iceberg/spark/bronze_raw_retention.py to the Trino ⇄ Iceberg seam (trino_base.py).

Under ADR-0006 the Kafka Connect Iceberg sink writes TRULY RAW provider payloads to Bronze, and the
R2/R3 consent+tenant gate moved to Spark Silver. Consequence (D4): non-consented PII (and, for the
razorpay lane, PCI card.* fields) transiently land UN-hashed in the raw Bronze tables. Silver
(gated/normalized/hashed) is the durable layer; the raw tables are a SHORT-LIVED landing buffer.

For every raw Bronze table — the *_raw_connect lanes the ADR-0010 Kafka Connect Iceberg sink writes:
  1. DELETE rows whose ingest time is older than RAW_RETENTION_HOURS (default 168h = 7 days) —
     snapshot expiry alone never removes rows from CURRENT table state, then
  2. optimize (compaction) — rewrite the affected partitions so the deleted rows leave the live data
     files (the Trino analogue of Spark rewrite_data_files; the Spark job relied on expire alone to
     free files, but under Trino merge-on-read we compact first so the delete files are materialised),
  3. expire_snapshots older than the same window — so the deleted rows are not recoverable via
     time-travel and the superseded files are freed.
So raw PII does not persist beyond the buffer window. Idempotent; run on a cron (Argo) in prod.

RETENTION WINDOW reproduced EXACTLY from the Spark job:
  RAW_RETENTION_HOURS = 168 (7 days). Row predicate + snapshot expiry BOTH use this same window.

DELETE PREDICATE reproduced EXACTLY:
  <ingest_col> < <now − RAW_RETENTION_HOURS hours>
  where ingest_col is the first present of (written_at, kafka_timestamp, fetched_at, received_at),
  STRING-typed columns (Connect envelope `fetched_at`) get a CAST — unparseable → NULL → row kept
  (the safe direction). A table with NONE of these columns is loudly skipped (WARN).

collector_events_connect is DELIBERATELY NOT here — it is the system-of-record event stream ("no
event loss") and its per-subject RTBF path is erasure_raw_delete.py (payload-path predicate erasure).

RTBF: this is the retention (temporal) half. The subject-based erasure half is erasure_raw_delete.py.

Run: python bronze_raw_retention.py  (env: RAW_RETENTION_HOURS, RAW_ROW_TTL, plus the TRINO_* seams).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import trino_base as tb  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", tb.BRONZE_NAMESPACE)
RAW_RETENTION_HOURS = int(os.environ.get("RAW_RETENTION_HOURS", "168"))  # 7 days; tighten per region/regime
# Row-level TTL DELETE (the D4 mitigation proper). Default ON: without it raw un-hashed PII persists in
# current table state indefinitely. RAW_ROW_TTL=0 falls back to snapshot-expiry-only.
RAW_ROW_TTL = os.environ.get("RAW_ROW_TTL", "1") == "1"

# Every RAW Bronze table — the *_raw_connect lanes the ADR-0010 Kafka Connect Iceberg sink writes.
# Each is auto-created on the lane's FIRST record, so a not-yet-existing table is skipped by the
# _exists guard and joins the sweep once its first record lands. collector_events_connect is NOT here
# (system-of-record; its RTBF path is erasure_raw_delete.py).
RAW_TABLES = [
    "shopify_orders_raw_connect",
    "woocommerce_orders_raw_connect",
    "meta_spend_raw_connect",
    "google_spend_raw_connect",
    "ga4_rows_raw_connect",
    "shiprocket_shipments_raw_connect",
    "gokwik_events_raw_connect",
    "shopflo_checkout_raw_connect",
    "razorpay_settlement_raw_connect",
]

# Candidate ingest-time columns for the row-TTL cutoff, in preference order. The Connect-written
# *_raw_connect tables carry NO written_at / kafka_timestamp — their ingest clock is the raw
# envelope's `fetched_at` (a STRING; CAST → unparseable → NULL → row kept, the safe direction).
_TTL_COLUMNS = ("written_at", "kafka_timestamp", "fetched_at", "received_at")


def _ttl_column(cur, table: str) -> "str | None":
    """The first _TTL_COLUMNS member present, as a timestamp-typed SQL expression. String-typed
    columns get an explicit CAST — unparseable values cast to NULL, and NULL < cutoff is false, so a
    malformed stamp keeps the row (the safe direction)."""
    cur.execute(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_schema = ? AND table_name = ?",
        (BRONZE_NAMESPACE, table),
    )
    types = {r[0]: (r[1] or "").lower() for r in cur.fetchall()}
    for c in _TTL_COLUMNS:
        if c in types:
            return c if types[c].startswith("timestamp") else f"CAST({c} AS TIMESTAMP)"
    return None


def _cutoff_expr() -> str:
    """Trino cutoff expression: now − RAW_RETENTION_HOURS. Same window as the Spark
    TIMESTAMPADD(HOUR, -N, current_timestamp()), expressed as Trino date_add."""
    return f"date_add('hour', -{RAW_RETENTION_HOURS}, current_timestamp)"


def _delete_expired_rows(cur, namespace: str, table: str, extra_predicate: str = "") -> None:
    """Row-level D4 TTL: hard-DELETE rows older than the retention window (Iceberg v2 delete)."""
    fq = tb.fqtn(namespace, table)
    col = _ttl_column(cur, table)
    if col is None:
        print(
            f"[bronze-raw-retention] WARN {fq}: no ingest-time column ({'/'.join(_TTL_COLUMNS)}) — row TTL skipped",
            flush=True,
        )
        return
    predicate = f"{col} < {_cutoff_expr()}"
    if extra_predicate:
        predicate = f"{extra_predicate} AND {predicate}"
    # Compliance evidence (daily job; tables are small).
    cur.execute(f"SELECT count(*) FROM {fq} WHERE {predicate}")
    expired = cur.fetchone()[0]
    cur.execute(f"DELETE FROM {fq} WHERE {predicate}")
    cur.fetchall()
    print(f"[bronze-raw-retention] row TTL on {fq}: deleted {expired} row(s) WHERE {predicate}", flush=True)


def main() -> None:
    conn = tb.connect()
    cur = conn.cursor()
    retention = tb.hours_to_duration(RAW_RETENTION_HOURS)  # snapshot-expiry window == row-TTL window
    # (table, extra row-TTL predicate) — no per-table restrictions since the legacy unified events
    # table was dropped with the legacy generation.
    targets = [(t, "") for t in RAW_TABLES]
    for t, extra in targets:
        if not tb.table_exists(cur, BRONZE_NAMESPACE, t):
            continue
        fq = tb.fqtn(BRONZE_NAMESPACE, t)
        # 1. Row-level TTL DELETE (D4 proper): remove expired raw rows from CURRENT table state.
        if RAW_ROW_TTL:
            try:
                _delete_expired_rows(cur, BRONZE_NAMESPACE, t, extra)
            except Exception as exc:  # noqa: BLE001 — never let one table abort the sweep
                print(f"[bronze-raw-retention] WARN {fq} row TTL: {exc}", flush=True)
        # 2. Compaction: materialise the merge-on-read delete files into rewritten data files so the
        # deleted rows physically leave the live data files.
        try:
            tb.optimize(cur, BRONZE_NAMESPACE, t)
        except Exception as exc:  # noqa: BLE001
            print(f"[bronze-raw-retention] WARN {fq} optimize: {exc}", flush=True)
        # 3. Expire snapshots older than the retention window (frees the underlying data files → raw
        # PII is not recoverable via time-travel beyond the window, incl. the rows step 1 deleted).
        try:
            tb.expire(cur, BRONZE_NAMESPACE, t, retention)
            print(f"[bronze-raw-retention] expired snapshots > {RAW_RETENTION_HOURS}h on {fq}", flush=True)
        except Exception as exc:  # noqa: BLE001 — never let one table abort the sweep
            print(f"[bronze-raw-retention] WARN {fq}: {exc}", flush=True)


if __name__ == "__main__":
    main()
