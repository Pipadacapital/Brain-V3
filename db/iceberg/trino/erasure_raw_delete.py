"""
erasure_raw_delete.py (Trino) — RTBF hard-delete for a single subject across all raw Bronze Iceberg
tables. Ported from db/iceberg/spark/erasure_raw_delete.py to the Trino ⇄ Iceberg seam (trino_base.py).

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
   identifier columns:  DELETE FROM <t> WHERE brand_id = '<b>' AND <col> = '<hash>'
2. PAYLOAD-PATH PREDICATE DELETEs (PAYLOAD_PATH_TABLES) — collector_events_connect, which is payload-
   only (verbatim envelope JSON, NO lifted columns): subject identifiers matched via JSON-path reads
   on the envelope. Spark's get_json_object(payload, '$.path') ports to Trino
   json_extract_scalar(payload, '$.path') — same JSONPath semantics, scalar (string) result.

RTBF DELETE + COMPACTION SEQUENCE (the physical-removal point)
--------------------------------------------------------------
Iceberg DELETE is a merge-on-read (format-v2) delete: the rows leave CURRENT table state immediately,
but the PRE-DELETE snapshots still reference the old data files. To PHYSICALLY remove the bytes this
job, after issuing all of a table's DELETEs, runs:
    optimize (compaction)   — rewrite the affected partitions so the deleted rows leave the live files
    expire_snapshots (0s)   — purge the pre-delete snapshots so the old files are deleted from S3
Only after expire is erasure physically complete (no time-travel back to the erased rows). This makes
the Trino job self-contained (the Spark job leaned on the periodic bronze_maintenance expire; here we
purge inline with a 0s window so RTBF completes in one run). Set ERASE_COMPACT=0 to skip and defer to
the periodic bronze_maintenance sweep.

IDEMPOTENCY
-----------
A DELETE WHERE is naturally idempotent: re-running after a successful delete affects 0 rows.

TENANT ISOLATION INVARIANT
---------------------------
brand_id is ALWAYS the first predicate. No DELETE touches data outside the requested brand.

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import trino_base as tb  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", tb.BRONZE_NAMESPACE)

# After the DELETEs, compact + expire (0s) to PHYSICALLY remove the erased rows in this same run.
# ERASE_COMPACT=0 skips it and defers physical removal to the periodic bronze_maintenance sweep.
ERASE_COMPACT = os.environ.get("ERASE_COMPACT", "1") == "1"

# Mapping: raw_table_name -> list of column names that carry a hashed subject identifier. Each listed
# column receives its own DELETE:  DELETE FROM <t> WHERE brand_id = '<b>' AND <col> = '<hash>'.
# A column absent from a table's schema is skipped (safe on partial schema evolution). Tables with an
# empty list are spend/aggregate lanes with no per-subject row (skipped silently). collector_events_connect
# is NOT here — it is payload-only; its erasure is the PAYLOAD-PATH mechanism below.
RAW_TABLE_IDENTIFIER_COLS: "dict[str, list[str]]" = {
    "shopify_orders_raw_connect": ["identifier_hash", "email_hash"],
    "woocommerce_orders_raw_connect": ["identifier_hash", "email_hash"],
    "meta_spend_raw_connect": [],    # aggregate spend — no per-subject identifier
    "google_spend_raw_connect": [],  # aggregate spend — no per-subject identifier
    "ga4_rows_raw_connect": ["identifier_hash", "client_id"],
    "shiprocket_shipments_raw_connect": ["identifier_hash"],
    "gokwik_events_raw_connect": ["identifier_hash"],
    "shopflo_checkout_raw_connect": ["identifier_hash"],
    "razorpay_settlement_raw_connect": ["identifier_hash"],
}

# ── PAYLOAD-PATH PREDICATE ERASURE (ADR-0010 RTBF posture for the payload-only Bronze SoR) ────────
# collector_events_connect lands ONLY the verbatim envelope `payload` JSON + kafka coordinates — no
# lifted identifier columns. Per-subject erasure predicates on JSON paths INSIDE the payload (the same
# envelope paths the identity/erasure flow reads). It has NO brand_id column — the brand predicate is
# the envelope's $.brand_id and is ALWAYS the first predicate of every payload-path DELETE.
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
        "device_paths": ["$.properties.device_id", "$.properties['$device_id']"],
    },
}

# IN-list chunk size for the raw-id predicates (a subject can accumulate many anon/device ids; keep
# each DELETE statement bounded).
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
    contain single quotes, e.g. $.properties['$device_id'])."""
    return "'" + value.replace("'", "''") + "'"


