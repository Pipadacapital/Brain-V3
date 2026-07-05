"""
erasure_raw_delete.py — RTBF hard-delete for a single subject across all raw Bronze
Iceberg tables. ADR-0006 D4 erasure complement to bronze_raw_retention.py.

POSTURE
-------
bronze_raw_retention.py handles TIME-based erasure: rolling snapshot expiry clears all
raw PII older than RAW_RETENTION_HOURS (default 7 days). This file handles SUBJECT-based
erasure: a specific data subject exercises their Right-to-be-Forgotten and every raw row
tied to their hashed identifier must be deleted regardless of age.

The two jobs together implement the two-layer Bronze PII posture:
  Retention job (cron)    — expire snapshots on a rolling window (temporal).
  Erasure job  (on-demand) — hard-delete one subject's rows across all raw tables (RTBF).

SCOPE
-----
Scoped by (brand_id, identifier_hash). brand_id is the tenant isolation key; it is ALWAYS
the first predicate in every DELETE so the query plan prunes to the correct tenant partition
before scanning identifier_hash. identifier_hash is the SHA-256 hex (64 chars) of the
subject's PII identifier (email, phone, etc.) — the same hash written to the identity graph
and the raw Bronze tables by the Spark Bronze sink and the collector normaliser.

Each raw table may carry the hashed identifier under a different column name. The
RAW_TABLE_IDENTIFIER_COLS mapping declares which columns to target per table. A table entry
with an empty column list is spend/aggregate data with no per-subject row (skipped silently).

TWO ERASURE MECHANISMS
----------------------
1. Column-equality DELETEs (RAW_TABLE_IDENTIFIER_COLS) — the `*_raw_connect` lanes, which carry
   the exploded raw envelope with lifted identifier columns.
2. PAYLOAD-PATH PREDICATE DELETEs (PAYLOAD_PATH_TABLES) — collector_events_connect, which is
   payload-only (verbatim envelope JSON string + kafka coordinates, NO lifted columns): the
   subject identifiers are matched via get_json_object() on the envelope's JSON paths. This is
   the ADR-0010 RTBF posture for the payload-only Bronze system of record.

IDEMPOTENCY
-----------
A Spark SQL DELETE WHERE is naturally idempotent: re-running after a successful delete
returns 0 affected rows and exits clean. No state machine needed.

TENANT ISOLATION INVARIANT
---------------------------
brand_id is ALWAYS the first predicate. No DELETE touches data outside the requested brand.

USAGE
-----
As a spark-submit job:
  BRAND_ID=<uuid> IDENTIFIER_HASH=<64-char sha256 hex> \
  [ANON_IDS=<comma-separated raw brain_anon_ids>] [DEVICE_IDS=<comma-separated raw device_ids>] \
  spark-submit erasure_raw_delete.py

ANON_IDS / DEVICE_IDS are the subject's RAW (un-hashed) anonymous/device ids — the orchestrator
takes them from the erasure signal's own envelope properties and the subject's identity links.
The payload stores them un-hashed, so IDENTIFIER_HASH cannot match them; they get their own
IN-list predicates in the payload-path DELETE (chunked; see PAYLOAD_IN_LIST_CHUNK).

As a callable from another Spark job or test:
  from erasure_raw_delete import erase_subject_raw, erase_subject_payload_path
  summary = erase_subject_raw(spark, brand_id="...", identifier_hash="...")
  payload_summary = erase_subject_payload_path(spark, brand_id="...", identifier_hash="...",
                                               anon_ids=[...], device_ids=[...])

WIRING INTO THE RTBF PIPELINE
------------------------------
After the PostgreSQL steps in the erasure procedure (0114 migration comment):
  4. python erasure_raw_delete.py  (this job — clears Bronze Iceberg raw layer)
  5. erase_contact_pii_for_customer(brand_id, brain_id) via PG  (belt-and-suspenders hard-delete)

This job does NOT call PG functions and has no PG dependency. It talks to the Iceberg REST
catalog + MinIO/S3 only via the shared iceberg_base session.
"""
from __future__ import annotations

import os
import re
import sys
import uuid as uuid_mod

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import CATALOG, build_spark  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")

