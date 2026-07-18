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

MECHANICS — TARGETED COW LOSER DELETE (2026-07-18 rework; no MoR delete storm, same COW posture
as the erasure lane). The previous shape rewrote the WHOLE day-partition span containing every
duplicated key — at production volume (~2M events/day) a single transport dupe made the rewrite
unit the entire day (> the 2 GiB valve), so the job refused and Bronze never converged. Now:
  1. DuckDB identifies the LOSER rows only — for each duplicated (brand_id, event_id), every copy
     EXCEPT the keep-latest winner — and returns their (kafka_partition, kafka_offset)
     coordinates. The tie-break is UNCHANGED: kafka_timestamp DESC, kafka_offset DESC,
     kafka_partition DESC (row_number() = 1 wins; rows numbered > 1 are the losers). No dupes →
     fast no-op (the expected steady state under the EOS transport).
  2. The losers are deleted by COORDINATE via pyiceberg's copy-on-write delete
     (_maintenance_base.delete → tbl.delete, probe gate 3): only the data files that CONTAIN a
     loser row are rewritten — a dupe pair seconds apart rewrites one or two files, never a whole
     day. Predicate shape: per kafka_partition, And(EqualTo(kafka_partition), In(kafka_offset,
     [...])) — offsets are batched into IN-lists (BRONZE_DEDUP_DELETE_BATCH, default 10000) so the
     bound expression never explodes into a per-pair OR-chain. (kafka_partition, kafka_offset) is
     unique per row on a single-topic lane, so the predicate can never over-match; NULL-coordinate
     rows are excluded from candidacy outright (see the SQL NULL guard). Each batch is one atomic
     Iceberg commit with the seam's bounded CommitFailedException retry (a racing Connect append
     is never clobbered — probe gate 6; delete is naturally idempotent on re-run).
  3. Post-delete the duplicate count is re-checked and the job exits non-zero if any remain.

GATED by the same capability-probe pattern as the sibling maintenance jobs
(maintenance_capability_probe.py): this job relies ONLY on capabilities the probe proves — gate 2
(DuckDB-write ↔ PyIceberg-read parity + the 0.11.1 manifest shim _maintenance_base applies at
import), gate 3 (COW delete — tbl.delete rewrites the containing files, no MoR delete files),
gate 6 (commit-conflict retry). Run the probe before pointing this at a new catalog/environment.

MEMORY VALVE (reinterpreted for targeted deletes): the COW delete reads each AFFECTED data file
into arrow to rewrite it minus the losers, so the pressure bound is the bytes of the files that
CONTAIN loser rows — not the day span. loser_file_bytes() upper-bounds that from file manifest
metrics (readable_metrics bounds on kafka_partition/kafka_offset; a file without usable metrics
is counted conservatively). Above BRONZE_DEDUP_MAX_REWRITE_BYTES (default =
OPTIMIZE_MAX_REWRITE_BYTES, 2 GiB) the job loudly refuses (exit 1) instead of OOMing the pod —
rerun with BRONZE_DEDUP_FORCE=1 for a deliberate one-off backlog clear on a bigger pod.
Steady-state loser sets are tiny: transport dupes land seconds apart in one or two files.

SNAPSHOT NOTE: the pre-dedup snapshots still reference the duplicated files until
bronze_maintenance.py's expire_snapshots pass sweeps them — schedule this BEFORE the maintenance
sweep (the cronworkflow runs dedup → optimize → expire in one sequence).

Run: python bronze_dedup.py  (env: BRONZE_NAMESPACE, BRONZE_TABLE, BRONZE_DEDUP_MAX_REWRITE_BYTES,
BRONZE_DEDUP_FORCE, BRONZE_DEDUP_DELETE_BATCH, plus the ICEBERG_REST_*/S3/AWS connection seams in
_maintenance_base.py).
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import _maintenance_base as mb  # noqa: E402

