"""
erasure_raw_delete.py (PyIceberg + DuckDB) — RTBF hard-delete for a single subject across all raw
Bronze Iceberg tables. Ported 1:1 (env contract unchanged) from db/iceberg/trino/erasure_raw_delete.py
to the PyIceberg maintenance seam (_maintenance_base.py).

POSTURE
-------
bronze_raw_retention.py handles TIME-based erasure (rolling window). This file handles SUBJECT-based
erasure: a specific data subject exercises their Right-to-be-Forgotten and every raw row tied to their
hashed identifier must be deleted regardless of age.

SCOPE
-----
Scoped by (brand_id, identifier_hash). brand_id is the tenant isolation key; it is ALWAYS the first
predicate in every DELETE. identifier_hash is the SHA-256 hex (64 chars) of the subject's PII identifier.

TWO ERASURE MECHANISMS
----------------------
1. Column-equality DELETEs (RAW_TABLE_IDENTIFIER_COLS) — the `*_raw_connect` lanes with lifted
   identifier columns: pyiceberg COW delete(And(EqualTo('brand_id', <b>), EqualTo(<col>, <hash>))).
2. PAYLOAD-PATH PREDICATE DELETEs (PAYLOAD_PATH_TABLES) — collector_events_connect, which is payload-
   only (verbatim envelope JSON, NO lifted columns): subject identifiers matched via JSON-path reads
   on the envelope. Trino's json_extract_scalar(payload, '$.path') ports to DuckDB
   json_extract_string(payload, '$.path') — same JSONPath semantics, scalar (string) result.
   CRITICAL (capability-probe gate 7 / spike gate i): a DuckDB MoR DELETE writes positional-delete
   files that pyiceberg rewrites can NEVER drop from metadata — so this lane does NOT issue DuckDB
   DELETEs. Instead the JSON-path predicates run as a DuckDB READ that resolves the matching rows'
   Kafka physical coordinates (kafka_topic, kafka_partition, kafka_offset — the Connect sink's
   unique-per-row dedup key), and the delete is applied purely as pyiceberg COW deletes on those
   coordinates: same rows, zero merge-on-read artefacts, files rewritten in the delete commit.

RTBF DELETE + PURGE SEQUENCE (the physical-removal point)
---------------------------------------------------------
A pyiceberg COW delete REWRITES the data files containing the matched rows in the same commit — the
rows leave both CURRENT table state and the live data files immediately (no compaction pass needed;
this replaces the Trino job's MoR-delete-then-optimize step). But the PRE-DELETE snapshots still
reference the old files, so after all of a table's DELETEs this job runs:
    expire_snapshots (0ms) + sweep — purge the pre-delete snapshots and physically delete the old
    files from S3 (_maintenance_base.expire; pyiceberg expire is metadata-only, the sweep is the
    bytes-gone half).
Only after expire is erasure physically complete (no time-travel back to the erased rows). Set
ERASE_COMPACT=0 to skip and defer physical removal to the periodic bronze_maintenance sweep.

IDEMPOTENCY
-----------
A predicate delete is naturally idempotent: re-running after a successful delete matches 0 rows
(the payload-path coordinate resolve returns an empty set → no delete commits at all).

TENANT ISOLATION INVARIANT
---------------------------
brand_id is ALWAYS the first predicate — first in every COW delete expression, and first in the
payload-path matching READ ($.brand_id). The coordinate deletes it produces can only touch rows the
brand-scoped match returned (Kafka coordinates are unique per row).

USAGE
-----
  BRAND_ID=<uuid> IDENTIFIER_HASH=<64-char sha256 hex> \
  [ANON_IDS=<comma-separated raw brain_anon_ids>] [DEVICE_IDS=<comma-separated raw device_ids>] \
  [ERASE_COMPACT=1] python erasure_raw_delete.py

Callable from another job/test:
  from erasure_raw_delete import erase_subject_raw, erase_subject_payload_path
"""
from __future__ import annotations

import os
import re
import sys
import uuid as uuid_mod

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import _maintenance_base as mb  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", mb.BRONZE_NAMESPACE)

