"""
bronze_raw_retention.py (PyIceberg + DuckDB) — ADR-0006 D4 short-retention + snapshot expiry for the
RAW Bronze tables, ported 1:1 from db/iceberg/trino/bronze_raw_retention.py to the PyIceberg
maintenance seam (_maintenance_base.py).

Under ADR-0006 the Kafka Connect Iceberg sink writes TRULY RAW provider payloads to Bronze, and the
R2/R3 consent+tenant gate moved to Silver. Consequence (D4): non-consented PII (and, for the
razorpay lane, PCI card.* fields) transiently land UN-hashed in the raw Bronze tables. Silver
(gated/normalized/hashed) is the durable layer; the raw tables are a SHORT-LIVED landing buffer.

For every raw Bronze table — the *_raw_connect lanes the ADR-0010 Kafka Connect Iceberg sink writes:
  1. DELETE rows whose ingest time is older than RAW_RETENTION_HOURS (default 168h = 7 days) —
     snapshot expiry alone never removes rows from CURRENT table state. Two delete lanes:
       • timestamp-typed ingest column → pyiceberg COW delete (LessThan cutoff) — rewrites the
         affected data files in the same commit, rows leave the live files immediately;
       • STRING-typed ingest column (the Connect envelope `fetched_at`) → the CAST predicate is not
         expressible as an Iceberg expression, so this lane stays on DuckDB DELETE (merge-on-read),
  2. optimize (compaction, FORCED after a merge-on-read delete) — COW-rewrite the table so the
     MoR-deleted rows physically leave the live data files (not just masked by delete files;
     already-referenced positional-delete FILES stay in metadata — probe gate 7 — but they carry
     only (file_path, pos), no row bytes),
  3. expire_snapshots older than the same window (+ the mandatory physical sweep) — so the deleted
     rows are not recoverable via time-travel and the superseded files are freed from S3.
So raw PII does not persist beyond the buffer window. Idempotent; run on a cron (Argo) in prod.

RETENTION WINDOW reproduced EXACTLY from the Spark/Trino jobs:
  RAW_RETENTION_HOURS = 168 (7 days). Row predicate + snapshot expiry BOTH use this same window.

DELETE PREDICATE reproduced EXACTLY:
  <ingest_col> < <now − RAW_RETENTION_HOURS hours>
  where ingest_col is the first present of (written_at, kafka_timestamp, fetched_at, received_at),
  STRING-typed columns (Connect envelope `fetched_at`) get a CAST — unparseable → NULL → row kept
  (the safe direction). A table with NONE of these columns is loudly skipped (WARN).

collector_events_connect is DELIBERATELY NOT here — it is the system-of-record event stream ("no
event loss") and its per-subject RTBF path is erasure_raw_delete.py (payload-path predicate erasure).

RTBF: this is the retention (temporal) half. The subject-based erasure half is erasure_raw_delete.py.

Run: python bronze_raw_retention.py  (env: RAW_RETENTION_HOURS, RAW_ROW_TTL, plus the
ICEBERG_REST_*/S3/AWS connection seams in _maintenance_base.py).
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import _maintenance_base as mb  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", mb.BRONZE_NAMESPACE)
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


def _ttl_column(cat, table: str) -> "tuple[str, bool] | None":
    """The first _TTL_COLUMNS member present in the table's Iceberg schema, as (column_name,
    is_timestamp_typed). Timestamp-typed columns take the pyiceberg COW-delete lane; string-typed
    columns need a CAST (unexpressible as an Iceberg predicate) and stay on the DuckDB DELETE lane
    — unparseable values cast to NULL, and NULL < cutoff is false, so a malformed stamp keeps the
    row (the safe direction)."""
    types = mb.column_types(cat, BRONZE_NAMESPACE, table)
    for c in _TTL_COLUMNS:
        if c in types:
            return c, types[c].startswith("timestamp")
    return None


def _delete_expired_rows(cat, namespace: str, table: str) -> int:
    """Row-level D4 TTL: hard-DELETE rows older than the retention window. Returns the number of
    merge-on-read (DuckDB-lane) deletes issued with >0 rows, so the caller knows a forced
    compaction is needed to get the rows out of the live data files."""
    from pyiceberg.expressions import LessThan

    fq = mb.fqtn(namespace, table)
    found = _ttl_column(cat, table)
    if found is None:
        print(
            f"[bronze-raw-retention] WARN {fq}: no ingest-time column ({'/'.join(_TTL_COLUMNS)}) — row TTL skipped",
            flush=True,
        )
        return 0
    col, is_timestamp = found
    cutoff = mb.hours_to_cutoff(RAW_RETENTION_HOURS)
    con = mb.duckdb_connect()

    if is_timestamp:
        # Compliance evidence (daily job; tables are small), then pyiceberg COW delete: the
        # affected data files are rewritten in the same commit — rows leave the live files now.
        predicate = f"{col} < TIMESTAMPTZ '{cutoff.isoformat()}'"
        expired = con.execute(f"SELECT count(*) FROM {fq} WHERE {predicate}").fetchone()[0]
        mb.delete(cat, namespace, table, LessThan(col, cutoff.isoformat()))
        print(f"[bronze-raw-retention] row TTL (COW) on {fq}: deleted {expired} row(s) WHERE {predicate}", flush=True)
        return 0
    # String-typed ingest clock (Connect envelope `fetched_at`): CAST lane stays on DuckDB DELETE
    # (Iceberg v2 merge-on-read) — the caller force-compacts when this deleted anything. TRY_CAST,
    # not CAST: DuckDB's CAST raises on an unparseable stamp; TRY_CAST → NULL → row kept.
    predicate = f"TRY_CAST({col} AS TIMESTAMP) < TIMESTAMP '{cutoff.strftime('%Y-%m-%d %H:%M:%S')}'"
    expired = con.execute(f"SELECT count(*) FROM {fq} WHERE {predicate}").fetchone()[0]
    con.execute(f"DELETE FROM {fq} WHERE {predicate}")
    print(f"[bronze-raw-retention] row TTL (MoR) on {fq}: deleted {expired} row(s) WHERE {predicate}", flush=True)
    return expired


def main() -> None:
    cat = mb.pyiceberg_catalog()
    ttl_ms = RAW_RETENTION_HOURS * 3_600_000  # snapshot-expiry window == row-TTL window
    for t in RAW_TABLES:
        if not mb.table_exists(cat, BRONZE_NAMESPACE, t):
            continue
        fq = mb.fqtn(BRONZE_NAMESPACE, t)
        # 1. Row-level TTL DELETE (D4 proper): remove expired raw rows from CURRENT table state.
        mor_deleted = 0
        if RAW_ROW_TTL:
            try:
                mor_deleted = _delete_expired_rows(cat, BRONZE_NAMESPACE, t)
            except Exception as exc:  # noqa: BLE001 — never let one table abort the sweep
                print(f"[bronze-raw-retention] WARN {fq} row TTL: {exc}", flush=True)
        # 2. Compaction: FORCED after a merge-on-read delete so the deleted rows physically leave
        # the live data files (the COW lane already rewrote its files in the delete commit);
        # otherwise the skip heuristic makes this a cheap no-op on compacted tables.
        try:
            mb.optimize(cat, BRONZE_NAMESPACE, t, force=mor_deleted > 0)
        except Exception as exc:  # noqa: BLE001
            print(f"[bronze-raw-retention] WARN {fq} optimize: {exc}", flush=True)
        # 3. Expire snapshots older than the retention window + physical sweep (frees the underlying
        # data files → raw PII is not recoverable via time-travel beyond the window, incl. the rows
        # step 1 deleted).
        try:
            mb.expire(cat, BRONZE_NAMESPACE, t, ttl_ms)
            print(f"[bronze-raw-retention] expired snapshots > {RAW_RETENTION_HOURS}h on {fq}", flush=True)
        except Exception as exc:  # noqa: BLE001 — never let one table abort the sweep
            print(f"[bronze-raw-retention] WARN {fq}: {exc}", flush=True)


if __name__ == "__main__":
    main()
