"""
bronze_maintenance.py (Trino) — Iceberg Bronze maintenance, ported from
db/iceberg/spark/bronze_maintenance.py to the Trino ⇄ Iceberg seam (trino_base.py).

WHY TRINO: DuckDB can't run the Iceberg maintenance stored procedures; Trino can, via
`ALTER TABLE … EXECUTE optimize / expire_snapshots / remove_orphan_files`. The Spark job's
`CALL rest.system.rewrite_data_files / expire_snapshots` reproduce 1:1 as Trino EXECUTE
procedures against the SAME REST catalog + MinIO (addressed as `iceberg` here vs `rest` in Spark).

Under ADR-0010 the Bronze writer is the Kafka Connect Iceberg sink: the collector lane lands in
brain_bronze.collector_events_connect and each of the 9 connector raw lanes lands in its own
brain_bronze.<lane>_raw_connect table (auto-created on the lane's FIRST record). In "maintain"
mode this job sweeps EVERY table in the Bronze namespace (SHOW TABLES) — so a *_raw_connect table
created after this job last shipped is covered automatically — unless BRONZE_TABLE pins a single
table for a one-off run.

Two modes (MODE env):

  "maintain" (default) — the periodic housekeeping (Argo CronWorkflow):
    1. optimize (compaction)  — coalesce the many small parquet files the Connect sink commits per
       flush interval into target-sized files (read performance + S3 cost). Trino analogue of Spark
       rewrite_data_files.
    2. expire_snapshots       — drop snapshots older than the retention window and delete the
       data/manifest files only they referenced (the rolling retention guarantee).

  "erase" (ERASE_BRAND_ID set) — RIGHT-TO-ERASURE / crypto-shred companion (D13, I-S05). Targets the
    ONE table BRONZE_TABLE selects (default: `collector_events_connect`, the live Bronze SoR). After
    a brand's per-brand DEK is destroyed, this PHYSICALLY removes that brand's rows from the open
    Bronze Parquet:
      1. DELETE FROM ... WHERE brand_id = <erased>   (format-v2 merge-on-read delete)
      2. optimize (compaction) — rewrite the affected partitions so the deleted rows are gone from
         the live data files (not just masked by delete files).
      3. expire_snapshots (0s)  — expire the pre-deletion snapshots so the OLD files are deleted from
         S3 — without this, time-travel could still read the erased data.

RETENTION WINDOWS reproduced EXACTLY from the Spark job (converted ms → Trino duration string):
  SNAPSHOT_TTL_MS         = 604_800_000  (7 days)   — the raw / default lane window.
  DURABLE_SNAPSHOT_TTL_MS = 1_209_600_000 (14 days) — the durable collector lane (AUD-OPS-015) keeps a
                            longer time-travel window (collector_events_connect never row-deletes).
  Erase-mode expire uses ttl_ms=0 → '0s' (immediate purge of pre-deletion snapshots).

Run: python bronze_maintenance.py  (env: MODE, BRONZE_TABLE, SNAPSHOT_TTL_MS, DURABLE_SNAPSHOT_TTL_MS,
DURABLE_TABLES, ERASE_BRAND_ID, plus the TRINO_* connection seams in trino_base.py).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import trino_base as tb  # noqa: E402

NAMESPACE = os.environ.get("BRONZE_NAMESPACE", tb.BRONZE_NAMESPACE)

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


def _maintenance_tables(cur) -> "list[str]":
    """The tables this run maintains. BRONZE_TABLE pins ONE (one-off / erase target); otherwise scan
    the namespace so every Connect-written table (collector_events_connect + the auto-created
    *_raw_connect lanes) is covered without enumeration — same auto-discovery the Spark job gets."""
    if os.environ.get("BRONZE_TABLE"):
        return [_TABLE_NAME]
    return tb.tables_in(cur, NAMESPACE)


def maintain(cur) -> None:
    tables = _maintenance_tables(cur)
    print(f"[maintenance] sweeping {len(tables)} table(s) in {tb.CATALOG}.{NAMESPACE}: {tables}", flush=True)
    failures = []
    for t in tables:
        # AUD-OPS-015: durable (never-row-deleted) tables get the longer time-travel window.
        ttl_ms = DURABLE_SNAPSHOT_TTL_MS if t in DURABLE_TABLES else SNAPSHOT_TTL_MS
        retention = tb.ms_to_duration(ttl_ms)
        try:
            tb.optimize(cur, NAMESPACE, t)                       # compaction (rewrite_data_files)
            tb.expire(cur, NAMESPACE, t, retention)             # snapshot expiry
        except Exception as exc:  # noqa: BLE001 — one table must never abort the housekeeping sweep
            failures.append(t)
            print(f"[maintenance] WARN {tb.CATALOG}.{NAMESPACE}.{t}: {exc}", flush=True)
    if failures:
        raise SystemExit(f"[maintenance] FAILED on {len(failures)} table(s): {failures}")
    print("[maintenance] DONE (compaction + snapshot expiry)", flush=True)


def erase(cur, brand_id: str) -> None:
    # Guard: a UUID-shaped brand id only (defense-in-depth on an interpolated identifier).
    safe = "".join(ch for ch in brand_id if ch in "0123456789abcdefABCDEF-")
    if safe != brand_id or len(safe) < 32:
        raise SystemExit(f"[erase] refusing — ERASE_BRAND_ID is not a UUID: {brand_id!r}")
    t = fqtn = tb.fqtn(NAMESPACE, _TABLE_NAME)
    cur.execute(f"SELECT count(*) FROM {t} WHERE brand_id = '{safe}'")
    before = cur.fetchone()[0]
    print(f"[erase] brand={safe} rows_before={before}", flush=True)
    # 1. Row DELETE (format-v2 merge-on-read delete).
    cur.execute(f"DELETE FROM {t} WHERE brand_id = '{safe}'")
    cur.fetchall()
    # 2. Compaction — rewrite affected partitions so live files no longer contain the rows.
    tb.optimize(cur, NAMESPACE, _TABLE_NAME)
    # 3. expire (0s) → cutoff=now: purge the pre-deletion snapshots immediately (no time-travel back
    #    to the erased rows). This is the physical-removal step — the whole point of RTBF.
    tb.expire(cur, NAMESPACE, _TABLE_NAME, tb.ms_to_duration(0))
    cur.execute(f"SELECT count(*) FROM {t} WHERE brand_id = '{safe}'")
    after = cur.fetchone()[0]
    print(f"[erase] brand={safe} rows_after={after} — {'OK ✓' if after == 0 else 'STILL PRESENT ✗'}", flush=True)
    if after != 0:
        sys.exit(1)


def main() -> None:
    conn = tb.connect()
    cur = conn.cursor()
    if MODE == "erase":
        brand = os.environ.get("ERASE_BRAND_ID", "")
        if not brand:
            raise SystemExit("[erase] ERASE_BRAND_ID is required for MODE=erase")
        erase(cur, brand)
    else:
        maintain(cur)


if __name__ == "__main__":
    main()
