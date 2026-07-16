"""
_base.py — the shared DuckDB transform framework (Spark→DuckDB migration).

The DuckDB analogue of db/iceberg/spark/_silver_base.py + iceberg_base.py: the ONE place that
holds the read/MERGE/watermark discipline every ported job reuses, so each job file is just
(a) its Bronze/Silver event filter, (b) its payload→column projection SQL, (c) its PK.

It preserves the Spark jobs' HARD invariants verbatim:
  - reads the gated keystone rest.brain_silver.silver_collector_event (ADR-0006 P3), same as Spark.
  - `prop(col, path)` = get_json_object(payload, '$.properties.<path>')  →  json_extract_string.
  - idempotent MERGE on the entity PK, dedup-in-batch latest-ingested-wins (replay-safe).
  - brand_id first; money BIGINT minor units + currency_code (never a float).
  - watermark in the SAME rest.brain_silver.silver_job_watermark Iceberg table (parity, not a new PG table).
"""
from __future__ import annotations

import os
import time
from datetime import timedelta

from _catalog import CATALOG, SILVER_NAMESPACE, connect, fqtn  # noqa: F401

# The gated keystone every Silver entity job reads (identical to the Spark _silver_base BRONZE_TABLE).
GATED_SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
WATERMARK_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_job_watermark"


def prop(col: str, path: str) -> str:
    """payload.properties.<path> as a string — DuckDB equivalent of get_json_object(pj,'$.properties.…')."""
    return f"json_extract_string({col}, '$.properties.{path}')"


def json_str(col: str, path: str) -> str:
    """payload.<path> (top-level, not under properties) as a string."""
    return f"json_extract_string({col}, '$.{path}')"


def read_gated_events_sql(event_types: list[str], *, lo=None, hi=None, source: str | None = None) -> str:
    """
    A SELECT over the gated keystone for the given event_type(s), exposing the canonical columns
    plus `pj` (the payload) for json extraction — the exact shape Spark's read_bronze_events returns.
    Optional [lo, hi) ingested_at window (incremental) mirrors _CURRENT_WINDOW.
    """
    src = source or GATED_SOURCE
    in_list = ", ".join(f"'{e}'" for e in event_types)
    where = [f"event_type IN ({in_list})"]
    if lo is not None:
        where.append(f"ingested_at >= TIMESTAMP '{lo}'")
    if hi is not None:
        where.append(f"ingested_at < TIMESTAMP '{hi}'")
    return (
        "SELECT brand_id, event_id, event_type, occurred_at, ingested_at, payload AS pj "
        f"FROM {src} WHERE " + " AND ".join(where)
    )


def _split_top_level_commas(columns_sql: str) -> list[str]:
    """Split a COLUMNS_SQL block on commas at paren-depth 0 ONLY — commas inside a composite
    type like `struct(step bigint, from_channel string)[]` or `decimal(10,2)` are part of the
    TYPE, not column separators. A naive split invents phantom columns from the struct fields,
    and the evolution loop then ALTER-ADDs garbage (`ADD COLUMN to_channel string)[]` → parser
    error; seen live on gold_journey_paths 2026-07-15)."""
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    for ch in columns_sql:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append("".join(buf))
    return parts


def _parse_columns_sql(columns_sql: str) -> list[tuple[str, str]]:
    """Parse a COLUMNS_SQL block into [(name, type_without_constraints), ...].

    Handles trailing commas, blank lines, and `NOT NULL` on each column line.
    Type = everything after the name up to (and excluding) NOT/DEFAULT/comment.
    """
    out: list[tuple[str, str]] = []
    for raw in _split_top_level_commas(columns_sql):
        line = raw.strip()
        if not line or line.startswith("--") or line.startswith(")"):
            continue
        toks = line.split()
        if len(toks) < 2:
            continue
        name = toks[0]
        # type is toks[1:] until a constraint keyword
        typ_parts = []
        for t in toks[1:]:
            if t.upper() in ("NOT", "NULL", "DEFAULT", "PRIMARY", "--"):
                break
            typ_parts.append(t)
        out.append((name, " ".join(typ_parts)))
    return out


def ensure_table(con, fq: str, columns_sql: str, *, partitioned_by: str | None = None) -> None:
    """
    CREATE TABLE IF NOT EXISTS in the attached Iceberg catalog, then ADDITIVELY EVOLVE it — any
    column declared in columns_sql that is absent from an existing table is ALTER-ADDed (data
    preserving; new column is NULL on old rows). This mirrors the Spark jobs' _add_missing_columns/
    _evolve_schema behavior so a DuckDB port carrying a wider (firehose) schema can widen a narrower
    pre-existing Spark-produced table instead of binder-erroring on the MERGE. Column DDL uses
    Iceberg/Spark type names (string/bigint/timestamp); partitioned_by mirrors the Spark hidden
    partitioning (e.g. 'bucket(256, brand_id), day(occurred_at)').
    """
    ddl = f"CREATE TABLE IF NOT EXISTS {fq} (\n{columns_sql}\n)"
    if partitioned_by:
        ddl += f" PARTITIONED BY ({partitioned_by})"
    con.execute(ddl + ";")

    # Additive schema evolution: ADD COLUMN for any declared column the live table lacks.
    try:
        existing = {d[0].lower() for d in con.execute(f"SELECT * FROM {fq} LIMIT 0").description}
    except Exception:  # noqa: BLE001 — table just created / unreadable → nothing to evolve
        return
    for name, typ in _parse_columns_sql(columns_sql):
        if name.lower() not in existing and typ:
            # NOT NULL is intentionally dropped on ADD (old rows would violate it).
            con.execute(f"ALTER TABLE {fq} ADD COLUMN {name} {typ};")


