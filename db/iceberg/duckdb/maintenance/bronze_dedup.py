"""
bronze_dedup.py (PyIceberg + DuckDB) — ADR-0015 D2(b): Bronze compaction-time dedup, keep-latest on
(brand_id, event_id) over the collector lane (brain_bronze.collector_events_connect).

WHY (ADR-0015, amends ADR-0012): the owner requires no duplicate rows in ANY queried store,
including Bronze. Writes stay append-fast (the Kafka Connect sink never merges); this job runs in
the PyIceberg maintenance tier alongside compaction so Bronze CONVERGES to zero-duplicate within
each maintenance cycle. Layer (a) is the idempotent producer + exactly-once Connect sink (delivery
dupes); layer (c) is the Silver keystone MERGE on (brand_id, event_id) — the final backstop. This
is layer (b): the physical Bronze dedup for application-level re-sends/replays.

KEY LIFT: the Connect collector lane lands the VERBATIM envelope — `payload` (raw JSON string) +
kafka coords. brand_id / event_id are NOT physical columns, so the dedup key is lifted from the
payload JSON exactly as the Silver keystone lifts it (json_extract_string $.brand_id / $.event_id).
A row whose payload lacks either key is NEVER touched (malformed rows are Silver-quarantine
material, not dedup losers). Keep-latest = the copy with the highest (kafka_timestamp,
kafka_offset, kafka_partition) survives — the latest delivery wins, mirroring the keystone's
latest-ingested-wins MERGE.

MECHANICS (COW, no MoR delete storm — the same posture as the erasure lane):
  1. DuckDB finds the duplicated keys and the [min, max] kafka_timestamp span containing EVERY
     copy of every duplicated key. No dupes → fast no-op (the expected steady state under EOS
     transport).
  2. The span is widened to UTC day bounds (the collector lane's day(kafka_timestamp) partition
     grain) and rewritten as ONE atomic COW overwrite: DuckDB reads the survivors (QUALIFY
     row_number()=1 per key), pyiceberg overwrite(overwrite_filter=<span>) swaps them in — a
     single Iceberg commit, readers never see a partial state. Bounded optimistic-concurrency
     retry (re-read survivors from the new snapshot) absorbs a racing Connect append, so a
     concurrent write is never clobbered (probe gate 6).
  3. Post-rewrite the duplicate count is re-checked and the job exits non-zero if any remain.

GATED by the same capability-probe pattern as the sibling maintenance jobs
(maintenance_capability_probe.py): this job relies ONLY on capabilities the probe proves — gate 2
(DuckDB-write ↔ PyIceberg-read parity + the 0.11.1 manifest shim _maintenance_base applies at
import), gate 5 (COW rewrite), gate 6 (overwrite atomicity + commit-conflict retry). Run the probe
before pointing this at a new catalog/environment.

MEMORY VALVE: the rewrite unit reads its survivors into arrow. A span above
BRONZE_DEDUP_MAX_REWRITE_BYTES (default = OPTIMIZE_MAX_REWRITE_BYTES, 2 GiB) is loudly refused
(exit 1) instead of OOMing the pod — rerun with BRONZE_DEDUP_FORCE=1 to override (a one-off
backlog clear on a bigger pod). Steady-state spans are tiny: transport dupes land seconds apart.

SNAPSHOT NOTE: the pre-dedup snapshots still reference the duplicated files until
bronze_maintenance.py's expire_snapshots pass sweeps them — schedule this BEFORE the maintenance
sweep (the cronworkflow runs dedup → optimize → expire in one sequence).

Run: python bronze_dedup.py  (env: BRONZE_NAMESPACE, BRONZE_TABLE, BRONZE_DEDUP_MAX_REWRITE_BYTES,
BRONZE_DEDUP_FORCE, plus the ICEBERG_REST_*/S3/AWS connection seams in _maintenance_base.py).
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import _maintenance_base as mb  # noqa: E402

NAMESPACE = os.environ.get("BRONZE_NAMESPACE", mb.BRONZE_NAMESPACE)
TABLE = os.environ.get("BRONZE_TABLE", "collector_events_connect")
# COW memory valve (mirrors OPTIMIZE_MAX_REWRITE_BYTES). BRONZE_DEDUP_FORCE=1 bypasses it for a
# deliberate one-off backlog clear — zero-dupe convergence outranks the guard there.
MAX_REWRITE_BYTES = int(
    os.environ.get("BRONZE_DEDUP_MAX_REWRITE_BYTES", str(mb.OPTIMIZE_MAX_REWRITE_BYTES))
)
FORCE = os.environ.get("BRONZE_DEDUP_FORCE", "0") == "1"

# The dedup key, lifted from the verbatim envelope payload — the SAME JSON paths the Silver
# keystone (silver_collector_event.py) lifts for its admission MERGE.
BRAND_EXPR = "json_extract_string(payload, '$.brand_id')"
EVENT_EXPR = "json_extract_string(payload, '$.event_id')"


def dup_span_sql(fq: str) -> str:
    """SQL over the live table: (duplicate_row_count, span_min_ts, span_max_ts) across every row
    of every duplicated (brand_id, event_id). NULL-keyed / NULL-timestamp rows are excluded — they
    are never dedup candidates (kept verbatim, the safe direction)."""
    return f"""
    WITH keyed AS (
      SELECT {BRAND_EXPR} AS brand_id, {EVENT_EXPR} AS event_id, kafka_timestamp
      FROM {fq}
      WHERE {BRAND_EXPR} IS NOT NULL AND {EVENT_EXPR} IS NOT NULL
        AND kafka_timestamp IS NOT NULL
    ), dup_keys AS (
      SELECT brand_id, event_id FROM keyed GROUP BY brand_id, event_id HAVING count(*) > 1
    )
    SELECT count(*), min(k.kafka_timestamp), max(k.kafka_timestamp)
    FROM keyed k JOIN dup_keys d USING (brand_id, event_id)
    """


def survivors_sql(fq: str, duck_pred: str) -> str:
    """The COW rewrite's read half: every in-span row EXCEPT the non-latest copies of duplicated
    keys. Rows with a NULL brand_id/event_id/kafka_timestamp pass the guard verbatim (never
    collapsed); ties on kafka_timestamp break on (kafka_offset, kafka_partition) so exactly one
    copy survives deterministically."""
    return f"""
    SELECT * FROM {fq}
    WHERE {duck_pred}
    QUALIFY (
      {BRAND_EXPR} IS NULL OR {EVENT_EXPR} IS NULL OR kafka_timestamp IS NULL
      OR row_number() OVER (
           PARTITION BY {BRAND_EXPR}, {EVENT_EXPR}
           ORDER BY kafka_timestamp DESC, kafka_offset DESC, kafka_partition DESC
         ) = 1
    )
    """


def day_span(ts_min: datetime, ts_max: datetime) -> "tuple[datetime, datetime]":
    """Half-open UTC [day_floor(min), day_floor(max) + 1d) span — day-aligned so the overwrite
    filter matches the collector lane's day(kafka_timestamp) partition grain (whole-partition
    rewrite units, and a boundary-instant row can never fall between the two predicates)."""
    if ts_min.tzinfo is None:
        ts_min = ts_min.replace(tzinfo=timezone.utc)
    if ts_max.tzinfo is None:
        ts_max = ts_max.replace(tzinfo=timezone.utc)
    start = ts_min.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    end = ts_max.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return start, end


def span_bytes(tbl, start: datetime, end: datetime) -> int:
    """Upper-bound data bytes the rewrite unit touches: sum of data-file sizes whose
    day(kafka_timestamp) partition value falls in [start, end). Partition values arrive either as
    date objects or epoch-relative day ints (both shapes observed from inspect.files() —
    _maintenance_base._rewrite_units); a file without the partition value (unpartitioned/legacy
    layout) is counted conservatively (assume in-span)."""
    try:
        files = tbl.inspect.files().to_pylist()
    except ValueError:  # no manifests at all (empty current snapshot)
        return 0
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    total = 0
    for f in files:
        if f["content"] != 0:  # data files only
            continue
        value = None
        for pv in (f.get("partition") or {}).values():
            value = pv
            break
        if value is None:
            total += f["file_size_in_bytes"]  # unpartitioned — conservative
            continue
        day = (
            epoch + timedelta(days=int(value))
            if isinstance(value, int)
            else datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
        )
        if start <= day < end:
            total += f["file_size_in_bytes"]
    return total


def _overwrite_survivors_with_retry(cat, expr, sql: str) -> None:
    """One atomic COW dedup commit with the seam's bounded optimistic-concurrency retry
    (mirrors _maintenance_base._overwrite_with_retry, but the read half is the dedup QUALIFY
    query rather than a plain WHERE): on CommitFailedException (a racing Connect append) the
    survivors are RE-READ from the new snapshot before re-attempting, so a concurrent write is
    never clobbered (probe gate 6)."""
    from pyiceberg.exceptions import CommitFailedException
    from pyiceberg.io.pyarrow import schema_to_pyarrow

    con = mb.duckdb_connect()
    name = mb.ident(NAMESPACE, TABLE)
    for attempt in range(1, mb.MAINT_COMMIT_RETRIES + 1):
        surviving = con.execute(sql).fetch_arrow_table()
        tbl = cat.load_table(name)
        # DuckDB's arrow export marks every field nullable; cast back to the table schema's arrow
        # shape (field ids + required flags) — same gotcha as the compaction rewrite.
        surviving = surviving.cast(schema_to_pyarrow(tbl.schema()))
        try:
            tbl.overwrite(surviving, overwrite_filter=expr)
            return
        except CommitFailedException as exc:
            if attempt == mb.MAINT_COMMIT_RETRIES:
                raise
            print(
                f"[bronze-dedup] commit conflict on {name} (attempt {attempt}/{mb.MAINT_COMMIT_RETRIES}): "
                f"{exc} — re-reading + retrying",
                flush=True,
            )
            time.sleep(attempt)  # linear backoff; the conflicting commit has already landed


def main() -> None:
    cat = mb.pyiceberg_catalog()
    if not mb.table_exists(cat, NAMESPACE, TABLE):
        print(f"[bronze-dedup] {NAMESPACE}.{TABLE}: table does not exist yet — nothing to dedup", flush=True)
        return
    tbl = cat.load_table(mb.ident(NAMESPACE, TABLE))
    if tbl.current_snapshot() is None:
        print(f"[bronze-dedup] {NAMESPACE}.{TABLE}: empty table — nothing to dedup", flush=True)
        return

    con = mb.duckdb_connect()
    fq = mb.fqtn(NAMESPACE, TABLE)
    dup_rows, ts_min, ts_max = con.execute(dup_span_sql(fq)).fetchone()
    if not dup_rows:
        print(f"[bronze-dedup] {fq}: zero duplicate (brand_id, event_id) rows — no-op ✓", flush=True)
        return

    # Literal shape must match the SOURCE column type (ts vs tstz) — same dispatch as the
    # compaction rewrite units.
    col_type = mb.column_types(cat, NAMESPACE, TABLE).get("kafka_timestamp", "timestamptz")
    kind = "tstz" if col_type.startswith("timestamptz") else "ts"
    start, end = day_span(ts_min, ts_max)
    label, expr, duck_pred, _, _, _ = mb._temporal_unit("kafka_timestamp", start, end, 0, 0, kind)

    n_bytes = span_bytes(tbl, start, end)
    print(
        f"[bronze-dedup] {fq}: {dup_rows} row(s) across duplicated keys; rewrite unit [{label}] ~{n_bytes}B",
        flush=True,
    )
    if n_bytes > MAX_REWRITE_BYTES and not FORCE:
        raise SystemExit(
            f"[bronze-dedup] REFUSED: rewrite unit {n_bytes}B exceeds BRONZE_DEDUP_MAX_REWRITE_BYTES="
            f"{MAX_REWRITE_BYTES} (COW memory valve). Bronze still holds duplicates — rerun with "
            f"BRONZE_DEDUP_FORCE=1 on a pod with headroom."
        )

    _overwrite_survivors_with_retry(cat, expr, survivors_sql(fq, duck_pred))

    remaining = con.execute(dup_span_sql(fq)).fetchone()[0]
    if remaining:
        raise SystemExit(f"[bronze-dedup] FAILED: {remaining} duplicate row(s) remain after rewrite")
    print(f"[bronze-dedup] DONE — {fq} is zero-duplicate on (brand_id, event_id) ✓", flush=True)


if __name__ == "__main__":
    main()
