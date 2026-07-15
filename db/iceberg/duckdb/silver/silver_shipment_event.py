"""
silver_shipment_event.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_shipment_event.py.

One canonical Silver transition-log row per (brand_id, event_id) — one row per shipment status
transition — folding stg_shipment_events + the mart projection, read from the gated keystone
rest.brain_silver.silver_collector_event for the ONLY live forward-shipment lane:

  event_type = 'shiprocket.shipment_status.v1'
  (SR-9 / migration 0117 RETIRED 'gokwik.awb_status.v1' → it is NOT folded; RETURNS flow on the
   disjoint shiprocket.return_status.v1 lane into silver_return, never here.)

FOLDED LOGIC (verbatim from the Spark SQL, which is 1:1 with the dbt spec):
  - typed projection from payload.properties.* (prop == get_json_object(payload,'$.properties.x')).
  - keyed: order_id IS NOT NULL AND order_id <> '' (drop un-keyed transitions).
  - terminal_class = coalesce(raw,'none'); is_terminal = (terminal_class <> 'none') — derived, never a raw bool.
  - exception_class (SR-5): separate NON-TERMINAL dimension (∈ {delayed, ndr, null}), projected through.
  - status_changed_at = coalesce(raw, cast(occurred_at AS string)) — a STRING column (varchar in the mart).
  - is_synthetic = (payload.properties.data_source = 'synthetic').
  - dedup: row_number() over (brand_id, event_id ORDER BY occurred_at ASC) == 1 (earliest-occurred wins).

GRAIN: 1 row per (brand_id, event_id). brand_id tenant key. MONEY: none (this mart carries no money).
PII: none raw — awb_number_hash is already hashed.

STAGE-1 DQ GATE (Spark): a timestamp-validity gate (dq_check over occurred_at) diverts future/unparseable
occurred_at rows to brain_silver.silver_quarantine (stage='dq'). The QUARANTINE SIDE-WRITE IS SKIPPED here
(only the main target is produced) — same convention as the other ported jobs. The good-row set is
unaffected: the DuckDB read window is bounded by the same keystone and the occurred_at values are the same
Iceberg timestamptz instants Spark validated, so parity on the written rows holds.

updated_at = now() (current_timestamp() in Spark) — a run-clock column, excluded from parity comparison.

Parity target: brain_silver.silver_shipment_event.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GATED_SOURCE, ensure_table, incremental_window, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to silver_shipment_event_duckdb_test
# instead of the live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_shipment_event{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SHIPMENT_EVENT = "shiprocket.shipment_status.v1"

# Canonical Silver column contract — mirrors brain_silver.silver_shipment_event column-for-column.
# status_changed_at is a STRING (varchar) in the mart — coalesce(raw, cast(occurred_at AS string)).
COLUMNS_SQL = """
  brand_id           string    NOT NULL,
  event_id           string    NOT NULL,
  order_id           string,
  source             string,
  awb_number_hash    string,
  status             string,
  terminal_class     string,
  is_terminal        boolean,
  exception_class    string,
  payment_method     string,
  pincode            string,
  courier            string,
  status_changed_at  string,
  occurred_at        timestamp,
  is_synthetic       boolean,
  updated_at         timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "order_id", "source", "awb_number_hash", "status",
    "terminal_class", "is_terminal", "exception_class", "payment_method", "pincode",
    "courier", "status_changed_at", "occurred_at", "is_synthetic", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   Per-event grain (1 row per brand_id, event_id via the idempotent MERGE), so narrowing the keystone
    #   read to the [lo,hi) ingested_at window is safe. Default OFF → (None, None) → read_gated_events_sql
    #   omits the window predicate → full scan, byte-identical to before.
    lo, hi = incremental_window(con, "silver-shipment-event", GATED_SOURCE, ts_col="ingested_at")

    # ── stg_shipment_events: typed projection from the gated keystone's shipment lane. ──
    src = f"""
      SELECT
        brand_id,
        event_id,
        {prop('pj','order_id')}         AS order_id,
        {prop('pj','source')}           AS source,
        {prop('pj','awb_number_hash')}  AS awb_number_hash,
        {prop('pj','status')}           AS status,
        {prop('pj','terminal_class')}   AS terminal_class,
        {prop('pj','exception_class')}  AS exception_class,
        {prop('pj','payment_method')}   AS payment_method,
        {prop('pj','pincode')}          AS pincode,
        {prop('pj','courier')}          AS courier,
        {prop('pj','status_changed_at')} AS status_changed_at,
        CASE WHEN {prop('pj','data_source')} = 'synthetic' THEN true ELSE false END AS is_synthetic,
        occurred_at
      FROM ({read_gated_events_sql([SHIPMENT_EVENT], lo=lo, hi=hi)})
    """

    # keyed: drop un-keyed transitions (order_id present + non-empty).
    keyed = f"""
      SELECT * FROM ({src})
      WHERE order_id IS NOT NULL AND order_id <> ''
    """

    # dedup: one row per (brand_id, event_id), earliest occurred_at wins (Spark ORDER BY occurred_at ASC).
    deduped = f"""
      SELECT * FROM (
        SELECT *, row_number() OVER (
          PARTITION BY brand_id, event_id ORDER BY occurred_at ASC
        ) AS _dedup_rn
        FROM ({keyed})
      ) WHERE _dedup_rn = 1
    """

    # Mart projection: derive terminal_class/is_terminal/status_changed_at + updated_at run-clock.
    staged = f"""
      SELECT
        brand_id,
        event_id,
        order_id,
        source,
        awb_number_hash,
        status,
        coalesce(terminal_class, 'none')                          AS terminal_class,
        (coalesce(terminal_class, 'none') <> 'none')             AS is_terminal,
        exception_class,
        payment_method,
        pincode,
        courier,
        coalesce(status_changed_at, CAST(occurred_at AS VARCHAR)) AS status_changed_at,
        occurred_at,
        is_synthetic,
        now() AS updated_at
      FROM ({deduped})
    """

    # PK (brand_id, event_id) per-event grain. The Spark job keeps earliest-occurred (done in `deduped`
    # above); merge_on_pk's DESC re-dedup is a no-op here since each PK already has exactly one row.
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["occurred_at"])


if __name__ == "__main__":
    run_job("silver-shipment-event", build, target_table="silver_shipment_event")
