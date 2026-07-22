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

MONTH-SCOPED, CHECKPOINTED (ADR-0018 D1, 2026-07-22). collector_events_connect is partitioned
`month(kafka_timestamp)` (AUD-IMPL-025). At production volume the whole-table dup-count / loser
scan + the all-or-nothing recheck (a run killed at batch 15/62 leaves NO durable checkpoint — the
next run re-scans the full 1.38M table and re-attempts the full backlog) never converged within
4–8 Gi. The fix: process ONE month-partition at a time, newest N first (BRONZE_DEDUP_MONTHS_BACK,
default 1 = current + previous month — covers a redelivery straddling a month boundary), and
RECHECK-AND-COMMIT each month before the next. A finished month is durable progress — an OOM in
month K leaves months <K deduped (the per-month recheck IS the checkpoint). 99%+ of dupes are in
the hot month (Kafka-Connect at-least-once redelivery lands the copy seconds-to-minutes after the
original, always the same month); frozen months are cleaned once and never re-touched. The month
predicate `kafka_timestamp >= TIMESTAMPTZ '<start>' AND < '<end>'` rides BOTH the dup-count/loser
SQL guard AND the COW delete expression (And(monthRange, EqualTo(kafka_partition,p),
In(kafka_offset,offsets))) so the delete's rewrite set is bounded to files in that one month and
the valve bounds a real, small set. Escape hatch: BRONZE_DEDUP_PARTITION_SCOPED=0 (+ FORCE=1) =
today's whole-table behavior, for a deliberate full-history backfill on a big pod.

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
BRONZE_DEDUP_FORCE, BRONZE_DEDUP_DELETE_BATCH, BRONZE_DEDUP_PARTITION_SCOPED,
BRONZE_DEDUP_MONTHS_BACK, BRONZE_DEDUP_PARTITION_COLUMN, plus the ICEBERG_REST_*/S3/AWS connection
seams in _maintenance_base.py).
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

# ADR-0018 D1 — month-partition scoping. ON (default): process one month-partition at a time,
# newest MONTHS_BACK first, recheck-and-commit each before the next (the checkpoint). OFF: today's
# whole-table behavior (whole-history backfill — pair with FORCE=1 on a big pod). MONTHS_BACK=1 is
# the current + previous calendar month, covering a redelivery straddling a month boundary.
PARTITION_SCOPED = os.environ.get("BRONZE_DEDUP_PARTITION_SCOPED", "1") == "1"
MONTHS_BACK = int(os.environ.get("BRONZE_DEDUP_MONTHS_BACK", "1"))
# The month-partition SOURCE column (AUD-IMPL-025: collector_events_connect is month(kafka_timestamp)).
# Env-overridable only so a differently-partitioned lane can point the scope at its own source.
PARTITION_COLUMN = os.environ.get("BRONZE_DEDUP_PARTITION_COLUMN", "kafka_timestamp")

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


def _scoped_guard(month_pred: "str | None") -> str:
    """CANDIDATE_GUARD, optionally AND-ed with a month-range predicate (D1 partition scoping). When
    month_pred is None the guard is the whole-table candidacy filter (PARTITION_SCOPED=0 path)."""
    if month_pred is None:
        return CANDIDATE_GUARD
    return f"{CANDIDATE_GUARD}\n        AND {month_pred}"


def dup_count_sql(fq: str, month_pred: "str | None" = None) -> str:
    """SQL over the live table: total row count across every copy of every duplicated
    (brand_id, event_id) among dedup CANDIDATES (see CANDIDATE_GUARD). Used for the no-op fast
    path and the post-delete zero-dupe recheck. `month_pred` (D1) scopes both the count and the
    recheck to one month-partition so an OOM in a later month never invalidates an earlier
    committed month's checkpoint."""
    return f"""
    WITH keyed AS (
      SELECT {BRAND_EXPR} AS brand_id, {EVENT_EXPR} AS event_id
      FROM {fq}
      WHERE {_scoped_guard(month_pred)}
    )
    SELECT count(*) FROM (
      SELECT brand_id, event_id FROM keyed
      GROUP BY brand_id, event_id HAVING count(*) > 1
    ) d JOIN keyed k USING (brand_id, event_id)
    """


