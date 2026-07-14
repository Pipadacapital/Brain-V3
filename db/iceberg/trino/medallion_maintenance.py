"""
medallion_maintenance.py (Trino) — Iceberg Silver + Gold maintenance, ported from
db/iceberg/spark/medallion_maintenance.py to the Trino ⇄ Iceberg seam (trino_base.py).

The Silver/Gold companion to bronze_maintenance.py: extends the SAME three maintenance operations
(compaction, snapshot-expiry, orphan-file removal — plus crypto-shred erasure) to the brain_silver +
brain_gold namespaces. ADDITIVE — it operates only on the Silver/Gold marts.

Modes (MODE env):

  "maintain" (default) — periodic housekeeping (Argo CronWorkflow shape):
    For EVERY table in brain_silver and brain_gold (auto-discovered via SHOW TABLES, so new marts are
    covered without editing this file):
      1. optimize (compaction)  — coalesce small per-batch parquet files into target-sized ones
         (Trino analogue of Spark rewrite_data_files).
      2. expire_snapshots       — TTL: drop snapshots older than the retention window + delete the
         data/manifest files only they referenced.
      3. remove_orphan_files    — (guarded) delete files under a table's location that NO snapshot
         references (leftovers of failed/killed jobs).

  "erase" (ERASE_BRAND_ID set) — RIGHT-TO-ERASURE / crypto-shred companion (mirrors bronze_maintenance):
    For every Silver/Gold table that HAS a brand_id column (all of them, by the tenant-key invariant):
      1. DELETE FROM ... WHERE brand_id = <erased>   (format-v2 merge-on-read delete)
      2. optimize (compaction) — rewrite affected partitions so live files no longer contain the rows.
      3. expire_snapshots (0s)  — expire pre-deletion snapshots so the old files are purged (no
         time-travel back). This is the physical-removal step — the whole point of RTBF.

RETENTION WINDOWS reproduced EXACTLY from the Spark job:
  SNAPSHOT_TTL_MS        = 604_800_000 (7 days) — the snapshot time-travel window for all marts.
  ORPHAN_OLDER_THAN_DAYS = 3 (hard floor; max(3, env)) — files of any in-flight/recently-retried
                           commit are never candidates. ORPHAN_FILES=0 disables the sweep.
  Erase-mode expire uses ttl_ms=0 → '0s' (immediate purge of pre-deletion snapshots).

NOTE on REWRITE_MIN_INPUT_FILES: the Spark job passed min-input-files=2 to force compaction on the
marts' tiny-file layout. Trino's `EXECUTE optimize` has no per-EXECUTE min-input-files argument; it
compacts small files up to `iceberg.target-max-file-size` and is a no-op on already-compacted
partitions, so the behaviour matches without the knob (documented in trino_base.optimize).

Run: python medallion_maintenance.py  (env: MODE, MAINT_NAMESPACES, SNAPSHOT_TTL_MS, ORPHAN_FILES,
ORPHAN_OLDER_THAN_DAYS, ERASE_BRAND_ID, plus the TRINO_* connection seams in trino_base.py).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import trino_base as tb  # noqa: E402

MODE = os.environ.get("MODE", "maintain")
# Namespaces this maintenance run covers (comma-separated; defaults = Silver + Gold). `or` (not a
# get() default): an empty MAINT_NAMESPACES must fall back too — an empty list made the whole job a
# silent no-op (AUD-PERF-004).
NAMESPACES = [
    ns.strip()
    for ns in (os.environ.get("MAINT_NAMESPACES") or f"{tb.SILVER_NAMESPACE},{tb.GOLD_NAMESPACE}").split(",")
    if ns.strip()
]
# SNAPSHOT TTL ≠ DATA RETENTION (AUD-PERF-013). expire_snapshots only drops HISTORY. 7-day bounded
# time-travel window; DATA retention is a row/partition DELETE concern (bronze_raw_retention.py).
SNAPSHOT_TTL_MS = int(os.environ.get("SNAPSHOT_TTL_MS", str(604_800_000)))  # 7 days
# Orphan-file removal (guarded; AUD-PERF-004): delete files under a table's location that NO snapshot
# references. older_than has a HARD 3-day floor so files of any in-flight/recently-retried commit are
# never candidates; ORPHAN_FILES=0 disables the sweep.
ORPHAN_FILES = os.environ.get("ORPHAN_FILES", "1") == "1"
ORPHAN_OLDER_THAN_DAYS = max(3, int(os.environ.get("ORPHAN_OLDER_THAN_DAYS", "3")))


def maintain(cur) -> None:
    snapshot_retention = tb.ms_to_duration(SNAPSHOT_TTL_MS)
    orphan_retention = f"{ORPHAN_OLDER_THAN_DAYS}d"
    failures = 0
    for namespace in NAMESPACES:
        tables = tb.tables_in(cur, namespace)
        print(f"[maintenance] {tb.CATALOG}.{namespace}: {len(tables)} table(s) → {tables}", flush=True)
        for table in tables:
            # One broken table must not abort the whole sweep — log, count, keep going, exit non-zero.
            try:
                tb.optimize(cur, namespace, table)                        # compaction
                tb.expire(cur, namespace, table, snapshot_retention)      # snapshot expiry
                if ORPHAN_FILES:
                    tb.remove_orphans(cur, namespace, table, orphan_retention)
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"[maintenance] WARN {tb.CATALOG}.{namespace}.{table}: {exc}", flush=True)
    if failures:
        print(f"[maintenance] DONE with {failures} failed table(s) ✗", flush=True)
        sys.exit(1)
    print("[maintenance] DONE (compaction + snapshot expiry + orphan sweep over Silver + Gold)", flush=True)


def erase(cur, brand_id: str) -> None:
    # Guard: a UUID-shaped brand id only (defense-in-depth on an interpolated identifier) — same as Bronze.
    safe = "".join(ch for ch in brand_id if ch in "0123456789abcdefABCDEF-")
    if safe != brand_id or len(safe) < 32:
        raise SystemExit(f"[erase] refusing — ERASE_BRAND_ID is not a UUID: {brand_id!r}")

    failures = 0
    for namespace in NAMESPACES:
        for table in tb.tables_in(cur, namespace):
            fq = tb.fqtn(namespace, table)
            if "brand_id" not in tb.columns_of(cur, namespace, table):
                print(f"[erase] skip {fq} — no brand_id column", flush=True)
                continue
            cur.execute(f"SELECT count(*) FROM {fq} WHERE brand_id = '{safe}'")
            before = cur.fetchone()[0]
            print(f"[erase] {fq} brand={safe} rows_before={before}", flush=True)
            # 1. Row DELETE (format-v2 merge-on-read delete).
            cur.execute(f"DELETE FROM {fq} WHERE brand_id = '{safe}'")
            cur.fetchall()
            # 2. Compaction — rewrite affected partitions so live files no longer contain the rows.
            tb.optimize(cur, namespace, table)
            # 3. expire (0s) → cutoff=now: the pre-deletion snapshots MUST be purged immediately or the
            #    erased rows stay time-travel-readable for the whole snapshot TTL.
            tb.expire(cur, namespace, table, tb.ms_to_duration(0))
            cur.execute(f"SELECT count(*) FROM {fq} WHERE brand_id = '{safe}'")
            after = cur.fetchone()[0]
            status = "OK ✓" if after == 0 else "STILL PRESENT ✗"
            print(f"[erase] {fq} brand={safe} rows_after={after} — {status}", flush=True)
            if after != 0:
                failures += 1
    if failures:
        sys.exit(1)
    print(f"[erase] DONE — brand {safe} erased from Silver + Gold ✓", flush=True)


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