# After the DELETEs, expire (0ms) + sweep to PHYSICALLY remove the erased bytes in this same run.
# ERASE_COMPACT=0 skips it and defers physical removal to the periodic bronze_maintenance sweep.
ERASE_COMPACT = os.environ.get("ERASE_COMPACT", "1") == "1"

# Mapping: raw_table_name -> list of column names that carry a hashed subject identifier. Each listed
# column receives its own COW delete: delete(And(EqualTo('brand_id', <b>), EqualTo(<col>, <hash>))).
# The 9 `*_raw_connect` lanes were RETIRED by ADR-0016 (2026-07-18) — never populated, sinks removed —
# so this mechanism has no live tables (DR-001 hygiene); the constant stays so the erasure sequence
# (and any future ADR-sanctioned lifted-column lane) needs no rework. collector_events_connect is NOT
# here — it is payload-only; its erasure is the PAYLOAD-PATH mechanism below.
RAW_TABLE_IDENTIFIER_COLS: "dict[str, list[str]]" = {}

# ── PAYLOAD-PATH PREDICATE ERASURE (ADR-0010 RTBF posture for the payload-only Bronze SoR) ────────
# collector_events_connect lands ONLY the verbatim envelope `payload` JSON + kafka coordinates — no
# lifted identifier columns. Per-subject erasure predicates on JSON paths INSIDE the payload (the same
# envelope paths the identity/erasure flow reads). It has NO brand_id column — the brand predicate is
# the envelope's $.brand_id and is ALWAYS the first predicate of every payload-path matching READ.
# Paths are DuckDB JSONPath syntax: dollar-prefixed keys are double-quoted ("$device_id"), where
# Trino used bracket-quoting ($.properties['$device_id']).
PAYLOAD_PATH_TABLES: "dict[str, dict]" = {
    "collector_events_connect": {
        "brand_path": "$.brand_id",
        "hash_paths": [
            "$.properties.hashed_customer_email",
            "$.properties.customer_email_hash",
            "$.properties.hashed_customer_phone",
            "$.properties.customer_phone_hash",
            "$.pre_hashed_identifiers.hashed_customer_email",
            "$.pre_hashed_identifiers.hashed_customer_phone",
        ],
        "anon_paths": ["$.properties.brain_anon_id", "$.properties.anon_id"],
        "device_paths": ["$.properties.device_id", '$.properties."$device_id"'],
    },
}

# IN-list chunk size for the raw-id predicates AND the coordinate-delete offset chunks (a subject can
# accumulate many anon/device ids and matched rows; keep each statement/expression bounded).
PAYLOAD_IN_LIST_CHUNK = max(1, int(os.environ.get("PAYLOAD_IN_LIST_CHUNK", "500")))

# ── Input validation ──────────────────────────────────────────────────────────────────────────────

_HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _validate_brand_id(brand_id: str) -> str:
    """Raise ValueError if brand_id is not a well-formed UUID string."""
    try:
        uuid_mod.UUID(brand_id)
    except ValueError:
        raise ValueError(f"BRAND_ID must be a valid UUID; got: {brand_id!r}")
    return brand_id


def _validate_identifier_hash(identifier_hash: str) -> str:
    """Raise ValueError if identifier_hash is not a 64-char hex string (SHA-256)."""
    if not _HEX64_RE.match(identifier_hash):
        raise ValueError(
            "IDENTIFIER_HASH must be a 64-character lowercase hex SHA-256 digest; "
            f"got length={len(identifier_hash)!r} value={identifier_hash[:8]!r}..."
        )
    return identifier_hash.lower()


# Raw anon/device ids. FAIL-SAFE sanitization: a value outside this charset is SKIPPED with a WARN —
# never interpolated into SQL (no quotes, backslashes, whitespace can pass).
_RAW_ID_RE = re.compile(r"^[A-Za-z0-9._:@/-]{1,256}$")


