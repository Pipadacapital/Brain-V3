"""
silver_shipment.py (DuckDB) — latest shipment state per order, derived DIRECTLY from the gated
keystone (DR-002 Group 4: the former silver_shipment_event materialized transition log is FOLDED
in here — its only consumer was this job, so the intermediate table is gone; the raw transitions
remain replayable from Bronze/keystone forever).

Reads rest.brain_silver.silver_collector_event for the ONLY live forward-shipment lane:

  event_type = 'shiprocket.shipment_status.v1'
  (SR-9 / migration 0117 RETIRED 'gokwik.awb_status.v1' → it is NOT folded; RETURNS flow on the
   disjoint shiprocket.return_status.v1 lane into silver_return, never here.)

TRANSITION DERIVATION (verbatim from the retired silver_shipment_event.py, 1:1 with the Spark/dbt spec):
  - typed projection from payload.properties.* (prop == get_json_object(payload,'$.properties.x')).
  - keyed: order_id IS NOT NULL AND order_id <> '' (drop un-keyed transitions).
  - terminal_class = coalesce(raw,'none'); is_terminal = (terminal_class <> 'none') — derived, never a raw bool.
  - status_changed_at = coalesce(raw, cast(occurred_at AS string)) — a STRING column (varchar in the mart).
  - is_synthetic = (payload.properties.data_source = 'synthetic').
  - dedup: row_number() over (brand_id, event_id ORDER BY occurred_at ASC) == 1 (earliest-occurred wins).

FOLD (verbatim from the pre-DR-002 two-job chain, 1:1 with dbt silver_shipment.sql):
  - ranked: row_number() over (partition by brand_id, order_id ORDER BY
      is_terminal DESC, status_changed_at DESC, occurred_at DESC, event_id DESC) — terminal-state wins,
      then latest status_changed_at (STRING — lexical DESC, same as Spark), then latest occurred_at,
      then highest event_id (deterministic tie-break).
    first_event_at = min(occurred_at) over (partition by brand_id, order_id).
  - latest row per (brand_id, order_id): _win_rn == 1, projecting current_status/is_rto/is_delivered/
    last_status_at + first_event_at + now() AS updated_at.

GRAIN : 1 row per (brand_id, order_id) — latest shipment state per order. brand_id tenant key.
PII   : none raw — awb_number_hash already hashed.  MONEY: none (this mart carries no money).
last_status_at is a STRING (varchar) — it carries status_changed_at verbatim.
updated_at = now() (current_timestamp() in Spark) — a run-clock column, excluded from parity.

INCREMENTAL (opt-in; SILVER_INCREMENTAL=1) — GRAIN = entity_fold: MANY transitions collapse to ONE
(brand_id, order_id) row whose value depends on events that may sit BELOW the watermark, so the fold
input is NEVER windowed directly. The [lo,hi) keystone ingested_at window discovers the CHANGED order
keys only; each changed order re-folds over its FULL transition history. Default OFF (lo=None) →
byte-identical full re-fold. NOTE: pre-DR-002 this job's watermark tracked the intermediate table's
updated_at; the source is now the keystone's ingested_at — before ever enabling SILVER_INCREMENTAL,
clear the 'silver-shipment' row from silver_job_watermark (runbook'd in DR-002).

Parity target: brain_silver.silver_shipment (fold output is 1:1 with the retired two-job chain).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GATED_SOURCE, ensure_table, incremental_window, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_shipment_duckdb_test beside the
# live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_shipment{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SHIPMENT_EVENT = "shiprocket.shipment_status.v1"

# Canonical Silver column contract — mirrors brain_silver.silver_shipment column-for-column.
# last_status_at is a STRING (varchar) — it carries status_changed_at, a string.
COLUMNS_SQL = """
  brand_id         string    NOT NULL,
  order_id         string    NOT NULL,
  source           string,
  awb_number_hash  string,
  courier          string,
  current_status   string,
  terminal_class   string,
  is_terminal      boolean,
  is_rto           boolean,
  is_delivered     boolean,
  payment_method   string,
  pincode          string,
  first_event_at   timestamp,
  last_status_at   string,
  is_synthetic     boolean,
  updated_at       timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "source", "awb_number_hash", "courier", "current_status",
    "terminal_class", "is_terminal", "is_rto", "is_delivered", "payment_method", "pincode",
    "first_event_at", "last_status_at", "is_synthetic", "updated_at",
]