NAMESPACE = os.environ.get("BRONZE_NAMESPACE", mb.BRONZE_NAMESPACE)
TABLE = os.environ.get("BRONZE_TABLE", "collector_events_connect")
# COW memory valve (mirrors OPTIMIZE_MAX_REWRITE_BYTES) — bounds the bytes of the files that
# CONTAIN loser rows (the targeted delete's true rewrite set). BRONZE_DEDUP_FORCE=1 bypasses it
# for a deliberate one-off backlog clear — zero-dupe convergence outranks the guard there.
MAX_REWRITE_BYTES = int(
    os.environ.get("BRONZE_DEDUP_MAX_REWRITE_BYTES", str(mb.OPTIMIZE_MAX_REWRITE_BYTES))
)
FORCE = os.environ.get("BRONZE_DEDUP_FORCE", "0") == "1"
# Max kafka_offset literals per In-list (one COW delete commit per batch). Bounds the bound
# expression size so a large backlog never builds a megabyte predicate; 10k is far above any
# steady-state loser set.
DELETE_BATCH = int(os.environ.get("BRONZE_DEDUP_DELETE_BATCH", "10000"))

# The dedup key, lifted from the verbatim envelope payload — the SAME JSON paths the Silver
# keystone (silver_collector_event.py) lifts for its admission MERGE.
BRAND_EXPR = "json_extract_string(payload, '$.brand_id')"
EVENT_EXPR = "json_extract_string(payload, '$.event_id')"

# Candidacy guard, shared by the dup count and the loser selection so the post-delete recheck can
# never disagree with the delete plan: a row missing the lifted key, the keep-latest ordering
# timestamp, or the physical delete coordinates is NEVER a dedup candidate (kept verbatim — the
# safe direction; coordinate-less rows would be untargetable by the coordinate delete).
CANDIDATE_GUARD = (
    f"{BRAND_EXPR} IS NOT NULL AND {EVENT_EXPR} IS NOT NULL\n"
    "        AND kafka_timestamp IS NOT NULL\n"
    "        AND kafka_partition IS NOT NULL AND kafka_offset IS NOT NULL"
)


def dup_count_sql(fq: str) -> str:
    """SQL over the live table: total row count across every copy of every duplicated
    (brand_id, event_id) among dedup CANDIDATES (see CANDIDATE_GUARD). Used for the no-op fast
    path and the post-delete zero-dupe recheck."""
    return f"""
    WITH keyed AS (
      SELECT {BRAND_EXPR} AS brand_id, {EVENT_EXPR} AS event_id
      FROM {fq}
      WHERE {CANDIDATE_GUARD}
    )
    SELECT count(*) FROM (
      SELECT brand_id, event_id FROM keyed
      GROUP BY brand_id, event_id HAVING count(*) > 1
    ) d JOIN keyed k USING (brand_id, event_id)
    """


def losers_sql(fq: str) -> str:
    """The targeted delete's plan half: the (kafka_partition, kafka_offset) coordinates of every
    NON-winning copy of a duplicated key. Keep-latest tie-break UNCHANGED from the original COW
    rewrite: highest (kafka_timestamp, kafka_offset, kafka_partition) wins (row_number() = 1);
    every row numbered > 1 is a loser. Only CANDIDATE_GUARD rows participate — NULL-keyed /
    NULL-coordinate rows are never selected, so they are never deleted."""
    return f"""
    SELECT kafka_partition, kafka_offset FROM (
      SELECT kafka_partition, kafka_offset,
             row_number() OVER (
               PARTITION BY {BRAND_EXPR}, {EVENT_EXPR}
               ORDER BY kafka_timestamp DESC, kafka_offset DESC, kafka_partition DESC
             ) AS rn,
             count(*) OVER (
               PARTITION BY {BRAND_EXPR}, {EVENT_EXPR}
             ) AS copies
      FROM {fq}
      WHERE {CANDIDATE_GUARD}
    )
    WHERE copies > 1 AND rn > 1
    """


def batch_losers(coords: "list[tuple[int, int]]", batch_size: int) -> "list[tuple[int, list[int]]]":
    """Group loser coordinates by kafka_partition and chunk the offsets into In-list batches of at
    most `batch_size` (one COW delete commit per batch). Deterministic (sorted partitions, sorted
    offsets) so retries/re-runs issue identical plans."""
    by_partition: "dict[int, list[int]]" = {}
    for part, off in coords:
        by_partition.setdefault(part, []).append(off)
    batches: "list[tuple[int, list[int]]]" = []
    for part in sorted(by_partition):
        offsets = sorted(by_partition[part])
        for i in range(0, len(offsets), batch_size):
            batches.append((part, offsets[i : i + batch_size]))
    return batches


def delete_expr(partition: int, offsets: "list[int]"):
    """The pyiceberg COW delete predicate for one batch: kafka_partition = p AND kafka_offset IN
    (…). Offset IN-lists per partition — never a per-pair OR-chain (which explodes at backlog
    size). (kafka_partition, kafka_offset) is unique per row on a single-topic lane, so this can
    never over-match a non-loser row."""
    from pyiceberg.expressions import And, EqualTo, In

    return And(EqualTo("kafka_partition", partition), In("kafka_offset", offsets))