# Mapping: raw_table_name -> list of column names that carry a hashed subject identifier.
#
# Each listed column receives its own DELETE predicate:
#   DELETE FROM <table> WHERE brand_id = '<brand_id>' AND <col> = '<identifier_hash>'
#
# If a column is not present in a given table's Iceberg schema the DELETE is silently
# skipped for that (table, column) pair — safe on partial schema evolution.
#
# Tables with an empty list are spend/aggregate lanes with no per-subject row (no PII to
# erase at the row level; skip silently and note in logs).
#
# ADD a new lane here when its Kafka Connect Iceberg sink connector ships.
#
# ADR-0010: the live writer is the Kafka Connect Iceberg sink — each raw lane lands in its own
# `<lane>_raw_connect` table (auto-created on the lane's first record; absent tables are skipped by
# the _table_exists guard). The connect tables carry the exploded raw envelope — an identifier column
# absent from a lane's connect schema is skipped by the _col_exists guard (and that lane's raw rows
# still age out within the D4 7-day window via bronze_raw_retention.py). collector_events_connect is
# NOT listed here: it lands the verbatim envelope `payload` JSON + kafka coordinates only (no lifted
# identifier columns), so a column-equality DELETE cannot target it — its per-subject erasure is the
# PAYLOAD-PATH PREDICATE mechanism below (PAYLOAD_PATH_TABLES / erase_subject_payload_path).
# Legacy tables (brain_bronze.events, collector_events, collector_events_raw + the 9 per-connector *_raw) were dropped 2026-07-05 (unify-bronze-decommission Step 3 executed).
RAW_TABLE_IDENTIFIER_COLS: dict[str, list[str]] = {
    # ── ADR-0010 Connect-written lanes (live writers) ──
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
#
# brain_bronze.collector_events_connect is TRULY RAW: the Connect sink lands ONLY the verbatim
# envelope `payload` JSON string + kafka coordinates — there are no lifted identifier columns, so
# the column-equality DELETEs above cannot target it. Per-subject erasure instead predicates on the
# JSON paths INSIDE the payload — the SAME envelope paths the identity/erasure flow reads (grounded
# in apps/stream-worker/src/domain/identity/extract-identifiers.ts and
# EraseSubjectUseCase.extractSubject):
#
#   raw subject keys  : $.properties.brain_anon_id  (fallback $.properties.anon_id)
#                       $.properties.device_id      (fallback $.properties['$device_id'])
#   pre-hashed 64-hex : $.properties.hashed_customer_email / $.properties.customer_email_hash
#                       $.properties.hashed_customer_phone / $.properties.customer_phone_hash
#                       $.pre_hashed_identifiers.hashed_customer_email / .hashed_customer_phone
#
# The pre-hashed paths are compared against IDENTIFIER_HASH (the orchestrator's per-brand-salted
# SHA-256 of the subject's email/phone — the same 64-hex written to identity_link; a mapper that
# hashed with a different scheme simply never matches: no cross-subject deletes). The raw paths are
# compared against the RAW anon/device ids the orchestrator supplies (ANON_IDS / DEVICE_IDS — from
# the erasure signal's own envelope + the subject's identity links; the payload stores them
# un-hashed, so the hash cannot match them). Rows carrying ONLY a raw email/phone are never sent to
# this job (NO-RAW-PII invariant) and are reached via the anon/device ids of the same sessions.
#
# Iceberg semantics: DELETE here is a copy-on-write/positional (format-v2) delete — the rows leave
# CURRENT table state immediately, but the PRE-DELETE snapshots still reference the old data files.
# The periodic bronze_maintenance.py expire_snapshots (SNAPSHOT_TTL_MS window) ages those out;
# erasure is PHYSICALLY COMPLETE after snapshot expiry — the same posture the D4 doc uses for the
# raw-window retention.
#
# TENANT ISOLATION: collector_events_connect has NO brand_id column; the brand predicate is the
# envelope's $.brand_id and is ALWAYS the first predicate of every payload-path DELETE.
PAYLOAD_PATH_TABLES: dict[str, dict] = {
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
# each DELETE statement bounded — same knob-via-env convention as the Silver batching knobs).
PAYLOAD_IN_LIST_CHUNK = max(1, int(os.environ.get("PAYLOAD_IN_LIST_CHUNK", "500")))

# ── Input validation ──────────────────────────────────────────────────────────────────────────────

_HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _validate_brand_id(brand_id: str) -> str:
    """Raise ValueError if brand_id is not a well-formed UUID string."""
    try:
        uuid_mod.UUID(brand_id)
    except ValueError:
        raise ValueError(
            f"BRAND_ID must be a valid UUID; got: {brand_id!r}"
        )
    return brand_id


def _validate_identifier_hash(identifier_hash: str) -> str:
    """Raise ValueError if identifier_hash is not a 64-char hex string (SHA-256)."""
    if not _HEX64_RE.match(identifier_hash):
        raise ValueError(
            "IDENTIFIER_HASH must be a 64-character lowercase hex SHA-256 digest; "
            f"got length={len(identifier_hash)!r} value={identifier_hash[:8]!r}..."
        )
    return identifier_hash.lower()


# Raw anon/device ids (UUIDs / client-generated tokens). FAIL-SAFE sanitization: a value outside
# this charset is SKIPPED with a WARN — never interpolated into SQL (no quotes, no backslashes,
# no whitespace can pass), and a skipped id only means that id's rows are not payload-matched.
_RAW_ID_RE = re.compile(r"^[A-Za-z0-9._:@/-]{1,256}$")


def _sanitize_raw_ids(values: "list[str] | tuple", kind: str) -> list[str]:
    """De-dupe + validate the raw subject ids; drop (and WARN about) anything unsafe to embed."""
    out: list[str] = []
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
    """Single-quoted SQL string literal (defense-in-depth: doubles embedded quotes — the JSON path
    constants legitimately contain single quotes, e.g. $.properties['$device_id'])."""
    return "'" + value.replace("'", "''") + "'"


def _chunks(values: list, size: int):
    for i in range(0, len(values), size):
        yield values[i : i + size]


# ── Helpers ───────────────────────────────────────────────────────────────────────────────────────


def _table_exists(spark: SparkSession, table: str) -> bool:
    """Return True if the raw Bronze table exists in the Iceberg catalog."""
    try:
        spark.sql(f"DESCRIBE TABLE {CATALOG}.{BRONZE_NAMESPACE}.{table}")
        return True
    except Exception:  # noqa: BLE001
        return False


def _col_exists(spark: SparkSession, fqtn: str, col: str) -> bool:
    """Return True if *col* is present in the Iceberg table schema."""
    try:
        schema = spark.table(fqtn).schema
        return any(f.name == col for f in schema.fields)
    except Exception:  # noqa: BLE001
        return False


# ── Core erasure function ─────────────────────────────────────────────────────────────────────────


def erase_subject_raw(
    spark: SparkSession,
    brand_id: str,
    identifier_hash: str,
) -> dict[str, list[str]]:
    """Delete all raw Bronze rows tied to (brand_id, identifier_hash).

    Tenant-isolation invariant: brand_id is ALWAYS the first predicate in every DELETE.
    Idempotent: re-running after a successful delete is a no-op (0 rows affected).

    Returns a dict mapping table_name -> list of column names for which a DELETE was
    successfully issued. Tables that do not exist or have no matching identifier column
    are absent from the result (SKIP is logged). An empty list for a table means it was
    skipped (spend/aggregate lane with no per-subject identifier).

    Exceptions from a single (table, column) DELETE are caught and logged (WARN) so one
    problematic table never aborts the sweep — consistent with bronze_raw_retention posture.
    """
    brand_id = _validate_brand_id(brand_id)
    identifier_hash = _validate_identifier_hash(identifier_hash)

    # Redact PII from logs: log hash prefix only, never brand_id in plaintext.
    brand_prefix = brand_id[:8]
    hash_prefix = identifier_hash[:8]

    results: dict[str, list[str]] = {}

    for table, id_cols in RAW_TABLE_IDENTIFIER_COLS.items():
        fqtn = f"{CATALOG}.{BRONZE_NAMESPACE}.{table}"

        if not id_cols:
            print(
                f"[erasure-raw-delete] SKIP {table}: spend/aggregate lane — no per-subject row",
                flush=True,
            )
            continue

        if not _table_exists(spark, table):
            print(
                f"[erasure-raw-delete] SKIP {table}: table not found in {CATALOG}.{BRONZE_NAMESPACE}",
                flush=True,
            )
            continue

        targeted_cols: list[str] = []
        for col in id_cols:
            if not _col_exists(spark, fqtn, col):
                print(
                    f"[erasure-raw-delete] SKIP {fqtn}.{col}: column absent in schema",
                    flush=True,
                )
                continue

            # brand_id FIRST (tenant isolation), then identifier column.
            # Both values are validated above; safe to interpolate into SQL.
            delete_sql = (
                f"DELETE FROM {fqtn} "
                f"WHERE brand_id = '{brand_id}' "
                f"  AND {col} = '{identifier_hash}'"
            )
            try:
                spark.sql(delete_sql)
                targeted_cols.append(col)
                print(
                    f"[erasure-raw-delete] DELETE {fqtn} "
                    f"WHERE brand_id=<{brand_prefix}...> AND {col}=<{hash_prefix}...>",
                    flush=True,
                )
            except Exception as exc:  # noqa: BLE001
                # Never abort the sweep on a single table/column failure.
                print(
                    f"[erasure-raw-delete] WARN {fqtn}.{col}: {exc}",
                    flush=True,
                )

        results[table] = targeted_cols

    return results


# ── Payload-path predicate erasure (collector_events_connect) ─────────────────────────────────────


def erase_subject_payload_path(
    spark: SparkSession,
    brand_id: str,
    identifier_hash: str,
    anon_ids: "list[str] | tuple" = (),
    device_ids: "list[str] | tuple" = (),
) -> dict[str, int]:
    """PAYLOAD-PATH PREDICATE ERASURE for the payload-only Bronze tables (PAYLOAD_PATH_TABLES).

    Per table, issues DELETEs whose subject predicates are get_json_object() reads INSIDE the
    verbatim envelope `payload` (see the PAYLOAD_PATH_TABLES comment for the grounded paths):
      • one DELETE matching every pre-hashed identifier path against identifier_hash;
      • per PAYLOAD_IN_LIST_CHUNK-sized chunk of anon_ids / device_ids, one DELETE with
        `get_json_object(payload, <path>) IN (<chunk>)` per path.

    TENANT ISOLATION: every DELETE's FIRST predicate is the envelope brand id
    (get_json_object(payload, '$.brand_id') = '<brand_id>') — the table has no brand_id column,
    so the seam lives in the payload; erasure never crosses tenants.

    Iceberg: each DELETE is a copy-on-write/positional delete — rows leave current state now; the
    pre-delete snapshots age out via bronze_maintenance.py expire_snapshots, after which erasure is
    physically complete (D4 posture). Idempotent: re-runs affect 0 rows.

    Returns table_name -> number of DELETE statements successfully issued.
    """
    brand_id = _validate_brand_id(brand_id)
    identifier_hash = _validate_identifier_hash(identifier_hash)
    anon_ids = _sanitize_raw_ids(list(anon_ids), "ANON_IDS")
    device_ids = _sanitize_raw_ids(list(device_ids), "DEVICE_IDS")

    brand_prefix = brand_id[:8]
    hash_prefix = identifier_hash[:8]

    results: dict[str, int] = {}

    for table, spec in PAYLOAD_PATH_TABLES.items():
        fqtn = f"{CATALOG}.{BRONZE_NAMESPACE}.{table}"

        if not _table_exists(spark, table):
            print(
                f"[erasure-raw-delete] SKIP {table}: table not found in {CATALOG}.{BRONZE_NAMESPACE}",
                flush=True,
            )
            continue

        # brand_id FIRST (tenant isolation) — the envelope path, since there is no brand_id column.
        brand_pred = (
            f"get_json_object(payload, {_sql_str(spec['brand_path'])}) = {_sql_str(brand_id)}"
        )

        # Subject predicate groups: (label, OR-of-get_json_object predicates).
        groups: list[tuple[str, str]] = [
            (
                "hash_paths",
                " OR ".join(
                    f"get_json_object(payload, {_sql_str(p)}) = {_sql_str(identifier_hash)}"
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
                            f"get_json_object(payload, {_sql_str(p)}) IN ({in_list})"
                            for p in spec[paths_key]
                        ),
                    )
                )

        issued = 0
        for label, subject_pred in groups:
            delete_sql = f"DELETE FROM {fqtn} WHERE {brand_pred} AND ({subject_pred})"
            try:
                spark.sql(delete_sql)
                issued += 1
                print(
                    f"[erasure-raw-delete] DELETE {fqtn} [{label}] "
                    f"WHERE $.brand_id=<{brand_prefix}...> AND subject=<{hash_prefix}...>",
                    flush=True,
                )
            except Exception as exc:  # noqa: BLE001 — never abort the sweep on one statement
                print(f"[erasure-raw-delete] WARN {fqtn} [{label}]: {exc}", flush=True)

        results[table] = issued

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

    spark = build_spark("brain-erasure-raw-delete")
    spark.sparkContext.setLogLevel("WARN")

    print(
        f"[erasure-raw-delete] START brand=<{brand_id[:8]}...> hash=<{identifier_hash[:8]}...>",
        flush=True,
    )

    results = erase_subject_raw(spark, brand_id, identifier_hash)

    for table, cols in results.items():
        status = f"targeted columns: {cols}" if cols else "no identifier columns found"
        print(f"[erasure-raw-delete] {table}: {status}", flush=True)

    # PAYLOAD-PATH sweep (collector_events_connect): raw anon/device ids come in as optional
    # comma-separated envs supplied by the erasure orchestrator (see module docstring).
    anon_ids = [v for v in os.environ.get("ANON_IDS", "").split(",") if v.strip()]
    device_ids = [v for v in os.environ.get("DEVICE_IDS", "").split(",") if v.strip()]
    payload_results = erase_subject_payload_path(
        spark, brand_id, identifier_hash, anon_ids=anon_ids, device_ids=device_ids
    )
    for table, issued in payload_results.items():
        print(
            f"[erasure-raw-delete] {table}: {issued} payload-path DELETE statement(s) issued "
            "(complete after snapshot expiry — bronze_maintenance.py)",
            flush=True,
        )

    print("[erasure-raw-delete] DONE — Bronze raw erasure sweep complete", flush=True)


if __name__ == "__main__":
    main()
