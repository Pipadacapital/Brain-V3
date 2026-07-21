"""
medallion_maintenance.py (PyIceberg + DuckDB) — Iceberg Silver + Gold maintenance, ported 1:1 from
db/iceberg/trino/medallion_maintenance.py to the PyIceberg maintenance seam (_maintenance_base.py).

The Silver/Gold companion to bronze_maintenance.py: extends the SAME maintenance operations
(compaction, snapshot-expiry, orphan-file removal — plus crypto-shred erasure) to the brain_silver +
brain_gold namespaces. ADDITIVE — it operates only on the Silver/Gold marts.

Modes (MODE env — contract UNCHANGED from the Trino job):

  "maintain" (default) — periodic housekeeping (Argo CronWorkflow shape):
    For EVERY table in brain_silver and brain_gold (auto-discovered via list_tables, so new marts are
    covered without editing this file):
      1. optimize (compaction)  — coalesce small per-batch parquet files into target-sized ones
         (PyIceberg COW rewrite with the skip heuristic — _maintenance_base.optimize).
      2. expire_snapshots       — TTL: drop snapshots older than the retention window + physically
         delete the data/manifest files only they referenced (the sweep half is mandatory — pyiceberg
         expire is metadata-only, probe gate 4).
      3. remove_orphan_files    — DEFERRED GAP (ADR-0014): pyiceberg 0.11 has no orphan-file API, so
         this is a loud, greppable SKIP per table until the API lands (files under a table's location
         that NO snapshot references — leftovers of failed/killed jobs — accumulate until then).

  "erase" (ERASE_BRAND_ID set) — RIGHT-TO-ERASURE / crypto-shred companion (mirrors bronze_maintenance):
    For every Silver/Gold table that HAS a brand_id column (all of them, by the tenant-key invariant):
      1. COW DELETE WHERE brand_id = <erased> — pyiceberg table.delete rewrites the affected data
         files in the same commit (rows leave the live files immediately; no compaction pass needed).
      2. optimize (compaction) — perf backstop over the rewritten layout (skip-heuristic no-op).
      3. expire_snapshots (0ms) + sweep — expire pre-deletion snapshots so the old files are purged
         from S3 (no time-travel back). This is the physical-removal step — the whole point of RTBF.

RETENTION WINDOWS reproduced EXACTLY from the Spark/Trino jobs:
  SNAPSHOT_TTL_MS        = 604_800_000 (7 days) — the snapshot time-travel window for all marts.
  ORPHAN_OLDER_THAN_DAYS = 3 (hard floor; max(3, env)) — preserved for the day the orphan sweep
                           lands; today it only parameterizes the SKIP log. ORPHAN_FILES=0 disables.
  Erase-mode expire uses ttl_ms=0 → cutoff=now (immediate purge of pre-deletion snapshots).

NOTE on REWRITE_MIN_INPUT_FILES: the Spark job passed min-input-files=2 to force compaction on the
marts' tiny-file layout; Trino had no per-EXECUTE knob and leaned on its no-op-when-compacted
optimizer. The PyIceberg rewrite restores the explicit knob (OPTIMIZE_MIN_INPUT_FILES, default 2)
AND keeps the no-op behaviour via the skip heuristic (documented in _maintenance_base.optimize).

Run: python medallion_maintenance.py  (env: MODE, MAINT_NAMESPACES, SNAPSHOT_TTL_MS, ORPHAN_FILES,
ORPHAN_OLDER_THAN_DAYS, ERASE_BRAND_ID, plus the ICEBERG_REST_*/S3/AWS seams in _maintenance_base.py).
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import _maintenance_base as mb  # noqa: E402

MODE = os.environ.get("MODE", "maintain")
# Namespaces this maintenance run covers (comma-separated; defaults = Silver + Gold). `or` (not a
# get() default): an empty MAINT_NAMESPACES must fall back too — an empty list made the whole job a
# silent no-op (AUD-PERF-004).
# GOLD-FIRST ORDERING (2026-07-17 fragmentation incident): the full sweep processes Gold BEFORE
# Silver so the serving-facing marts (gold_customer_360, gold_customer_list, …) are always compacted
# first — even if the run later hits activeDeadlineSeconds inside Silver's heavy tables
# (silver_job_watermark alone accreted ~7.3k tiny files). Previously Silver-first: a deadline in
# Silver left Gold un-compacted for days → 8s serving cold-scans. Prod also splits Gold/Silver into
# separate cron lanes (MAINT_NAMESPACES) so neither can starve the other; this default is the
# single-lane safety net.
NAMESPACES = [
    ns.strip()
    for ns in (os.environ.get("MAINT_NAMESPACES") or f"{mb.GOLD_NAMESPACE},{mb.SILVER_NAMESPACE}").split(",")
    if ns.strip()
]
# Optional TABLE allowlist (comma-separated, applied across every namespace in this run). Powers the
# HOT-TABLE lane (2026-07-21 keystone incident): silver_collector_event re-fragments ~2.4 files/min
# under the */5 MERGE churn (723→1,442 live files in ~5h), and the daily whole-namespace Silver sweep
# can't hold it — serving-mediated reads (the silver-identity lane) then exceed ANY statement budget
# on file-count alone. A tables-scoped fast lane compacts just the hot tables every couple of hours
# without re-running Silver's heavy full sweep (the 2026-07-17 lane-split starvation lesson). Empty →
# all tables in the namespace (unchanged behavior). maintain-mode only; erase always sweeps ALL
# tables (RTBF must never skip one).
MAINT_TABLES = {t.strip() for t in os.environ.get("MAINT_TABLES", "").split(",") if t.strip()}
# SNAPSHOT TTL ≠ DATA RETENTION (AUD-PERF-013). expire_snapshots only drops HISTORY. 7-day bounded
# time-travel window; DATA retention is a row/partition DELETE concern (bronze_raw_retention.py).
SNAPSHOT_TTL_MS = int(os.environ.get("SNAPSHOT_TTL_MS", str(604_800_000)))  # 7 days
# Orphan-file removal (guarded; AUD-PERF-004): delete files under a table's location that NO snapshot
# references. older_than has a HARD 3-day floor so files of any in-flight/recently-retried commit are
# never candidates; ORPHAN_FILES=0 disables the sweep. (Currently a loud SKIP — see module docstring.)
ORPHAN_FILES = os.environ.get("ORPHAN_FILES", "1") == "1"
ORPHAN_OLDER_THAN_DAYS = max(3, int(os.environ.get("ORPHAN_OLDER_THAN_DAYS", "3")))


def maintain(cat) -> None:
    failures = 0
    for namespace in NAMESPACES:
        tables = mb.tables_in(cat, namespace)
        if MAINT_TABLES:
            skipped = [t for t in tables if t not in MAINT_TABLES]
            tables = [t for t in tables if t in MAINT_TABLES]
            # No silent caps: a hot-lane run says exactly what it does NOT cover.
            print(f"[maintenance] {namespace}: MAINT_TABLES filter → {tables} ({len(skipped)} skipped)", flush=True)
        print(f"[maintenance] {namespace}: {len(tables)} table(s) → {tables}", flush=True)
        for table in tables:
            # One broken table must not abort the whole sweep — log, count, keep going, exit non-zero.
            try:
                mb.optimize(cat, namespace, table)                        # compaction (COW rewrite)
                mb.expire(cat, namespace, table, SNAPSHOT_TTL_MS)         # snapshot expiry + sweep
                if ORPHAN_FILES:
                    mb.remove_orphans(cat, namespace, table, ORPHAN_OLDER_THAN_DAYS)
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"[maintenance] WARN {namespace}.{table}: {exc}", flush=True)
    if failures:
        print(f"[maintenance] DONE with {failures} failed table(s) ✗", flush=True)
        sys.exit(1)
    print("[maintenance] DONE (compaction + snapshot expiry + orphan sweep over Silver + Gold)", flush=True)


def erase(cat, brand_id: str) -> None:
    from pyiceberg.expressions import EqualTo

    # Guard: a UUID-shaped brand id only (defense-in-depth on an interpolated identifier) — same as Bronze.
    safe = "".join(ch for ch in brand_id if ch in "0123456789abcdefABCDEF-")
    if safe != brand_id or len(safe) < 32:
        raise SystemExit(f"[erase] refusing — ERASE_BRAND_ID is not a UUID: {brand_id!r}")

    con = mb.duckdb_connect()
    failures = 0
    for namespace in NAMESPACES:
        for table in mb.tables_in(cat, namespace):
            fq = mb.fqtn(namespace, table)
            if "brand_id" not in mb.columns_of(cat, namespace, table):
                print(f"[erase] skip {fq} — no brand_id column", flush=True)
                continue
            before = con.execute(f"SELECT count(*) FROM {fq} WHERE brand_id = '{safe}'").fetchone()[0]
            print(f"[erase] {fq} brand={safe} rows_before={before}", flush=True)
            # 1. Row DELETE — pyiceberg COW: rewrites the affected data files in the same commit.
            mb.delete(cat, namespace, table, EqualTo("brand_id", safe))
            # 2. Compaction — perf backstop over the rewritten layout (skip-heuristic no-op).
            mb.optimize(cat, namespace, table)
            # 3. expire (0ms) → cutoff=now: the pre-deletion snapshots MUST be purged immediately (+
            #    swept from S3) or the erased rows stay time-travel-readable for the whole snapshot TTL.
            mb.expire(cat, namespace, table, 0)
            after = con.execute(f"SELECT count(*) FROM {fq} WHERE brand_id = '{safe}'").fetchone()[0]
            status = "OK ✓" if after == 0 else "STILL PRESENT ✗"
            print(f"[erase] {fq} brand={safe} rows_after={after} — {status}", flush=True)
            if after != 0:
                failures += 1
    if failures:
        sys.exit(1)
    print(f"[erase] DONE — brand {safe} erased from Silver + Gold ✓", flush=True)


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
