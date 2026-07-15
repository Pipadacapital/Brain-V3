"""
_normalize_base.py (DuckDB) — the shared seam for the 7 raw→canonical *_normalize ports.

These jobs are STRUCTURALLY different from the entity marts in _base.py: they read a RAW per-provider Bronze
lane (the ADR-0010 Kafka-Connect `<lane>_raw_connect` table — NOT the gated keystone), reconstruct the
canonical silver_collector_event 14-column envelope in `payload`, and MERGE into a *_shadow table (dual-run
parity, ADR-0006 P4). This module holds the parts every one of the 7 reuses so each job is just its
field-mapping SQL:

  - connect_source_table(lane)            → the ADR-0010 `<lane>_raw_connect` FQTN.
  - source_present(con, lane)             → the Connect sink AUTO-CREATES a lane's table on its FIRST record,
                                            so a never-produced lane has NO table → the DuckDB analogue of the
                                            Spark read_bronze empty-frame skip-guard.
  - register_salts(con)                   → (brand_id, salt_hex) VIEW `_salts` from PG tenancy.brand via the
                                            postgres extension (the DuckDB analogue of the Spark _load_salts
                                            JDBC read). A LEFT-join MISS leaves salt_hex NULL — the hash UDF
                                            then renders it as the literal "None" (Spark-UDF parity, verified
                                            against the live shopify shadow oracle). PG unreachable → empty
                                            view (every brand misses → salt NULL, identical to a full JDBC miss).
  - COLLECTOR_COLUMNS / COLLECTOR_COLUMNS_SQL → the 14-column contract (identical to the Spark COLUMNS_SQL).
  - ensure_shadow(con, target)            → CREATE TABLE IF NOT EXISTS with the Spark hidden partitioning.
  - merge_collector_event(con, target, good_sql) → the keystone-mirrored idempotent MERGE
                                            (dedup-latest-ingested in batch, WHEN MATCHED payload-changed →
                                            bump silver_version, WHEN NOT MATCHED INSERT).
  - run_normalize_job(name, build_fn, target_table) → thin runner → structured JSON log.

Timestamps are plain `timestamp` (UTC session set in _catalog.connect); money is BIGINT minor + currency_code.
The silver_quarantine / consent side-writes are SKIPPED (parity-preserving, per the migration rule — Bronze
keeps the originals so the diagnostic ledgers can be rebuilt separately; the good-row set is byte-identical).
"""
from __future__ import annotations

import os
import time

from _catalog import BRONZE_NAMESPACE, CATALOG, SILVER_NAMESPACE, connect

# Reuse the incremental machinery from _base (flag/lookback/watermark) so normalize jobs share the exact
# same SILVER_INCREMENTAL / FULL_REFRESH / WATERMARK_LOOKBACK_SECONDS semantics as the entity jobs.
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _base import INCREMENTAL as _INCREMENTAL, FULL_REFRESH as _FULL_REFRESH, LOOKBACK_SECONDS as _LOOKBACK  # noqa: E402
from _base import read_watermark, write_watermark  # noqa: E402
from datetime import timedelta as _timedelta  # noqa: E402

# The 14-column silver_collector_event contract (identical to every Spark normalize job's COLUMNS_SQL).
COLLECTOR_COLUMNS_SQL = """
  event_id          string    NOT NULL,
  brand_id          string    NOT NULL,
  occurred_at       timestamp NOT NULL,
  ingested_at       timestamp NOT NULL,
  schema_name       string    NOT NULL,
  schema_version    int       NOT NULL,
  event_type        string    NOT NULL,
  event_category    string,
  correlation_id    string,
  partition_key     string    NOT NULL,
  anonymous_id      string,
  device_id         string,
  silver_version    int,
  payload           string    NOT NULL
""".strip("\n")

COLLECTOR_COLUMNS = [
    "event_id", "brand_id", "occurred_at", "ingested_at", "schema_name", "schema_version",
    "event_type", "event_category", "correlation_id", "partition_key", "anonymous_id", "device_id",
    "silver_version", "payload",
]

# Per-brand salt SoR (dev-derivable; prod reads the KMS-unwrapped salt). Mirrors the Spark _load_salts query
# so the PII hash matches. The run scripts may export SALT_QUERY="" (empty) → fall back to the dev query.
PG_JDBC_URL = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://localhost:5432/brain")
PG_USER = os.environ.get("BRONZE_PG_USER", "brain")
PG_PASSWORD = os.environ.get("BRONZE_PG_PASSWORD", "brain")
_DEV_SALT_QUERY = (
    "SELECT id::text AS brand_id, "
    "encode(sha256(('brain-dev-identity-salt-v1||'||lower(id::text))::bytea),'hex') AS salt_hex "
    "FROM tenancy.brand"
)


def connect_source_table(lane_table: str) -> str:
    """FQTN of a lane's raw source: the ADR-0010 Connect-written `<lane>_connect` table."""
    return f"{CATALOG}.{BRONZE_NAMESPACE}.{lane_table}_connect"


