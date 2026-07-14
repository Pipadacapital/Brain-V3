"""
snap_identity_link.py (DuckDB) — faithful port of db/iceberg/spark/gold/snap_identity_link.py.

The AS-OF (point-in-time) identity-link snapshot — the identity-graph mirror of snap_order_state. Each run
stamps the run-date as snapshot_date and captures every active identity LINK's CURRENT (brain_id, is_active)
on that day, appending a new day-slice while leaving prior days intact. Reading WHERE snapshot_date <= D and
taking the latest row per identifier reconstructs the identity link AS-OF date D — the HISTORICAL brain_id an
identifier resolved to on that day, deterministic time-travel over the identity graph.

NAMESPACE: like snap_order_state this is a point-in-time history of a SILVER entity, so it WRITES to the
  brain_silver namespace (not brain_gold), honoring MIGRATION_TABLE_SUFFIX. It lives in gold/ and runs in the
  gold refresh group, but its medallion layer is Silver.

SOURCE (pure Iceberg read, no JDBC): {CATALOG}.brain_silver.silver_identity_alias — the Spark→Iceberg
  projection of the Neo4j IDENTIFIES edges (grain brand_id, identifier_type, identifier_value, brain_id,
  is_active). Neo4j remains the identity SoR; brain_id is only ever carried through here, never minted.

GRAIN / PK: exactly one row per (brand_id, identifier_type, identifier_value, snapshot_date). brand_id first.
PII: identifier_value is a 64-hex HASH only (the resolver hashes raw identifiers at the boundary) — this job
  NEVER reads or writes a raw email/phone. NO money columns (an identity mapping carries none).

THE TRANSFORM (byte-for-byte the Spark projection):
  select brand_id, identifier_type, identifier_value, current_date() as snapshot_date, brain_id, is_active,
         current_timestamp() as computed_at
  from silver_identity_alias

SPARK→DUCKDB SQL TRANSLATIONS:
  - current_date()        → current_date  (UTC session → same run-date as Spark).
  - current_timestamp()   → now() AT TIME ZONE 'UTC'.

WRITE: idempotent MERGE via _base.merge_on_pk on the FULL snapshot PK — same-day re-run UPDATEs the
  today-row; a later-day run INSERTs that day's snapshot, prior days untouched. The source is already 1 row
  per (brand_id, identifier_type, identifier_value), so within a run it is 1 row per PK — the in-batch dedup
  is a stable no-op (order_by computed_at is a deterministic tie-break).

QUARANTINE: none — a pass-through snapshot over already-gated Silver has no Stage-1/quarantine side-write.

PARITY: snapshot_date = the RUN date on BOTH sides — run same-day for a like-for-like comparison. The Spark
  oracle (105497 rows) accumulates MANY prior day-slices; the DuckDB parallel run writes ONLY today's slice
  (~one row per live alias, 31565), so parity_check compares on the shared today keys — see the report.

Parity target: brain_silver.snap_identity_link. PK (brand_id, identifier_type, identifier_value, snapshot_date).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

TABLE = "snap_identity_link"
_SUFFIX = os.environ.get("MIGRATION_TABLE_SUFFIX", "")
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.{TABLE}{_SUFFIX}"

# Source AND target both live in brain_silver (a point-in-time history of a Silver entity).
SILVER_IDENTITY_ALIAS = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_alias"

PK = ["brand_id", "identifier_type", "identifier_value", "snapshot_date"]

# Column contract — the snapshot PK + carried link state. brand_id tenant key first; NO money, hash-only.
COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  identifier_type     string    NOT NULL,
  identifier_value    string    NOT NULL,
  snapshot_date       date      NOT NULL,
  brain_id            string,
  is_active           boolean,
  computed_at         timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "identifier_type", "identifier_value", "snapshot_date", "brain_id", "is_active",
    "computed_at",
]


def build(con):
    # Brand-first tenant bucketing + day-partition on the snapshot grain (mirrors the Spark bucket(8,
    # brand_id), days(snapshot_date)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(8, brand_id), day(snapshot_date)")

    # The snapshot projection: run-date stamp + pass-through link state.
    staged = f"""
        SELECT
            brand_id,
            identifier_type,
            identifier_value,
            current_date              AS snapshot_date,
            brain_id,
            is_active,
            now() AT TIME ZONE 'UTC'  AS computed_at
        FROM {SILVER_IDENTITY_ALIAS}
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["computed_at"])


if __name__ == "__main__":
    run_job("snap-identity-link", build, target_table=TABLE)
