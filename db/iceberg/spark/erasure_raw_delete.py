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
  BRAND_ID=<uuid> IDENTIFIER_HASH=<64-char sha256 hex> spark-submit erasure_raw_delete.py

As a callable from another Spark job or test:
  from erasure_raw_delete import erase_subject_raw
  summary = erase_subject_raw(spark, brand_id="...", identifier_hash="...")

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
RAW_TABLE_IDENTIFIER_COLS: dict[str, list[str]] = {
    "collector_events_raw": ["identifier_hash", "anonymous_id"],
    "shopify_orders_raw": ["identifier_hash", "email_hash"],
    "woocommerce_orders_raw": ["identifier_hash", "email_hash"],
    "meta_spend_raw": [],        # aggregate spend — no per-subject identifier
    "google_spend_raw": [],      # aggregate spend — no per-subject identifier
    "ga4_rows_raw": ["identifier_hash", "client_id"],
    "shiprocket_shipments_raw": ["identifier_hash"],
    "gokwik_events_raw": ["identifier_hash"],
    "shopflo_checkout_raw": ["identifier_hash"],
    "razorpay_settlement_raw": ["identifier_hash"],
}

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

    print("[erasure-raw-delete] DONE — Bronze raw erasure sweep complete", flush=True)


if __name__ == "__main__":
    main()