def _metric_bounds(f: dict, col: str) -> "tuple[object, object] | None":
    """(lower, upper) bounds for `col` from a files-inspect row's readable_metrics, or None when
    the file carries no usable metrics for it (→ caller counts the file conservatively)."""
    metrics = f.get("readable_metrics") or {}
    m = metrics.get(col) or {}
    lo, hi = m.get("lower_bound"), m.get("upper_bound")
    if lo is None or hi is None:
        return None
    return lo, hi


def loser_file_bytes(tbl, coords: "list[tuple[int, int]]") -> int:
    """Upper-bound bytes the targeted COW delete rewrites: the sum of data-file sizes of every
    file whose (kafka_partition, kafka_offset) metric bounds could contain a loser coordinate —
    those are exactly the files tbl.delete may rewrite. A file without usable bounds is counted
    conservatively (assumed affected). This replaces the old day-span accounting: the valve now
    scales with the loser set, not with the day's total volume."""
    try:
        files = tbl.inspect.files().to_pylist()
    except ValueError:  # no manifests at all (empty current snapshot)
        return 0
    per_partition: "dict[int, list[int]]" = {}
    for part, off in coords:
        per_partition.setdefault(part, []).append(off)
    total = 0
    for f in files:
        if f["content"] != 0:  # data files only
            continue
        pb = _metric_bounds(f, "kafka_partition")
        ob = _metric_bounds(f, "kafka_offset")
        if pb is None or ob is None:
            total += f["file_size_in_bytes"]  # no usable metrics — conservative
            continue
        hit = False
        for part, offs in per_partition.items():
            if pb[0] <= part <= pb[1] and any(ob[0] <= off <= ob[1] for off in offs):
                hit = True
                break
        if hit:
            total += f["file_size_in_bytes"]
    return total


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
    (dup_rows,) = con.execute(dup_count_sql(fq)).fetchone()
    if not dup_rows:
        print(f"[bronze-dedup] {fq}: zero duplicate (brand_id, event_id) rows — no-op ✓", flush=True)
        return

    coords = [(int(p), int(o)) for p, o in con.execute(losers_sql(fq)).fetchall()]
    if not coords:
        # dup_rows > 0 but no targetable loser: cannot happen with the shared CANDIDATE_GUARD —
        # loud guard anyway (a silent return here would leave dupes unconverged).
        raise SystemExit(f"[bronze-dedup] INTERNAL: {dup_rows} dup rows but zero loser coordinates")

    n_bytes = loser_file_bytes(tbl, coords)
    print(
        f"[bronze-dedup] {fq}: {dup_rows} row(s) across duplicated keys; deleting {len(coords)} "
        f"loser row(s) by (kafka_partition, kafka_offset); affected-file bound ~{n_bytes}B",
        flush=True,
    )
    if n_bytes > MAX_REWRITE_BYTES and not FORCE:
        raise SystemExit(
            f"[bronze-dedup] REFUSED: affected files {n_bytes}B exceed BRONZE_DEDUP_MAX_REWRITE_BYTES="
            f"{MAX_REWRITE_BYTES} (COW memory valve). Bronze still holds duplicates — rerun with "
            f"BRONZE_DEDUP_FORCE=1 on a pod with headroom."
        )

    batches = batch_losers(coords, DELETE_BATCH)
    for i, (partition, offsets) in enumerate(batches, 1):
        print(
            f"[bronze-dedup] delete batch {i}/{len(batches)}: kafka_partition={partition}, "
            f"{len(offsets)} offset(s) …",
            flush=True,
        )
        # _maintenance_base.delete = COW tbl.delete (probe gate 3) with the seam's bounded
        # CommitFailedException retry (probe gate 6). Idempotent: a re-run matches 0 rows.
        mb.delete(cat, NAMESPACE, TABLE, delete_expr(partition, offsets))

    (remaining,) = con.execute(dup_count_sql(fq)).fetchone()
    if remaining:
        raise SystemExit(f"[bronze-dedup] FAILED: {remaining} duplicate row(s) remain after targeted delete")
    print(f"[bronze-dedup] DONE — {fq} is zero-duplicate on (brand_id, event_id) ✓", flush=True)


if __name__ == "__main__":
    main()