def _transitions_sql(lo=None, hi=None) -> str:
    """The retired silver_shipment_event derivation, inlined: typed projection → keyed → dedup →
    mart projection (terminal_class/is_terminal/status_changed_at coalesces). One row per
    (brand_id, event_id). lo/hi window the KEYSTONE read (changed-key discovery only — the fold
    itself always receives the unwindowed derivation)."""
    src = f"""
      SELECT
        brand_id,
        event_id,
        {prop('pj','order_id')}         AS order_id,
        {prop('pj','source')}           AS source,
        {prop('pj','awb_number_hash')}  AS awb_number_hash,
        {prop('pj','status')}           AS status,
        {prop('pj','terminal_class')}   AS terminal_class,
        {prop('pj','payment_method')}   AS payment_method,
        {prop('pj','pincode')}          AS pincode,
        {prop('pj','courier')}          AS courier,
        {prop('pj','status_changed_at')} AS status_changed_at,
        CASE WHEN {prop('pj','data_source')} = 'synthetic' THEN true ELSE false END AS is_synthetic,
        occurred_at
      FROM ({read_gated_events_sql([SHIPMENT_EVENT], lo=lo, hi=hi)})
    """
    keyed = f"""
      SELECT * FROM ({src})
      WHERE order_id IS NOT NULL AND order_id <> ''
    """
    deduped = f"""
      SELECT * FROM (
        SELECT *, row_number() OVER (
          PARTITION BY brand_id, event_id ORDER BY occurred_at ASC
        ) AS _dedup_rn
        FROM ({keyed})
      ) WHERE _dedup_rn = 1
    """
    return f"""
      SELECT
        brand_id,
        event_id,
        order_id,
        source,
        awb_number_hash,
        status,
        coalesce(terminal_class, 'none')                          AS terminal_class,
        (coalesce(terminal_class, 'none') <> 'none')              AS is_terminal,
        payment_method,
        pincode,
        courier,
        coalesce(status_changed_at, CAST(occurred_at AS VARCHAR)) AS status_changed_at,
        occurred_at,
        is_synthetic
      FROM ({deduped})
    """


def build(con):
    # Latest-state grain has no NOT-NULL event-time col across the grain; partition by brand bucket +
    # day(first_event_at) (always present for any order with events) — matches the Spark partitioning.
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(first_event_at)")

    lo, hi = incremental_window(con, "silver-shipment", GATED_SOURCE, ts_col="ingested_at")

    # The fold reads the FULL, UNWINDOWED derivation; when incremental is on, a semi-join narrows it to
    # ONLY the changed orders so each re-folds over its COMPLETE history. When lo is None the extra
    # predicate is absent → byte-identical full scan.
    fold_source = f"({_transitions_sql()})"
    if lo is not None:
        changed = f"SELECT DISTINCT brand_id, order_id FROM ({_transitions_sql(lo=lo, hi=hi)})"
        fold_source = (
            f"(SELECT * FROM ({_transitions_sql()}) "
            f"WHERE (brand_id, order_id) IN ({changed}))"
        )

    # ranked: terminal-state wins, then latest status_changed_at (STRING lexical DESC), then latest
    # occurred_at, then highest event_id. first_event_at = min(occurred_at) over the order partition.
    ranked = f"""
      SELECT *,
             row_number() OVER (
               PARTITION BY brand_id, order_id
               ORDER BY is_terminal        DESC,
                        status_changed_at  DESC,
                        occurred_at        DESC,
                        event_id           DESC
             ) AS _win_rn,
             min(occurred_at) OVER (PARTITION BY brand_id, order_id) AS first_event_at
      FROM {fold_source}
    """

    staged = f"""
      SELECT
        brand_id,
        order_id,
        source,
        awb_number_hash,
        courier,
        status                         AS current_status,
        terminal_class,
        is_terminal,
        (terminal_class = 'rto')       AS is_rto,
        (terminal_class = 'delivered') AS is_delivered,
        payment_method,
        pincode,
        first_event_at,
        status_changed_at              AS last_status_at,
        is_synthetic,
        now()                          AS updated_at
      FROM ({ranked})
      WHERE _win_rn = 1
    """

    # PK (brand_id, order_id). Source is already 1 row per PK (the _win_rn=1 filter), so merge_on_pk's
    # in-batch DESC re-dedup is a no-op. order_by_desc kept for framework-shape consistency.
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "order_id"],
                       order_by_desc=["first_event_at"])


if __name__ == "__main__":
    run_job("silver-shipment", build, target_table="silver_shipment")
