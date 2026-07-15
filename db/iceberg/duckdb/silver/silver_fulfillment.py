"""
silver_fulfillment.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_fulfillment.py.

The storefront-side fulfillment grain — per-fulfillment status + tracking for an order, distinct from
silver_shipment (the LOGISTICS-carrier status). Folds fulfillment.recorded.v1 out of the gated keystone
into a latest-STATE-per-fulfillment mart via an idempotent MERGE.

GRAIN : 1 row per (brand_id, fulfillment_id) — the upstream-immutable fulfillment id (NOT event_id: a
        status change re-emits the SAME fulfillment_id with a newer occurred_at → latest-ingested-wins
        MERGE carries the latest state). event_id is retained as provenance (a projected column, not the PK).
MONEY : none. PII: tracking_number is a carrier waybill ref (not person-linkable).
ISOLATION: brand_id first + bucket() anchor.

QUARANTINE SKIPPED: the Spark job runs a Stage-1 DQ timestamp gate over occurred_at → silver_quarantine
  (stage='dq') before the MERGE. The migration framework has no quarantine seam, so — matching the other
  ports — this port does NOT write the side-table and does NOT re-implement the dq drop; Bronze keeps the
  originals (replay-safe). The mart's own admission (fulfillment_id + brand_id present) is preserved.

DATA AVAILABILITY: Bronze holds ZERO fulfillment.recorded.v1 today (the dedicated fulfillment resource is
  unsynced), so this writes a correct EMPTY table; a Shopify fulfillment repull populates it with no change.

Parity target: brain_silver.silver_fulfillment (NEW — no dbt/StarRocks baseline).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, incremental_window, merge_on_pk, prop, read_gated_events_sql, run_job, GATED_SOURCE  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_fulfillment_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_fulfillment{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

FULFILLMENT_EVENT = "fulfillment.recorded.v1"

# brand_id-first; latest-state grain on fulfillment_id; no money column. event_id = provenance, not PK.
COLUMNS_SQL = """
  brand_id          string    NOT NULL,
  fulfillment_id    string    NOT NULL,
  source            string,
  order_id          string,
  status            string,
  shipment_status   string,
  tracking_company  string,
  tracking_number   string,
  event_id          string,
  occurred_at       timestamp NOT NULL,
  ingested_at       timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "fulfillment_id", "source", "order_id", "status", "shipment_status",
    "tracking_company", "tracking_number", "event_id", "occurred_at", "ingested_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1). per_event grain over the gated keystone → windowing
    # the source read is safe. Default OFF → (None, None) → read_gated_events_sql omits the predicate → full
    # scan, byte-identical to before.
    lo, hi = incremental_window(con, "silver-fulfillment", GATED_SOURCE, ts_col="ingested_at")

    staged = f"""
      SELECT {', '.join(COLUMNS)} FROM (
        SELECT
          brand_id,
          coalesce({prop('pj','fulfillment_id')}, {prop('pj','shopify_fulfillment_id')}) AS fulfillment_id,
          {prop('pj','source')}            AS source,
          {prop('pj','order_id')}          AS order_id,
          {prop('pj','status')}            AS status,
          {prop('pj','shipment_status')}   AS shipment_status,
          {prop('pj','tracking_company')}  AS tracking_company,
          {prop('pj','tracking_number')}   AS tracking_number,
          event_id,
          occurred_at, ingested_at
        FROM ({read_gated_events_sql([FULFILLMENT_EVENT], lo=lo, hi=hi)})
      )
      WHERE fulfillment_id IS NOT NULL AND brand_id IS NOT NULL
    """

    # Latest-state-wins on the fulfillment id: a status change is a newer-occurred_at re-emission.
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "fulfillment_id"],
                       order_by_desc=["occurred_at", "ingested_at"])


if __name__ == "__main__":
    run_job("silver-fulfillment", build, target_table="silver_fulfillment")