def merge_on_pk(con, target: str, staged_sql: str, columns: list[str], pk: list[str],
                *, order_by_desc: list[str]) -> int:
    """
    Idempotent MERGE of `staged_sql` (a SELECT producing exactly `columns`) into `target` on `pk`.

    Dedups within the batch (row_number over PK by order_by_desc, keep #1 — a re-pull can emit the
    same PK twice), then MERGE: WHEN MATCHED UPDATE the non-PK columns, WHEN NOT MATCHED INSERT —
    the Spark merge_on_pk discipline, replay-safe (latest-ingested-wins). Returns the upserted count.
    """
    part = ", ".join(pk)
    order = ", ".join(f"{c} DESC" for c in order_by_desc)
    collist = ", ".join(columns)
    deduped = (
        f"SELECT {collist} FROM (SELECT *, row_number() OVER (PARTITION BY {part} ORDER BY {order}) "
        f"AS _rn FROM ({staged_sql})) WHERE _rn = 1"
    )
    non_pk = [c for c in columns if c not in pk]
    set_clause = ", ".join(f"{c} = s.{c}" for c in non_pk)
    on_clause = " AND ".join(f"t.{c} = s.{c}" for c in pk)
    ins_vals = ", ".join(f"s.{c}" for c in columns)
    n = con.execute(f"SELECT count(*) FROM ({deduped})").fetchone()[0]
    con.execute(
        f"""
        MERGE INTO {target} t
        USING ({deduped}) s
        ON {on_clause}
        WHEN MATCHED THEN UPDATE SET {set_clause}
        WHEN NOT MATCHED THEN INSERT ({collist}) VALUES ({ins_vals});
        """
    )
    return n


# ── Incremental reads (opt-in, default OFF) ───────────────────────────────────────────────────────────
# SILVER_INCREMENTAL=1 turns on watermark-windowed reads for jobs that call incremental_window().
# FULL_REFRESH=1 forces a full pass even when incremental is on (backfill / schema-widen / recovery — the
# entity-incremental FULL_REFRESH gotcha: widening a fold job's reads must re-fold ALL history once).
# Default (both unset) → (None, hi): a full scan, byte-identical to the pre-incremental behavior.
def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() not in ("", "0", "false", "no")


INCREMENTAL = _flag("SILVER_INCREMENTAL")
# GOLD_INCREMENTAL gates the Gold tier INDEPENDENTLY of Silver (Phase 1b): Gold marts read Silver/Gold
# marts, so they must be validatable + flippable separately from SILVER_INCREMENTAL (which is already ON in
# prod). A Gold job passes `enabled=GOLD_INCREMENTAL` to incremental_window; Silver jobs use the default.
GOLD_INCREMENTAL = _flag("GOLD_INCREMENTAL")
FULL_REFRESH = _flag("FULL_REFRESH")
# Trailing safety lookback: re-scan [watermark - lookback, hi) each run so a slightly out-of-order arrival
# (Kafka timestamps across partitions; a lagging producer clock) can never be skipped by an advanced
# watermark. The idempotent MERGE makes the re-scanned overlap free of duplicates — only extra CPU, never
# lost or doubled rows. Default 10 min; 0 disables the margin.
LOOKBACK_SECONDS = int(os.environ.get("WATERMARK_LOOKBACK_SECONDS", "600") or "600")

# The batch hi pinned by run_job for the duration of one job process (race-safe read/advance bound).
_CURRENT_HI = None