def lane_window(con, job_name: str, lane_table: str):
    """Return (lo, hi) `kafka_timestamp` bounds for an INCREMENTAL read of a raw Connect lane, or
    (None, hi) for a full scan — the normalize-tier analogue of _base.incremental_window.

    Raw lanes have no lifted ingested_at; their physical arrival clock is `kafka_timestamp`. The watermark
    is keyed PER (job, lane) — f"{job_name}:{lane_table}" — so a multi-lane normalize job (e.g. ad-spend =
    meta + google) tracks each lane independently and a lagging lane is never skipped by the other's max.

    Full scan (lo=None) when SILVER_INCREMENTAL is off, FULL_REFRESH is on, or the lane has no prior
    watermark (first run). Otherwise lo = (watermark − LOOKBACK) as a half-open [lo, hi) window; the
    idempotent merge_collector_event dedups the trailing overlap. `hi` is pinned here (computed once) so the
    caller uses the SAME value for the read predicate AND advance_lane_watermark → a row landing mid-run is
    caught by the next window, never skipped."""
    # `hi` is pinned ONCE here (before the read) and used for BOTH the predicate and advance_lane_watermark,
    # so a row landing mid-run is excluded now and re-read next run (race-safe). Unlike the gated path,
    # normalize jobs have no independent run_job _CURRENT_HI advance — they MUST advance the watermark to
    # this `hi` even on a full-scan/bootstrap run (else the lane never leaves full-scan). Safe to return a
    # non-None hi in the full-scan case because lane_window_predicate() gates the hi bound on `lo` (a full
    # scan emits NO predicate), so hi never leaks into the default read.
    try:
        hi = con.execute(
            f"SELECT max(kafka_timestamp) FROM {connect_source_table(lane_table)}"
        ).fetchone()[0]
    except Exception:  # noqa: BLE001 — lane table absent → nothing to read
        return None, None
    if not _INCREMENTAL or _FULL_REFRESH:
        return None, hi  # full scan (predicate empty via lo=None) but still advance the watermark to hi
    key = f"{job_name}:{lane_table}"
    lo = read_watermark(con, key)
    if lo is None:
        return None, hi  # first run for this lane → full-scan bootstrap; advance sets the initial watermark
    if _LOOKBACK > 0:
        lo = lo - _timedelta(seconds=_LOOKBACK)
    return lo, hi


def lane_window_predicate(lo, hi) -> str:
    """The `WHERE kafka_timestamp ...` clause for a lane read, or '' for a full scan (lo=None). String
    literals keep the predicate pushable to the Iceberg scan on the raw lane's kafka_timestamp column."""
    parts = []
    if lo is not None:
        parts.append(f"kafka_timestamp >= '{lo}'")
    if hi is not None and lo is not None:
        parts.append(f"kafka_timestamp <= '{hi}'")
    return f"WHERE {' AND '.join(parts)}" if parts else ""


def advance_lane_watermark(con, job_name: str, lane_table: str, hi) -> None:
    """Advance the per-(job, lane) watermark to the SAME `hi` the read used (best-effort, non-fatal)."""
    if hi is None:
        return
    try:
        write_watermark(con, f"{job_name}:{lane_table}", hi)
    except Exception:  # noqa: BLE001 — watermark advance must never fail the job
        pass


def source_present(con, lane_table: str) -> bool:
    """True iff the lane's `<lane>_connect` table EXISTS and carries ≥1 row.

    The Connect sink auto-creates a lane's table on its FIRST record, so a never-produced lane has NO table
    at all → the DuckDB analogue of the Spark read_bronze empty-placeholder skip-guard (return cleanly)."""
    tbl = f"{lane_table}_connect"
    exists = con.execute(
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_schema = ? AND table_name = ?",
        [BRONZE_NAMESPACE, tbl],
    ).fetchone()[0]
    if not exists:
        return False
    return con.execute(f"SELECT count(*) FROM {connect_source_table(lane_table)}").fetchone()[0] > 0


def _jdbc_to_libpq(jdbc_url: str) -> str:
    rest = jdbc_url.replace("jdbc:postgresql://", "").replace("postgresql://", "")
    hostport, _, dbname = rest.partition("/")
    dbname = (dbname.split("?")[0] or "brain")
    host, _, port = hostport.partition(":")
    return " ".join([
        f"host={host or 'localhost'}", f"port={port or '5432'}", f"dbname={dbname}",
        f"user={PG_USER}", f"password={PG_PASSWORD}",
    ])


