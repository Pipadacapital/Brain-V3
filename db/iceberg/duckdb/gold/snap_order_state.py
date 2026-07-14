"""
snap_order_state.py (DuckDB) — faithful port of db/iceberg/spark/gold/snap_order_state.py.

The SCD (point-in-time) snapshot of silver_order_state: each run stamps the run-date as snapshot_date and
captures every order's CURRENT state on that day, appending a new day-slice while leaving prior days intact.
Reading the table WHERE snapshot_date <= D and taking the latest row per order reconstructs the order state
AS-OF date D. The dbt predecessor is configured schema='brain_silver', so — like the Spark job — this WRITES
to the brain_silver namespace even though it lives in the gold/ directory and runs in the gold refresh group
(its medallion layer is Silver: point-in-time history of a Silver entity).

SOURCE (pure Iceberg read, no JDBC): {CATALOG}.brain_silver.silver_order_state (built by the Phase-1 job).
TARGET: {CATALOG}.brain_silver.snap_order_state (honoring MIGRATION_TABLE_SUFFIX).

GRAIN / PK: exactly one row per (brand_id, order_id, snapshot_date) — the snapshot PK. brand_id first.
MONEY: order_value_minor carried VERBATIM as bigint MINOR units + sibling currency_code (a pass-through
  snapshot; no aggregation, no float).

THE TRANSFORM (byte-for-byte the dbt / Spark projection):
  select brand_id, order_id, current_date() as snapshot_date, brain_id, lifecycle_state, is_terminal,
         order_value_minor, currency_code, state_effective_at, current_timestamp() as computed_at
  from silver_order_state

SPARK→DUCKDB SQL TRANSLATIONS:
  - current_date()        → current_date  (DuckDB; UTC session → the same run-date as Spark).
  - current_timestamp()   → now() AT TIME ZONE 'UTC'.

WRITE: idempotent MERGE via _base.merge_on_pk on the FULL snapshot PK (brand_id, order_id, snapshot_date) —
  same-day re-run UPDATEs the today-row (no duplicate); a later-day run INSERTs that day's snapshot, prior
  days untouched. The source is already 1 row per (brand_id, order_id), so within a single run it is 1 row
  per PK — merge_on_pk's in-batch dedup is a stable no-op (order_by computed_at is a deterministic tie-break).

QUARANTINE: none — a pass-through snapshot over already-gated Silver has no Stage-1/quarantine side-write;
  the DuckDB framework never writes a quarantine table either. Nothing to skip.

PARITY: snapshot_date = the RUN date on BOTH sides — Spark and DuckDB must run the SAME calendar day for a
  like-for-like comparison (the oracle keys on the full PK incl. snapshot_date). On a given day both sides
  snapshot the same silver_order_state → same today-slice rows. The Spark oracle (60530 rows) accumulates
  MANY prior day-slices; the DuckDB parallel run writes ONLY today's slice (~one row per live order), so
  parity_check compares on the shared today keys (a subset of the multi-day oracle) — see the report.

Parity target: brain_silver.snap_order_state. PK (brand_id, order_id, snapshot_date).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

TABLE = "snap_order_state"
_SUFFIX = os.environ.get("MIGRATION_TABLE_SUFFIX", "")
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.{TABLE}{_SUFFIX}"

# Source AND target both live in brain_silver (the dbt model is schema='brain_silver').
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"

PK = ["brand_id", "order_id", "snapshot_date"]

# Column contract — byte-for-byte the dbt model's output projection. brand_id first; money = bigint minor +
# currency. snapshot_date is a plain DATE (the SCD grain key).
COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  order_id            string    NOT NULL,
  snapshot_date       date      NOT NULL,
  brain_id            string,
  lifecycle_state     string,
  is_terminal         boolean,
  order_value_minor   bigint,
  currency_code       string,
  state_effective_at  timestamp,
  computed_at         timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "snapshot_date", "brain_id", "lifecycle_state", "is_terminal",
    "order_value_minor", "currency_code", "state_effective_at", "computed_at",
]


def build(con):
    # brand-first tenant bucketing + day-partition on the snapshot grain (mirrors the Spark bucket(8,
    # brand_id), days(snapshot_date); bounds storage, prunes the AS-OF read by day).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(8, brand_id), day(snapshot_date)")

    # The dbt snapshot projection, reproduced verbatim (run-date stamp + pass-through state).
    staged = f"""
        SELECT
            brand_id,
            order_id,
            current_date              AS snapshot_date,
            brain_id,
            lifecycle_state,
            is_terminal,
            order_value_minor,
            currency_code,
            state_effective_at,
            now() AT TIME ZONE 'UTC'  AS computed_at
        FROM {SILVER_ORDER_STATE}
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["computed_at"])


if __name__ == "__main__":
    run_job("snap-order-state", build, target_table=TABLE)
