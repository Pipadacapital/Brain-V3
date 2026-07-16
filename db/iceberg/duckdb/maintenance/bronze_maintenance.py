"""
bronze_maintenance.py (PyIceberg + DuckDB) — Iceberg Bronze maintenance, ported 1:1 from
db/iceberg/trino/bronze_maintenance.py to the PyIceberg maintenance seam (_maintenance_base.py).

WHY PYICEBERG (ADR-0014): Trino is removed from the platform. The Trino `ALTER TABLE … EXECUTE
optimize / expire_snapshots` procedures reproduce as PyIceberg COW rewrites + expire_snapshots
(with the mandatory physical file sweep) against the SAME REST catalog + MinIO/S3 — the identical
catalog every DuckDB transform job and the Kafka Connect sink write through.

Under ADR-0010 the Bronze writer is the Kafka Connect Iceberg sink: the collector lane lands in
brain_bronze.collector_events_connect and each of the 9 connector raw lanes lands in its own
brain_bronze.<lane>_raw_connect table (auto-created on the lane's FIRST record). In "maintain"
mode this job sweeps EVERY table in the Bronze namespace (list_tables) — so a *_raw_connect table
created after this job last shipped is covered automatically — unless BRONZE_TABLE pins a single
table for a one-off run.

Two modes (MODE env — contract UNCHANGED from the Trino job):

  "maintain" (default) — the periodic housekeeping (Argo CronWorkflow):
    1. optimize (compaction)  — coalesce the many small parquet files the Connect sink commits per
       flush interval into target-sized files (read performance + S3 cost). COW partition rewrite,
       skip-heuristic no-op on already-compacted tables (_maintenance_base.optimize).
    2. expire_snapshots       — drop snapshots older than the retention window and physically
       delete the data/manifest files only they referenced (the rolling retention guarantee;
       pyiceberg expire is metadata-only, so the sweep half is mandatory — probe gate 4).

  "erase" (ERASE_BRAND_ID set) — RIGHT-TO-ERASURE / crypto-shred companion (D13, I-S05). Targets the
    ONE table BRONZE_TABLE selects (default: `collector_events_connect`, the live Bronze SoR). After
    a brand's per-brand DEK is destroyed, this PHYSICALLY removes that brand's rows from the open
    Bronze Parquet:
      1. COW DELETE WHERE brand_id = <erased> — pyiceberg table.delete REWRITES the affected data
         files in the same commit (no merge-on-read delete files — probe gate 3), so no separate
         compaction pass is needed to get the rows out of the live files.
      2. optimize (compaction) — perf backstop over the rewritten layout (skip-heuristic no-op
         when the COW delete left it compacted).
      3. expire_snapshots (0ms) — expire the pre-deletion snapshots + sweep so the OLD files are
         deleted from S3 — without this, time-travel could still read the erased data.

RETENTION WINDOWS reproduced EXACTLY from the Spark/Trino jobs (ms → absolute UTC cutoff):
  SNAPSHOT_TTL_MS         = 604_800_000  (7 days)   — the raw / default lane window.
  DURABLE_SNAPSHOT_TTL_MS = 1_209_600_000 (14 days) — the durable collector lane (AUD-OPS-015) keeps a
                            longer time-travel window (collector_events_connect never row-deletes).
  Erase-mode expire uses ttl_ms=0 → cutoff=now (immediate purge of pre-deletion snapshots).

Run: python bronze_maintenance.py  (env: MODE, BRONZE_TABLE, SNAPSHOT_TTL_MS, DURABLE_SNAPSHOT_TTL_MS,
DURABLE_TABLES, ERASE_BRAND_ID, plus the ICEBERG_REST_*/S3/AWS connection seams in _maintenance_base.py).
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import _maintenance_base as mb  # noqa: E402

NAMESPACE = os.environ.get("BRONZE_NAMESPACE", mb.BRONZE_NAMESPACE)

_TABLE_NAME = os.environ.get("BRONZE_TABLE", "collector_events_connect")
MODE = os.environ.get("MODE", "maintain")

# SNAPSHOT TTL ≠ DATA RETENTION (AUD-PERF-013). expire_snapshots only drops HISTORY — superseded files
# + snapshot metadata; it NEVER deletes rows from current table state. Snapshots need only a short,
# bounded time-travel window; DATA retention is a row/partition DELETE concern (bronze_raw_retention.py).
SNAPSHOT_TTL_MS = int(os.environ.get("SNAPSHOT_TTL_MS", str(604_800_000)))  # 7 days
# AUD-OPS-015: the DURABLE collector lane keeps a LONGER (14d) Iceberg time-travel window than the
# default 7d so a bad downstream job / erroneous delete discovered late can still be rolled back.
DURABLE_SNAPSHOT_TTL_MS = int(os.environ.get("DURABLE_SNAPSHOT_TTL_MS", str(1_209_600_000)))  # 14 days
DURABLE_TABLES = {
    t.strip()
    for t in os.environ.get("DURABLE_TABLES", "collector_events_connect").split(",")
    if t.strip()
}


def _maintenance_tables(cat) -> "list[str]":
    """The tables this run maintains. BRONZE_TABLE pins ONE (one-off / erase target); otherwise scan
    the namespace so every Connect-written table (collector_events_connect + the auto-created
    *_raw_connect lanes) is covered without enumeration — same auto-discovery the Trino job had."""
    if os.environ.get("BRONZE_TABLE"):
        return [_TABLE_NAME]
    return mb.tables_in(cat, NAMESPACE)


def maintain(cat) -> None:
    tables = _maintenance_tables(cat)
    print(f"[maintenance] sweeping {len(tables)} table(s) in {NAMESPACE}: {tables}", flush=True)
    failures = []
    for t in tables:
        # AUD-OPS-015: durable (never-row-deleted) tables get the longer time-travel window.
        ttl_ms = DURABLE_SNAPSHOT_TTL_MS if t in DURABLE_TABLES else SNAPSHOT_TTL_MS
        try:
            mb.optimize(cat, NAMESPACE, t)                       # compaction (COW rewrite)
            mb.expire(cat, NAMESPACE, t, ttl_ms)                 # snapshot expiry + physical sweep
        except Exception as exc:  # noqa: BLE001 — one table must never abort the housekeeping sweep
            failures.append(t)
            print(f"[maintenance] WARN {NAMESPACE}.{t}: {exc}", flush=True)
    if failures:
        raise SystemExit(f"[maintenance] FAILED on {len(failures)} table(s): {failures}")
    print("[maintenance] DONE (compaction + snapshot expiry)", flush=True)


def erase(cat, brand_id: str) -> None:
    from pyiceberg.expressions import EqualTo

    # Guard: a UUID-shaped brand id only (defense-in-depth on an interpolated identifier).
    safe = "".join(ch for ch in brand_id if ch in "0123456789abcdefABCDEF-")
    if safe != brand_id or len(safe) < 32:
        raise SystemExit(f"[erase] refusing — ERASE_BRAND_ID is not a UUID: {brand_id!r}")
    con = mb.duckdb_connect()
    t = mb.fqtn(NAMESPACE, _TABLE_NAME)
    con.execute(f"SELECT count(*) FROM {t} WHERE brand_id = '{safe}'")
    before = con.fetchone()[0]
    print(f"[erase] brand={safe} rows_before={before}", flush=True)
    # 1. Row DELETE — pyiceberg COW: rewrites the affected data files in the same commit, so the
    #    erased rows leave the live files immediately (no merge-on-read delete files to compact).
    mb.delete(cat, NAMESPACE, _TABLE_NAME, EqualTo("brand_id", safe))
    # 2. Compaction — perf backstop over the rewritten layout (skip-heuristic no-op if compacted).
    mb.optimize(cat, NAMESPACE, _TABLE_NAME)
    # 3. expire (0ms) → cutoff=now: purge the pre-deletion snapshots immediately + sweep their files
    #    from S3 (no time-travel back to the erased rows). This is the physical-removal step — the
    #    whole point of RTBF.
    mb.expire(cat, NAMESPACE, _TABLE_NAME, 0)
    con.execute(f"SELECT count(*) FROM {t} WHERE brand_id = '{safe}'")
    after = con.fetchone()[0]
    print(f"[erase] brand={safe} rows_after={after} — {'OK ✓' if after == 0 else 'STILL PRESENT ✗'}", flush=True)
    if after != 0:
        sys.exit(1)


def main() -> None:
    cat = mb.pyiceberg_catalog()
    if MODE == "erase":
        brand = os.environ.get("ERASE_BRAND_ID", "")
        if not brand:
            raise SystemExit("[erase] ERASE_BRAND_ID is required for MODE=erase")
        erase(cat, brand)
    else:
        maintain(cat)


if __name__ == "__main__":
    main()