def _chunks(values: list, size: int):
    for i in range(0, len(values), size):
        yield values[i : i + size]


# ── Helpers (Trino information_schema — table/column existence) ─────────────────────────────────────


def _table_exists(cur, table: str) -> bool:
    return tb.table_exists(cur, BRONZE_NAMESPACE, table)


def _col_exists(cur, table: str, col: str) -> bool:
    return col in tb.columns_of(cur, BRONZE_NAMESPACE, table)


def _compact_and_purge(cur, table: str) -> None:
    """RTBF physical-removal step: compact the affected partitions then expire the pre-delete snapshots
    (0s window) so the old data files holding the erased rows are deleted from S3. Best-effort — a
    failure here is logged; the periodic bronze_maintenance sweep is the backstop."""
    if not ERASE_COMPACT:
        return
    try:
        tb.optimize(cur, BRONZE_NAMESPACE, table)
        tb.expire(cur, BRONZE_NAMESPACE, table, tb.ms_to_duration(0))
        print(f"[erasure-raw-delete] compacted + expired snapshots (0s) on {tb.fqtn(BRONZE_NAMESPACE, table)} — physically removed", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(
            f"[erasure-raw-delete] WARN {tb.fqtn(BRONZE_NAMESPACE, table)} compact/expire: {exc} "
            "— rows are out of current state; physical removal deferred to bronze_maintenance",
            flush=True,
        )


# ── Core erasure function (column-equality) ─────────────────────────────────────────────────────────


def erase_subject_raw(cur, brand_id: str, identifier_hash: str) -> "dict[str, list[str]]":
    """Delete all raw Bronze rows tied to (brand_id, identifier_hash) via column-equality predicates.

    Tenant-isolation invariant: brand_id is ALWAYS the first predicate. Idempotent (0 rows on re-run).
    Returns table_name -> list of columns for which a DELETE was successfully issued. After a table's
    DELETEs, compacts + purges snapshots so the erased rows are physically removed.
    """
    brand_id = _validate_brand_id(brand_id)
    identifier_hash = _validate_identifier_hash(identifier_hash)

    brand_prefix = brand_id[:8]
    hash_prefix = identifier_hash[:8]

    results: "dict[str, list[str]]" = {}

    for table, id_cols in RAW_TABLE_IDENTIFIER_COLS.items():
        fq = tb.fqtn(BRONZE_NAMESPACE, table)

        if not id_cols:
            print(f"[erasure-raw-delete] SKIP {table}: spend/aggregate lane — no per-subject row", flush=True)
            continue

        if not _table_exists(cur, table):
            print(f"[erasure-raw-delete] SKIP {table}: table not found in {tb.CATALOG}.{BRONZE_NAMESPACE}", flush=True)
            continue

        targeted_cols: "list[str]" = []
        for col in id_cols:
            if not _col_exists(cur, table, col):
                print(f"[erasure-raw-delete] SKIP {fq}.{col}: column absent in schema", flush=True)
                continue

            # brand_id FIRST (tenant isolation), then identifier column. Both values validated above.
            delete_sql = (
                f"DELETE FROM {fq} "
                f"WHERE brand_id = '{brand_id}' "
                f"  AND {col} = '{identifier_hash}'"
            )
            try:
                cur.execute(delete_sql)
                cur.fetchall()
                targeted_cols.append(col)
                print(
                    f"[erasure-raw-delete] DELETE {fq} "
                    f"WHERE brand_id=<{brand_prefix}...> AND {col}=<{hash_prefix}...>",
                    flush=True,
                )
            except Exception as exc:  # noqa: BLE001 — never abort the sweep on one table/column
                print(f"[erasure-raw-delete] WARN {fq}.{col}: {exc}", flush=True)

        results[table] = targeted_cols
        if targeted_cols:
            _compact_and_purge(cur, table)  # physically remove the just-deleted rows

    return results


# ── Payload-path predicate erasure (collector_events_connect) ─────────────────────────────────────


def erase_subject_payload_path(
    cur,
    brand_id: str,
    identifier_hash: str,
    anon_ids: "list[str] | tuple" = (),
    device_ids: "list[str] | tuple" = (),
) -> "dict[str, int]":
    """PAYLOAD-PATH PREDICATE ERASURE for the payload-only Bronze tables (PAYLOAD_PATH_TABLES).

    Per table, issues DELETEs whose subject predicates are json_extract_scalar() reads INSIDE the
    verbatim envelope `payload` (Trino analogue of Spark get_json_object):
      • one DELETE matching every pre-hashed identifier path against identifier_hash;
      • per chunk of anon_ids / device_ids, one DELETE with json_extract_scalar(payload, <path>) IN
        (<chunk>) per path.

    TENANT ISOLATION: every DELETE's FIRST predicate is the envelope brand id
    (json_extract_scalar(payload, '$.brand_id') = '<brand_id>').

    After all DELETEs on a table, compacts + purges snapshots so the erased rows are physically removed.
    Returns table_name -> number of DELETE statements successfully issued.
    """
    brand_id = _validate_brand_id(brand_id)
    identifier_hash = _validate_identifier_hash(identifier_hash)
    anon_ids = _sanitize_raw_ids(list(anon_ids), "ANON_IDS")
    device_ids = _sanitize_raw_ids(list(device_ids), "DEVICE_IDS")

    brand_prefix = brand_id[:8]
    hash_prefix = identifier_hash[:8]

    results: "dict[str, int]" = {}

    for table, spec in PAYLOAD_PATH_TABLES.items():
        fq = tb.fqtn(BRONZE_NAMESPACE, table)

        if not _table_exists(cur, table):
            print(f"[erasure-raw-delete] SKIP {table}: table not found in {tb.CATALOG}.{BRONZE_NAMESPACE}", flush=True)
            continue

        # brand_id FIRST (tenant isolation) — the envelope path, since there is no brand_id column.
        brand_pred = (
            f"json_extract_scalar(payload, {_sql_str(spec['brand_path'])}) = {_sql_str(brand_id)}"
        )

        # Subject predicate groups: (label, OR-of-json_extract_scalar predicates).
        groups: "list[tuple[str, str]]" = [
            (
                "hash_paths",
                " OR ".join(
                    f"json_extract_scalar(payload, {_sql_str(p)}) = {_sql_str(identifier_hash)}"
                    for p in spec["hash_paths"]
                ),
            )
        ]
        for paths_key, values in (("anon_paths", anon_ids), ("device_paths", device_ids)):
            for chunk in _chunks(values, PAYLOAD_IN_LIST_CHUNK):
                in_list = ", ".join(_sql_str(v) for v in chunk)
                groups.append(
                    (
                        f"{paths_key}[{len(chunk)}]",
                        " OR ".join(
                            f"json_extract_scalar(payload, {_sql_str(p)}) IN ({in_list})"
                            for p in spec[paths_key]
                        ),
                    )
                )

        issued = 0
        for label, subject_pred in groups:
            delete_sql = f"DELETE FROM {fq} WHERE {brand_pred} AND ({subject_pred})"
            try:
                cur.execute(delete_sql)
                cur.fetchall()
                issued += 1
                print(
                    f"[erasure-raw-delete] DELETE {fq} [{label}] "
                    f"WHERE $.brand_id=<{brand_prefix}...> AND subject=<{hash_prefix}...>",
                    flush=True,
                )
            except Exception as exc:  # noqa: BLE001 — never abort the sweep on one statement
                print(f"[erasure-raw-delete] WARN {fq} [{label}]: {exc}", flush=True)

        results[table] = issued
        if issued:
            _compact_and_purge(cur, table)  # physically remove the just-deleted rows

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

    conn = tb.connect()
    cur = conn.cursor()

    print(
        f"[erasure-raw-delete] START brand=<{brand_id[:8]}...> hash=<{identifier_hash[:8]}...>",
        flush=True,
    )

    results = erase_subject_raw(cur, brand_id, identifier_hash)
    for table, cols in results.items():
        status = f"targeted columns: {cols}" if cols else "no identifier columns found"
        print(f"[erasure-raw-delete] {table}: {status}", flush=True)

    # PAYLOAD-PATH sweep (collector_events_connect): raw anon/device ids come in as optional
    # comma-separated envs supplied by the erasure orchestrator.
    anon_ids = [v for v in os.environ.get("ANON_IDS", "").split(",") if v.strip()]
    device_ids = [v for v in os.environ.get("DEVICE_IDS", "").split(",") if v.strip()]
    payload_results = erase_subject_payload_path(
        cur, brand_id, identifier_hash, anon_ids=anon_ids, device_ids=device_ids
    )
    for table, issued in payload_results.items():
        suffix = "(physically removed inline)" if ERASE_COMPACT else "(complete after snapshot expiry — bronze_maintenance.py)"
        print(f"[erasure-raw-delete] {table}: {issued} payload-path DELETE statement(s) issued {suffix}", flush=True)

    print("[erasure-raw-delete] DONE — Bronze raw erasure sweep complete", flush=True)


if __name__ == "__main__":
    main()
