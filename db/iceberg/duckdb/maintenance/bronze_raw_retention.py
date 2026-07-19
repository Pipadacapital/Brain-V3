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

COLLECTOR LANE (ADR-0015 D7 — amends the old "never deleted" posture): collector_events_connect is
now a 15-DAY REPLAY BUFFER, not an indefinite system-of-record — Silver is the durable layer. It is
swept here on ITS OWN window, COLLECTOR_RETENTION_HOURS (default 360h = 15 days), separate from the
RAW_RETENTION_HOURS raw lanes. Its 14-day durable time-travel window (DURABLE_SNAPSHOT_TTL_MS,
AUD-OPS-015 — same env/default as bronze_maintenance.py) stays NESTED inside the row TTL: the
collector lane's snapshot expiry uses max(row-TTL window, DURABLE_SNAPSHOT_TTL_MS), so snapshots
younger than the durable window are never expired even if the row TTL is tightened below 14d.

RTBF: this is the retention (temporal) half. The subject-based erasure half is erasure_raw_delete.py
(payload-path predicate erasure — still the collector lane's per-subject path).

Run: python bronze_raw_retention.py  (env: RAW_RETENTION_HOURS, COLLECTOR_RETENTION_HOURS,
DURABLE_SNAPSHOT_TTL_MS, RAW_ROW_TTL, plus the ICEBERG_REST_*/S3/AWS connection seams in
_maintenance_base.py).
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
# ADR-0015 D7: the collector lane is a 15-day replay buffer (Silver is the durable layer) — its own
# row-TTL window, independent of the (shorter, privacy-contract) RAW_RETENTION_HOURS raw lanes.
COLLECTOR_RETENTION_HOURS = int(os.environ.get("COLLECTOR_RETENTION_HOURS", "360"))  # 15 days
# AUD-OPS-015 durable time-travel window for the collector lane — same env/default as
# bronze_maintenance.py so the two jobs can never disagree about the rollback window.
DURABLE_SNAPSHOT_TTL_MS = int(os.environ.get("DURABLE_SNAPSHOT_TTL_MS", str(1_209_600_000)))  # 14 days
COLLECTOR_TABLE = "collector_events_connect"

# The 9 `*_raw_connect` raw lanes were RETIRED by ADR-0016 (2026-07-18) — sinks/topics removed, tables
# never populated — so the raw half of this sweep is empty (DR-001 hygiene). The constant stays so the
# sweep structure (and any future ADR-sanctioned raw lane) needs no rework. collector_events_connect is
# NOT in this list — it is swept on its OWN COLLECTOR_RETENTION_HOURS window (see _lanes(); ADR-0015 D7).
RAW_TABLES: "list[str]" = []

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


def collector_expire_ttl_ms(retention_hours: int, durable_ttl_ms: int) -> int:
    """Snapshot-expiry window (ms) for the collector lane: the row-TTL window with the AUD-OPS-015
    durable time-travel window NESTED inside — never smaller than durable_ttl_ms, so tightening
    COLLECTOR_RETENTION_HOURS below 14d can never shrink the rollback window. At the defaults
    (360h row TTL ⊃ 14d durable) the row-TTL window simply wins (15d)."""
    return max(retention_hours * 3_600_000, durable_ttl_ms)


def _delete_expired_rows(cat, namespace: str, table: str, retention_hours: int) -> int:
    """Row-level TTL: hard-DELETE rows older than `retention_hours`. Returns the number of
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
    cutoff = mb.hours_to_cutoff(retention_hours)
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


def _lanes() -> "list[tuple[str, int, int]]":
    """The (table, row_ttl_hours, snapshot_expiry_ttl_ms) sweep plan. Raw lanes expire snapshots on
    the SAME window as their row TTL (D4: raw PII must leave time-travel with the rows); the
    collector lane rides its own 15-day replay-buffer window (ADR-0015 D7) with the 14-day durable
    time-travel window nested inside (collector_expire_ttl_ms — never expire younger than durable)."""
    raw_ttl_ms = RAW_RETENTION_HOURS * 3_600_000  # snapshot-expiry window == row-TTL window
    plan = [(t, RAW_RETENTION_HOURS, raw_ttl_ms) for t in RAW_TABLES]
    plan.append(
        (
            COLLECTOR_TABLE,
            COLLECTOR_RETENTION_HOURS,
            collector_expire_ttl_ms(COLLECTOR_RETENTION_HOURS, DURABLE_SNAPSHOT_TTL_MS),
        )
    )
    return plan


def main() -> None:
    cat = mb.pyiceberg_catalog()
    for t, retention_hours, ttl_ms in _lanes():
        if not mb.table_exists(cat, BRONZE_NAMESPACE, t):
            continue
        fq = mb.fqtn(BRONZE_NAMESPACE, t)
        # 1. Row-level TTL DELETE (D4 raw lanes; ADR-0015 D7 collector replay buffer): remove
        # expired rows from CURRENT table state.
        mor_deleted = 0
        if RAW_ROW_TTL:
            try:
                mor_deleted = _delete_expired_rows(cat, BRONZE_NAMESPACE, t, retention_hours)
            except Exception as exc:  # noqa: BLE001 — never let one table abort the sweep
                print(f"[bronze-raw-retention] WARN {fq} row TTL: {exc}", flush=True)
        # 2. Compaction: FORCED after a merge-on-read delete so the deleted rows physically leave
        # the live data files (the COW lane already rewrote its files in the delete commit);
        # otherwise the skip heuristic makes this a cheap no-op on compacted tables.
        try:
            mb.optimize(cat, BRONZE_NAMESPACE, t, force=mor_deleted > 0)
        except Exception as exc:  # noqa: BLE001
            print(f"[bronze-raw-retention] WARN {fq} optimize: {exc}", flush=True)
        # 3. Expire snapshots older than the lane's expiry window + physical sweep (frees the
        # underlying data files → expired rows are not recoverable via time-travel beyond the
        # window, incl. the rows step 1 deleted). For the collector lane ttl_ms is already clamped
        # to >= DURABLE_SNAPSHOT_TTL_MS, so the 14d rollback window is never shrunk.
        try:
            mb.expire(cat, BRONZE_NAMESPACE, t, ttl_ms)
            print(f"[bronze-raw-retention] expired snapshots > {ttl_ms}ms on {fq}", flush=True)
        except Exception as exc:  # noqa: BLE001 — never let one table abort the sweep
            print(f"[bronze-raw-retention] WARN {fq}: {exc}", flush=True)


if __name__ == "__main__":
    main()