def register_salts(con) -> bool:
    """Register the `_salts` (brand_id, salt_hex) view for the PII hash LEFT-join.

    Reads PG tenancy.brand via the postgres extension (the DuckDB analogue of the Spark _load_salts JDBC read),
    running the salt SQL ON THE PG SIDE via postgres_query (PG's encode(...,'hex') differs from DuckDB's, so it
    must be pushed down). On ANY failure (extension missing / PG unreachable) registers an EMPTY typed view —
    every brand then MISSES the LEFT join → salt_hex NULL, identical to a full JDBC miss (the hash UDF renders
    NULL as the literal 'None', Spark-UDF parity). Best-effort, non-fatal."""
    query = os.environ.get("SALT_QUERY") or _DEV_SALT_QUERY
    try:
        con.execute("INSTALL postgres; LOAD postgres;")
        dsn = _jdbc_to_libpq(PG_JDBC_URL)
        con.execute(f"ATTACH IF NOT EXISTS '{dsn}' AS _pg (TYPE postgres, READ_ONLY);")
        con.execute("SELECT 1 FROM pg_catalog.pg_class LIMIT 1;")  # probe: unreachable fails HERE
        con.execute(
            "CREATE OR REPLACE TEMP VIEW _salts AS "
            f"SELECT brand_id, salt_hex FROM postgres_query('_pg', $$ {query} $$)"
        )
        n = con.execute("SELECT count(*) FROM _salts").fetchone()[0]
        print(f'{{"salts":"ok","brands":{n}}}', flush=True)
        return True
    except Exception as exc:  # noqa: BLE001 — salt optional; degrade to the NULL-salt ("None") posture.
        con.execute(
            "CREATE OR REPLACE TEMP VIEW _salts AS "
            "SELECT CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS salt_hex WHERE FALSE;"
        )
        print(f'{{"salts":"unreachable","detail":"{str(exc)[:120]}","fallback":"NULL salt (\\"None\\")"}}',
              flush=True)
        return False


def ensure_shadow(con, target: str) -> None:
    """CREATE TABLE IF NOT EXISTS the 14-col shadow target with the Spark hidden partitioning
    (bucket(256, brand_id), day(occurred_at) — day() singular in DuckDB)."""
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {target} (\n{COLLECTOR_COLUMNS_SQL}\n) "
        "PARTITIONED BY (bucket(256, brand_id), day(occurred_at));"
    )


def merge_collector_event(con, target: str, good_sql: str) -> int:
    """The keystone-mirrored idempotent MERGE of a good-row SELECT (producing exactly COLLECTOR_COLUMNS) into
    the *_shadow target on (brand_id, event_id).

    1. In-batch dedup to one row per (brand_id, event_id), latest ingested_at wins (ADR-0010 append-only
       Connect Bronze redelivers duplicates → a MERGE with a duplicate source key would abort).
    2. WHEN MATCHED AND payload genuinely CHANGED → overwrite + bump silver_version (coalesce so a pre-widening
       row starts from 1, never NULL+1). WHEN NOT MATCHED → INSERT. Returns the upserted (deduped) count.

    NOTE: DuckDB's Iceberg MERGE currently supports only a SINGLE UPDATE/DELETE action, so the Spark job's
    two WHEN-MATCHED clauses (payload-changed bump + one-time widen-backfill) are folded into ONE conditional
    UPDATE. The widen-backfill clause was a one-time migration for pre-widening 10-col rows that do not exist
    in these freshly-created shadow tables; the good-row set + silver_version-on-change semantics are identical.
    """
    collist = ", ".join(COLLECTOR_COLUMNS)
    deduped = (
        f"SELECT {collist} FROM (SELECT *, row_number() OVER "
        f"(PARTITION BY brand_id, event_id ORDER BY ingested_at DESC) AS _rn FROM ({good_sql})) WHERE _rn = 1"
    )
    n = con.execute(f"SELECT count(*) FROM ({deduped})").fetchone()[0]
    con.execute(
        f"""
        MERGE INTO {target} t
        USING ({deduped}) s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED AND s.payload <> t.payload THEN UPDATE SET
          occurred_at = s.occurred_at, ingested_at = s.ingested_at,
          schema_name = s.schema_name, schema_version = s.schema_version,
          event_type = s.event_type, event_category = s.event_category,
          correlation_id = s.correlation_id, partition_key = s.partition_key,
          anonymous_id = s.anonymous_id, device_id = s.device_id,
          payload = s.payload,
          silver_version = coalesce(t.silver_version, 1) + 1
        WHEN NOT MATCHED THEN INSERT ({collist}) VALUES ({", ".join('s.' + c for c in COLLECTOR_COLUMNS)});
        """
    )
    return n


def run_normalize_job(job_name: str, build_fn, *, target_table: str) -> None:
    """Thin runner: connect → build(con) → (target, upserted) → structured log. build_fn ensures the shadow
    target, applies the empty-lane skip-guard, and returns (fqtn, n)."""
    t0 = time.time()
    con = connect()
    try:
        fqtn, n = build_fn(con)
        dt = time.time() - t0
        print(f'{{"job":"{job_name}","target":"{target_table}","upserted":{n or 0},'
              f'"seconds":{dt:.2f},"engine":"duckdb"}}', flush=True)
    finally:
        con.close()