def incremental_window(con, job_name: str, source_table: str, ts_col: str = "ingested_at",
                       *, enabled: bool | None = None):
    """Return (lo, hi) `ts_col` bounds for an incremental read of `source_table`, or (None, None) for a full
    scan.

    HARD INVARIANT: `lo is None` IFF `hi is None` IFF a full scan. `hi` is meaningful ONLY as the upper edge
    of a real window, so it is returned non-None ONLY alongside a non-None `lo`. This makes the default
    (incremental off) path emit NO predicate at all → byte-identical to the pre-incremental full scan. (The
    watermark advance does NOT depend on this return: run_job pins `_CURRENT_HI` independently, so a
    full-scan run still advances the watermark to the batch max — a later flip to incremental picks up
    cleanly from there.)

    `enabled` selects the tier gate: None (default) → SILVER_INCREMENTAL (Silver jobs); a Gold job passes
    `enabled=GOLD_INCREMENTAL` so the two tiers flip independently. FULL_REFRESH forces a full pass for
    either tier.

    Full scan (returns None, None) when: the tier gate is off, FULL_REFRESH is on, the source is missing, OR
    this job has no prior watermark (first run → full-scan bootstrap). Otherwise lo = (last committed
    watermark − LOOKBACK_SECONDS) and hi = the batch max `ts_col` pinned by run_job, a half-open [lo, hi)
    window (the lookback re-admits a trailing margin; the idempotent MERGE dedups it). `ts_col` is
    `ingested_at` for entity jobs reading the gated keystone, but `kafka_timestamp` for the keystone job
    reading Bronze collector_events_connect (which has no lifted ingested_at column).

    Per-event jobs pass (lo, hi) straight into their source WHERE. Entity-fold jobs use the window only to
    discover CHANGED entity ids, then re-fold each changed entity's full history (never window the fold
    input directly — that would drop below-watermark rows).
    """
    active = INCREMENTAL if enabled is None else enabled
    if not active or FULL_REFRESH:
        return None, None
    lo = read_watermark(con, job_name)
    if lo is None:
        return None, None  # first run → full-scan bootstrap (run_job still advances the watermark)
    # run_job pins the batch's hi ONCE (before build) so the read bound and the watermark advance are the
    # SAME value — a row landing mid-run is captured by the NEXT window, never skipped. Fall back to a live
    # max() when called outside run_job (e.g. a unit harness).
    hi = _CURRENT_HI
    if hi is None:
        try:
            hi = con.execute(f"SELECT max({ts_col}) FROM {source_table}").fetchone()[0]
        except Exception:  # noqa: BLE001 — source not created yet
            return None, None
    if LOOKBACK_SECONDS > 0:
        lo = lo - timedelta(seconds=LOOKBACK_SECONDS)
    return lo, hi


def read_watermark(con, job_name: str):
    """Last SOURCE ingested_at this job processed, or None (first run / table absent → full pass)."""
    try:
        row = con.execute(
            f"SELECT last_ingested_at FROM {WATERMARK_TABLE} WHERE job_name = ?", [job_name]
        ).fetchone()
        return row[0] if row else None
    except Exception:  # noqa: BLE001 — table not created yet → first run
        return None


def write_watermark(con, job_name: str, ts) -> None:
    ensure_table(
        con, WATERMARK_TABLE,
        "  job_name string NOT NULL,\n  last_ingested_at timestamp,\n  updated_at timestamp",
    )
    con.execute(
        f"""
        MERGE INTO {WATERMARK_TABLE} t
        USING (SELECT ? AS job_name, CAST(? AS TIMESTAMP) AS last_ingested_at, now() AS updated_at) s
        ON t.job_name = s.job_name
        WHEN MATCHED THEN UPDATE SET last_ingested_at = s.last_ingested_at, updated_at = s.updated_at
        WHEN NOT MATCHED THEN INSERT (job_name, last_ingested_at, updated_at)
          VALUES (s.job_name, s.last_ingested_at, s.updated_at);
        """,
        [job_name, ts],
    )


def run_job(job_name: str, build_fn, *, target_table: str, source_table: str = GATED_SOURCE,
            ts_col: str = "ingested_at") -> None:
    """
    Thin runner: connect → pin batch hi → build(con) → advance watermark → structured log line.
    build_fn(con) does the read+transform+MERGE and returns the upserted row count (or None).

    `source_table`/`ts_col` name the column whose max the watermark tracks — `ingested_at` on the GATED
    keystone for entity jobs, but `kafka_timestamp` on Bronze `collector_events_connect` for the keystone
    job itself. The hi is pinned ONCE here (before build) so an incremental build's read bound and the
    watermark advance are the SAME value, and a row landing mid-run is picked up by the next window rather
    than skipped.
    """
    global _CURRENT_HI
    t0 = time.time()
    con = connect()
    try:
        try:
            _CURRENT_HI = con.execute(f"SELECT max({ts_col}) FROM {source_table}").fetchone()[0]
        except Exception:  # noqa: BLE001 — source not created yet → full pass, no advance
            _CURRENT_HI = None
        upserted = build_fn(con)
        # Advance the watermark to the SAME pinned hi the build read up to (best-effort, non-fatal).
        try:
            if _CURRENT_HI is not None:
                write_watermark(con, job_name, _CURRENT_HI)
        except Exception:  # noqa: BLE001
            pass
        dt = time.time() - t0
        print(f'{{"job":"{job_name}","target":"{target_table}","upserted":{upserted or 0},'
              f'"seconds":{dt:.2f},"engine":"duckdb"}}', flush=True)
    finally:
        _CURRENT_HI = None
        con.close()


ENV_JOB_ONLY = os.environ.get("DUCKDB_JOB_ONLY", "")  # reserved for a future single-job compose wrapper
