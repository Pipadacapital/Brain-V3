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


def _parse_columns_sql(columns_sql: str) -> list[tuple[str, str]]:
    """Parse a COLUMNS_SQL block into [(name, type_without_constraints), ...].

    Handles trailing commas, blank lines, and `NOT NULL` on each column line.
    Type = everything after the name up to (and excluding) NOT/DEFAULT/comment.
    """
    out: list[tuple[str, str]] = []
    for raw in columns_sql.split(","):
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


def run_job(job_name: str, build_fn, *, target_table: str) -> None:
    """
    Thin runner: connect → build(con) → advance watermark → structured log line.
    build_fn(con) does the read+transform+MERGE and returns the upserted row count (or None).
    """
    t0 = time.time()
    con = connect()
    try:
        upserted = build_fn(con)
        # Advance the watermark to the max source ingested_at now visible (best-effort, non-fatal).
        try:
            hi = con.execute(f"SELECT max(ingested_at) FROM {GATED_SOURCE}").fetchone()[0]
            if hi is not None:
                write_watermark(con, job_name, hi)
        except Exception:  # noqa: BLE001
            pass
        dt = time.time() - t0
        print(f'{{"job":"{job_name}","target":"{target_table}","upserted":{upserted or 0},'
              f'"seconds":{dt:.2f},"engine":"duckdb"}}', flush=True)
    finally:
        con.close()


ENV_JOB_ONLY = os.environ.get("DUCKDB_JOB_ONLY", "")  # reserved for a future single-job compose wrapper