def losers_sql(fq: str, month_pred: "str | None" = None) -> str:
    """The targeted delete's plan half: the (kafka_partition, kafka_offset) coordinates of every
    NON-winning copy of a duplicated key. Keep-latest tie-break UNCHANGED from the original COW
    rewrite: highest (kafka_timestamp, kafka_offset, kafka_partition) wins (row_number() = 1);
    every row numbered > 1 is a loser. Only CANDIDATE_GUARD rows participate — NULL-keyed /
    NULL-coordinate rows are never selected, so they are never deleted. `month_pred` (D1) scopes
    the plan to one month-partition — the window (PARTITION BY key) sees only that month's copies,
    which is correct because a redelivery lands in the SAME month as its original (the tie-break's
    kafka_timestamp is what defines the month), so no cross-month winner is ever mis-elected."""
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
      WHERE {_scoped_guard(month_pred)}
    )
    WHERE copies > 1 AND rn > 1
    """


# ── D1 month-partition scoping ───────────────────────────────────────────────────────────────────


def _month_start(value) -> "datetime":
    """Normalize a `month(...)` partition value from inspect.files() into its [start) datetime. The
    same two shapes _maintenance_base._rewrite_units handles: an int (months since 1970-01, the
    spec's epoch-relative encoding) or a date-like object (has .year/.month)."""
    from datetime import datetime, timezone

    if isinstance(value, int):
        years, months = divmod(int(value), 12)
        return datetime(1970 + years, months + 1, 1, tzinfo=timezone.utc)
    return datetime(value.year, value.month, 1, tzinfo=timezone.utc)


def _month_end(start: "datetime") -> "datetime":
    from datetime import datetime, timezone

    if start.month == 12:
        return datetime(start.year + 1, 1, 1, tzinfo=timezone.utc)
    return datetime(start.year, start.month + 1, 1, tzinfo=timezone.utc)


def month_partitions(tbl, pf_name: str = "kafka_timestamp_month") -> "list[datetime]":
    """The distinct month-partition [start) datetimes present in the table's live data files,
    ASCENDING. Reads the same `partition` dict off each files-inspect row that
    _maintenance_base._rewrite_units reads at :354. `pf_name` is the PARTITION FIELD name (Iceberg
    defaults a month() transform to '<source>_month'); a value shape we can't normalize (bucket /
    unpartitioned) is skipped, so an unpartitioned table yields [] → caller falls back to
    whole-table. Empty current snapshot / no manifests → [] (nothing to dedup)."""
    try:
        files = tbl.inspect.files().to_pylist()
    except ValueError:  # no manifests at all (empty current snapshot)
        return []
    starts: "set[datetime]" = set()
    for f in files:
        if f["content"] != 0:  # data files only
            continue
        value = (f.get("partition") or {}).get(pf_name)
        if value is None:
            continue
        try:
            starts.add(_month_start(value))
        except (AttributeError, TypeError, ValueError):
            continue  # non-month partition value (bucket/truncate) — not scopable
    return sorted(starts)


def newest_months(tbl, months_back: int, pf_name: str = "kafka_timestamp_month") -> "list[datetime]":
    """The newest `months_back` month-partition starts present in the table, ASCENDING (oldest of
    the selected window first, so the checkpoint marches oldest→newest — a kill mid-window still
    leaves the older selected months durably deduped). months_back<=0 → the single newest month."""
    months = month_partitions(tbl, pf_name)
    if not months:
        return []
    take = max(1, months_back)
    return months[-take:]


def month_pred_sql(col: str, start: "datetime", end: "datetime") -> str:
    """The half-open [start, end) DuckDB predicate on the timestamptz source column — same tstz
    literal shape _maintenance_base._temporal_unit builds for a MonthTransform source."""
    return f"{col} >= TIMESTAMPTZ '{start.isoformat()}' AND {col} < TIMESTAMPTZ '{end.isoformat()}'"


def month_range_expr(col: str, start: "datetime", end: "datetime"):
    """The pyiceberg [start, end) range expression on the timestamptz source column — rides the COW
    delete so the rewrite set is scoped to that one month's files."""
    from pyiceberg.expressions import And, GreaterThanOrEqual, LessThan

    return And(GreaterThanOrEqual(col, start.isoformat()), LessThan(col, end.isoformat()))


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


def delete_expr(partition: int, offsets: "list[int]", month_expr=None):
    """The pyiceberg COW delete predicate for one batch: kafka_partition = p AND kafka_offset IN
    (…). Offset IN-lists per partition — never a per-pair OR-chain (which explodes at backlog
    size). (kafka_partition, kafka_offset) is unique per row on a single-topic lane, so this can
    never over-match a non-loser row. When `month_expr` is supplied (D1 partition scoping) the
    delete is further AND-ed with the month [start,end) range → And(monthRange, EqualTo(part),
    In(offsets)) — so the COW rewrite touches only files in that one month, bounding the valve."""
    from pyiceberg.expressions import And, EqualTo, In

    coord = And(EqualTo("kafka_partition", partition), In("kafka_offset", offsets))
    return And(month_expr, coord) if month_expr is not None else coord


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


def dedup_scope(cat, con, tbl, fq, label: str, month_pred: "str | None", month_expr) -> None:
    """Dedup ONE scope — whole-table (month_pred/month_expr None) or one month-partition. Plans the
    losers within the scope, applies the COW deletes (each with the scope's month range on the
    delete expression so the rewrite set is bounded), then RECHECKS the scope. A raised
    SystemExit here (valve refusal or a post-recheck remainder) propagates — under the D1 loop that
    leaves every EARLIER already-committed month durably deduped (the checkpoint). Idempotent: a
    scope already clean is a fast no-op."""
    (dup_rows,) = con.execute(dup_count_sql(fq, month_pred)).fetchone()
    if not dup_rows:
        print(f"[bronze-dedup] {fq} [{label}]: zero duplicate (brand_id, event_id) rows — no-op ✓", flush=True)
        return

    coords = [(int(p), int(o)) for p, o in con.execute(losers_sql(fq, month_pred)).fetchall()]
    if not coords:
        # dup_rows > 0 but no targetable loser: cannot happen with the shared CANDIDATE_GUARD —
        # loud guard anyway (a silent return here would leave dupes unconverged).
        raise SystemExit(f"[bronze-dedup] INTERNAL: {dup_rows} dup rows but zero loser coordinates in [{label}]")

    n_bytes = loser_file_bytes(tbl, coords)
    print(
        f"[bronze-dedup] {fq} [{label}]: {dup_rows} row(s) across duplicated keys; deleting "
        f"{len(coords)} loser row(s) by (kafka_partition, kafka_offset); affected-file bound ~{n_bytes}B",
        flush=True,
    )
    if n_bytes > MAX_REWRITE_BYTES and not FORCE:
        raise SystemExit(
            f"[bronze-dedup] REFUSED [{label}]: affected files {n_bytes}B exceed "
            f"BRONZE_DEDUP_MAX_REWRITE_BYTES={MAX_REWRITE_BYTES} (COW memory valve). Bronze still holds "
            f"duplicates — rerun with BRONZE_DEDUP_FORCE=1 on a pod with headroom."
        )

    batches = batch_losers(coords, DELETE_BATCH)
    for i, (partition, offsets) in enumerate(batches, 1):
        print(
            f"[bronze-dedup] [{label}] delete batch {i}/{len(batches)}: kafka_partition={partition}, "
            f"{len(offsets)} offset(s) …",
            flush=True,
        )
        # _maintenance_base.delete = COW tbl.delete (probe gate 3) with the seam's bounded
        # CommitFailedException retry (probe gate 6). Idempotent: a re-run matches 0 rows.
        mb.delete(cat, NAMESPACE, TABLE, delete_expr(partition, offsets, month_expr))

    (remaining,) = con.execute(dup_count_sql(fq, month_pred)).fetchone()
    if remaining:
        raise SystemExit(
            f"[bronze-dedup] FAILED [{label}]: {remaining} duplicate row(s) remain after targeted delete"
        )
    print(f"[bronze-dedup] DONE [{label}] — zero-duplicate on (brand_id, event_id) ✓", flush=True)


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

    if not PARTITION_SCOPED:
        # Whole-table backfill (escape hatch — deliberate full-history clear on a big pod; pair with
        # BRONZE_DEDUP_FORCE=1). One scope, no month predicate.
        print(f"[bronze-dedup] {fq}: PARTITION_SCOPED=0 — whole-table dedup (backfill path)", flush=True)
        dedup_scope(cat, con, tbl, fq, "whole-table", None, None)
        print(f"[bronze-dedup] DONE — {fq} is zero-duplicate on (brand_id, event_id) ✓", flush=True)
        return

    # ADR-0018 D1: month-scoped, checkpointed. Process the newest MONTHS_BACK month-partitions
    # oldest→newest; RECHECK-AND-COMMIT each month before the next. A kill in month K leaves months
    # <K durably deduped (the per-month recheck is the checkpoint); the next run finds them clean.
    pf_name = f"{PARTITION_COLUMN}_month"  # Iceberg month() default partition-field name
    months = newest_months(tbl, MONTHS_BACK, pf_name)
    if not months:
        # Not month-partitioned (or empty) — degrade to a single whole-table scope so a lane whose
        # partition transform we can't scope still converges rather than silently no-op'ing.
        print(
            f"[bronze-dedup] {fq}: no month partitions found on '{pf_name}' — whole-table scope",
            flush=True,
        )
        dedup_scope(cat, con, tbl, fq, "whole-table", None, None)
        print(f"[bronze-dedup] DONE — {fq} is zero-duplicate on (brand_id, event_id) ✓", flush=True)
        return

    print(
        f"[bronze-dedup] {fq}: month-scoped (MONTHS_BACK={MONTHS_BACK}) over "
        f"{[m.date().isoformat() for m in months]}",
        flush=True,
    )
    for start in months:
        end = _month_end(start)
        label = start.strftime("%Y-%m")
        month_pred = month_pred_sql(PARTITION_COLUMN, start, end)
        month_expr = month_range_expr(PARTITION_COLUMN, start, end)
        dedup_scope(cat, con, tbl, fq, label, month_pred, month_expr)
    print(
        f"[bronze-dedup] DONE — {fq} zero-duplicate on (brand_id, event_id) across "
        f"{len(months)} hot month(s) ✓",
        flush=True,
    )


if __name__ == "__main__":
    main()