def _sanitize_raw_ids(values: "list[str] | tuple", kind: str) -> "list[str]":
    """De-dupe + validate the raw subject ids; drop (and WARN about) anything unsafe to embed."""
    out: "list[str]" = []
    for v in values:
        v = v.strip()
        if not v:
            continue
        if not _RAW_ID_RE.match(v):
            print(
                f"[erasure-raw-delete] WARN {kind}: skipping malformed raw id "
                f"(len={len(v)}, prefix={v[:8]!r}...) — fails the safe-charset check",
                flush=True,
            )
            continue
        if v not in out:
            out.append(v)
    return out


def _sql_str(value: str) -> str:
    """Single-quoted SQL string literal (doubles embedded quotes — the JSON path constants legitimately
    contain double-quoted keys, and defense-in-depth on the validated subject values)."""
    return "'" + value.replace("'", "''") + "'"


def _chunks(values: list, size: int):
    for i in range(0, len(values), size):
        yield values[i : i + size]


# ── Helpers (Iceberg schema — table/column existence) ─────────────────────────────────────────────


def _table_exists(cat, table: str) -> bool:
    return mb.table_exists(cat, BRONZE_NAMESPACE, table)


def _col_exists(cat, table: str, col: str) -> bool:
    return col in mb.columns_of(cat, BRONZE_NAMESPACE, table)


def _purge_history(cat, table: str) -> None:
    """RTBF physical-removal step: expire the pre-delete snapshots (0ms window) + sweep so the old
    data files holding the erased rows are deleted from S3 (the COW deletes already rewrote the
    live files in their own commits — no compaction pass needed). Best-effort — a failure here is
    logged; the periodic bronze_maintenance sweep is the backstop."""
    if not ERASE_COMPACT:
        return
    try:
        mb.expire(cat, BRONZE_NAMESPACE, table, 0)
        print(f"[erasure-raw-delete] expired snapshots (0ms) + swept {mb.ident(BRONZE_NAMESPACE, table)} — physically removed", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(
            f"[erasure-raw-delete] WARN {mb.ident(BRONZE_NAMESPACE, table)} expire/sweep: {exc} "
            "— rows are out of current state; physical removal deferred to bronze_maintenance",
            flush=True,
        )


# ── Core erasure function (column-equality) ─────────────────────────────────────────────────────────


def erase_subject_raw(cat, brand_id: str, identifier_hash: str) -> "dict[str, list[str]]":
    """Delete all raw Bronze rows tied to (brand_id, identifier_hash) via column-equality predicates.

    Tenant-isolation invariant: brand_id is ALWAYS the first predicate. Idempotent (0 rows on re-run).
    Returns table_name -> list of columns for which a COW delete was successfully committed. After a
    table's DELETEs, expires + sweeps the pre-delete snapshots so the erased rows are physically removed.
    """
    from pyiceberg.expressions import And, EqualTo

    brand_id = _validate_brand_id(brand_id)
    identifier_hash = _validate_identifier_hash(identifier_hash)

    brand_prefix = brand_id[:8]
    hash_prefix = identifier_hash[:8]

    results: "dict[str, list[str]]" = {}

    for table, id_cols in RAW_TABLE_IDENTIFIER_COLS.items():
        fq = mb.ident(BRONZE_NAMESPACE, table)

        if not id_cols:
            print(f"[erasure-raw-delete] SKIP {table}: spend/aggregate lane — no per-subject row", flush=True)
            continue

        if not _table_exists(cat, table):
            print(f"[erasure-raw-delete] SKIP {table}: table not found in {BRONZE_NAMESPACE}", flush=True)
            continue

        targeted_cols: "list[str]" = []
        for col in id_cols:
            if not _col_exists(cat, table, col):
                print(f"[erasure-raw-delete] SKIP {fq}.{col}: column absent in schema", flush=True)
                continue

            # brand_id FIRST (tenant isolation), then identifier column. Both values validated above.
            try:
                mb.delete(
                    cat,
                    BRONZE_NAMESPACE,
                    table,
                    And(EqualTo("brand_id", brand_id), EqualTo(col, identifier_hash)),
                )
                targeted_cols.append(col)
                print(
                    f"[erasure-raw-delete] COW DELETE {fq} "
                    f"WHERE brand_id=<{brand_prefix}...> AND {col}=<{hash_prefix}...>",
                    flush=True,
                )
            except Exception as exc:  # noqa: BLE001 — never abort the sweep on one table/column
                print(f"[erasure-raw-delete] WARN {fq}.{col}: {exc}", flush=True)

        results[table] = targeted_cols
        if targeted_cols:
            _purge_history(cat, table)  # physically remove the just-deleted rows

    return results


# ── Payload-path predicate erasure (collector_events_connect) ─────────────────────────────────────


def erase_subject_payload_path(
    cat,
    brand_id: str,
    identifier_hash: str,
    anon_ids: "list[str] | tuple" = (),
    device_ids: "list[str] | tuple" = (),
) -> "dict[str, int]":
    """PAYLOAD-PATH PREDICATE ERASURE for the payload-only Bronze tables (PAYLOAD_PATH_TABLES).

    Per table, resolves the subject's rows with ONE DuckDB READ whose predicates are
    json_extract_string() reads INSIDE the verbatim envelope `payload` (DuckDB analogue of Trino
    json_extract_scalar / Spark get_json_object):
      • every pre-hashed identifier path matched against identifier_hash;
      • every anon/device path matched against the sanitized raw-id IN-lists (chunked).
    The READ returns the matching rows' Kafka physical coordinates; the erasure is then applied as
    pyiceberg COW deletes on (kafka_topic, kafka_partition, kafka_offset IN <chunk>) — never a
    DuckDB MoR DELETE (probe gate 7: positional-delete files are unremovable from metadata).

    TENANT ISOLATION: the matching READ's FIRST predicate is the envelope brand id
    (json_extract_string(payload, '$.brand_id') = '<brand_id>'), and the coordinate deletes can
    only touch the rows that brand-scoped match returned.

    After all of a table's deletes, expires + sweeps the pre-delete snapshots so the erased rows are
    physically removed. Returns table_name -> number of COW delete commits successfully issued.
    """
    from pyiceberg.expressions import And, EqualTo, In

    brand_id = _validate_brand_id(brand_id)
    identifier_hash = _validate_identifier_hash(identifier_hash)
    anon_ids = _sanitize_raw_ids(list(anon_ids), "ANON_IDS")
    device_ids = _sanitize_raw_ids(list(device_ids), "DEVICE_IDS")

    brand_prefix = brand_id[:8]
    hash_prefix = identifier_hash[:8]

    con = mb.duckdb_connect()
    results: "dict[str, int]" = {}

    for table, spec in PAYLOAD_PATH_TABLES.items():
        fq = mb.fqtn(BRONZE_NAMESPACE, table)

        if not _table_exists(cat, table):
            print(f"[erasure-raw-delete] SKIP {table}: table not found in {BRONZE_NAMESPACE}", flush=True)
            continue

        # brand_id FIRST (tenant isolation) — the envelope path, since there is no brand_id column.
        brand_pred = (
            f"json_extract_string(payload, {_sql_str(spec['brand_path'])}) = {_sql_str(brand_id)}"
        )

        # Subject predicate groups, OR-ed into one matching READ (was: one Trino DELETE per group).
        subject_preds: "list[str]" = [
            f"json_extract_string(payload, {_sql_str(p)}) = {_sql_str(identifier_hash)}"
            for p in spec["hash_paths"]
        ]
        for paths_key, values in (("anon_paths", anon_ids), ("device_paths", device_ids)):
            for chunk in _chunks(values, PAYLOAD_IN_LIST_CHUNK):
                in_list = ", ".join(_sql_str(v) for v in chunk)
                subject_preds.extend(
                    f"json_extract_string(payload, {_sql_str(p)}) IN ({in_list})"
                    for p in spec[paths_key]
                )

        # 1. Resolve the matching rows' Kafka coordinates (unique per row — the sink's dedup key).
        coords = con.execute(
            f"SELECT kafka_topic, kafka_partition, kafka_offset FROM {fq} "
            f"WHERE {brand_pred} AND ({' OR '.join(subject_preds)})"
        ).fetchall()
        print(
            f"[erasure-raw-delete] MATCH {fq}: {len(coords)} row(s) "
            f"WHERE $.brand_id=<{brand_prefix}...> AND subject=<{hash_prefix}...>",
            flush=True,
        )

        # 2. Apply as COW deletes, chunked per (topic, partition) so each commit's expression is bounded.
        by_tp: "dict[tuple, list]" = {}
        for topic, partition, offset in coords:
            if topic is None or partition is None or offset is None:
                # Coordinates are the sink's dedup key and are always set — a null here is a
                # malformed row we refuse to target by equality (fail-safe, loudly).
                print(f"[erasure-raw-delete] WARN {fq}: matched row with NULL kafka coordinates — skipped", flush=True)
                continue
            by_tp.setdefault((topic, partition), []).append(offset)

        issued = 0
        for (topic, partition), offsets in sorted(by_tp.items()):
            for chunk in _chunks(sorted(offsets), PAYLOAD_IN_LIST_CHUNK):
                try:
                    mb.delete(
                        cat,
                        BRONZE_NAMESPACE,
                        table,
                        And(
                            EqualTo("kafka_topic", topic),
                            EqualTo("kafka_partition", partition),
                            In("kafka_offset", chunk),
                        ),
                    )
                    issued += 1
                    print(
                        f"[erasure-raw-delete] COW DELETE {fq} [{topic}/{partition}] "
                        f"{len(chunk)} offset(s)",
                        flush=True,
                    )
                except Exception as exc:  # noqa: BLE001 — never abort the sweep on one chunk
                    print(f"[erasure-raw-delete] WARN {fq} [{topic}/{partition}]: {exc}", flush=True)

        results[table] = issued
        if issued:
            _purge_history(cat, table)  # physically remove the just-deleted rows

    return results


# ── Entry point ───────────────────────────────────────────────────────────────────────────────────


def main() -> None:
    brand_id_raw = os.environ.get("BRAND_ID", "").strip()
    identifier_hash_raw = os.environ.get("IDENTIFIER_HASH", "").strip()

    if not brand_id_raw or not identifier_hash_raw:
        print(
            "[erasure-raw-delete] FATAL: BRAND_ID and IDENTIFIER_HASH environment variables are required",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    try:
        brand_id = _validate_brand_id(brand_id_raw)
        identifier_hash = _validate_identifier_hash(identifier_hash_raw)
    except ValueError as exc:
        print(f"[erasure-raw-delete] FATAL: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)

    cat = mb.pyiceberg_catalog()

    print(
        f"[erasure-raw-delete] START brand=<{brand_id[:8]}...> hash=<{identifier_hash[:8]}...>",
        flush=True,
    )

    results = erase_subject_raw(cat, brand_id, identifier_hash)
    for table, cols in results.items():
        status = f"targeted columns: {cols}" if cols else "no identifier columns found"
        print(f"[erasure-raw-delete] {table}: {status}", flush=True)

    # PAYLOAD-PATH sweep (collector_events_connect): raw anon/device ids come in as optional
    # comma-separated envs supplied by the erasure orchestrator.
    anon_ids = [v for v in os.environ.get("ANON_IDS", "").split(",") if v.strip()]
    device_ids = [v for v in os.environ.get("DEVICE_IDS", "").split(",") if v.strip()]
    payload_results = erase_subject_payload_path(
        cat, brand_id, identifier_hash, anon_ids=anon_ids, device_ids=device_ids
    )
    for table, issued in payload_results.items():
        suffix = "(physically removed inline)" if ERASE_COMPACT else "(complete after snapshot expiry — bronze_maintenance.py)"
        print(f"[erasure-raw-delete] {table}: {issued} payload-path COW delete commit(s) issued {suffix}", flush=True)

    print("[erasure-raw-delete] DONE — Bronze raw erasure sweep complete", flush=True)


if __name__ == "__main__":
    main()
