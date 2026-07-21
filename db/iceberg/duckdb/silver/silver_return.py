"""
silver_return.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_return.py.

The canonical RETURN mart: folds the NEW canonical `shiprocket.return_status.v1` events out of the
gated collector lane (rest.brain_silver.silver_collector_event, ADR-0006 P3) into a per-(brand,order_id)
LATEST-return-state mart (rest.brain_silver.silver_return), via an idempotent MERGE on the model PK
(brand_id, order_id). It mirrors silver_shipment.py but for RETURNS — a SEPARATE lifecycle that must
NEVER be confused with forward delivery or RTO: this mart carries NO terminal_class column, so it can
never leak into the CoD/delivery ledger as a false delivery.

GRAIN : 1 row per (brand_id, order_id) — latest return state per order. brand_id tenant key.
PII   : none raw — awb_number_hash + hashed_customer_{email,phone} are already hashed at the mapper.
MONEY : none (returns carry no money column here — refund money is the ledger's job, off this mart).

FOLD (verbatim from the Spark SQL):
  - src = shiprocket.return_status.v1 events, projecting the ShiprocketReturnProperties shape, filtered
    to order_id IS NOT NULL AND order_id <> ''.
  - ranked: row_number() over (partition by brand_id, order_id ORDER BY
      is_return_complete DESC, status_changed_at DESC, occurred_at DESC, event_id DESC) — terminal
      (return_completed) wins, then latest status_changed_at (STRING lexical DESC, same as Spark), then
      latest occurred_at, then highest event_id (deterministic tie-break).
    first_event_at = min(occurred_at) over (partition by brand_id, order_id).
  - latest row per (brand_id, order_id): _win_rn == 1, projecting current_status = status,
    last_status_at = status_changed_at (STRING), + first_event_at + now() AS updated_at.
  status_changed_at = coalesce(properties.status_changed_at, cast(occurred_at as string)).
  is_synthetic = (properties.data_source == 'synthetic').
  return_class = coalesce(properties.return_class, 'none'); is_return_complete = (properties.is_return_complete == 'true').

STAGE-1 GATE (Brain V4): the Spark job runs a Stage-1 DQ TIMESTAMP gate over occurred_at (future/
  unparseable → quarantine, stage='dq', never written) then folds. This DuckDB port has no
  _silver_technical analogue, so — matching the framework's other ports (silver_payment/silver_refund/
  silver_order_line) — it does NOT write the silver_quarantine side-table and does NOT re-implement the
  dq drop; Bronze keeps the originals (replay-safe), so the quarantine ledger can be rebuilt separately.
  The mart's own admission (order_id present, non-empty) is preserved. Good rows are identical.

updated_at = now() (current_timestamp() in Spark) — a run-clock column, excluded from parity.

Parity target: brain_silver.silver_return.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import (  # noqa: E402
    GATED_SOURCE,
    ensure_table,
    incremental_window,
    merge_on_pk,
    prop,
    read_gated_events_sql,
    run_job,
)
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_return_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_return{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

RETURN_EVENT_TYPE = "shiprocket.return_status.v1"

# Canonical Silver column contract — mirrors brain_silver.silver_return column-for-column.
# last_status_at is a STRING (varchar) — it carries status_changed_at, a string.
COLUMNS_SQL = """
  brand_id               string    NOT NULL,
  order_id               string    NOT NULL,
  source                 string,
  awb_number_hash        string,
  courier                string,
  current_status         string,
  return_class           string,
  is_return_complete     boolean,
  payment_method         string,
  pincode                string,
  hashed_customer_email  string,
  hashed_customer_phone  string,
  first_event_at         timestamp,
  last_status_at         string,
  is_synthetic           boolean,
  updated_at             timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "source", "awb_number_hash", "courier", "current_status",
    "return_class", "is_return_complete", "payment_method", "pincode",
    "hashed_customer_email", "hashed_customer_phone", "first_event_at", "last_status_at",
    "is_synthetic", "updated_at",
]


def build(con):
    # Latest-state grain: partition by brand bucket + day(first_event_at) (always present for any order
    # with events) — matches the Spark partitioning (bucket(256, brand_id), days(first_event_at)).
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) — ENTITY-FOLD grain (CHANGED-ENTITY REFOLD) ────
    #   GRAIN = entity_fold: MANY return-transition events aggregate/rank into ONE (brand_id, order_id)
    #   latest-state row whose winner may be a transition BELOW the watermark (an old return that just got
    #   a new event). So we MUST NOT window the fold input — that would drop history and pick a wrong latest
    #   state. Instead: use the [lo, hi) window ONLY to discover which (brand_id, order_id) entities have a
    #   NEW event this batch, then re-fold each of those entities over their FULL history. Default OFF →
    #   lo=None → NO changed-set, NO semi-join → byte-identical full recompute.
    lo, hi = incremental_window(con, "silver-return", GATED_SOURCE, ts_col="ingested_at")

    # changed = the entities touched in [lo, hi), derived with the SAME entity-key guards the fold uses
    # (order_id present, non-empty). Built ONLY when incremental is active; empty string when lo is None.
    changed = f"""
      SELECT DISTINCT brand_id, {prop('pj','order_id')} AS order_id
      FROM ({read_gated_events_sql([RETURN_EVENT_TYPE], lo=lo, hi=hi)})
      WHERE {prop('pj','order_id')} IS NOT NULL AND {prop('pj','order_id')} <> ''
    """

    # ── src: project the canonical return properties out of the gated collector lane (1 row/transition).
    # status_changed_at = coalesce(properties.status_changed_at, cast(occurred_at as string)) — verbatim.
    # FULL, UNWINDOWED read of the fold input; the lo-guarded semi-join narrows it to CHANGED entities only,
    # each re-folded over its complete history. When lo is None the extra predicate is absent (full scan). ──
    src_semijoin = (
        f"\n        AND (brand_id, {prop('pj','order_id')}) "
        f"IN (SELECT brand_id, order_id FROM ({changed}))"
        if lo is not None else ""
    )
    src = f"""
      SELECT
        brand_id,
        event_id,
        occurred_at,
        {prop('pj','source')}               AS source,
        {prop('pj','order_id')}             AS order_id,
        {prop('pj','awb_number_hash')}      AS awb_number_hash,
        {prop('pj','courier')}              AS courier,
        {prop('pj','status')}               AS status,
        coalesce({prop('pj','return_class')}, 'none')            AS return_class,
        ({prop('pj','is_return_complete')} = 'true')            AS is_return_complete,
        {prop('pj','payment_method')}       AS payment_method,
        {prop('pj','pincode')}              AS pincode,
        {prop('pj','hashed_customer_email')} AS hashed_customer_email,
        {prop('pj','hashed_customer_phone')} AS hashed_customer_phone,
        coalesce({prop('pj','status_changed_at')}, CAST(occurred_at AS VARCHAR)) AS status_changed_at,
        CASE WHEN {prop('pj','data_source')} = 'synthetic' THEN true ELSE false END AS is_synthetic
      FROM ({read_gated_events_sql([RETURN_EVENT_TYPE])})
      WHERE {prop('pj','order_id')} IS NOT NULL AND {prop('pj','order_id')} <> ''{src_semijoin}
    """

    # ── ranked: terminal (return_completed) wins, then latest status_changed_at (STRING lexical DESC),
    # then latest occurred_at, then highest event_id. first_event_at = min(occurred_at) over the order. ──
    ranked = f"""
      SELECT *,
             row_number() OVER (
               PARTITION BY brand_id, order_id
               ORDER BY is_return_complete DESC,
                        status_changed_at  DESC,
                        occurred_at        DESC,
                        event_id           DESC
             ) AS _win_rn,
             min(occurred_at) OVER (PARTITION BY brand_id, order_id) AS first_event_at
      FROM ({src})
    """

    staged = f"""
      SELECT
        brand_id,
        order_id,
        source,
        awb_number_hash,
        courier,
        status              AS current_status,
        return_class,
        is_return_complete,
        payment_method,
        pincode,
        hashed_customer_email,
        hashed_customer_phone,
        first_event_at,
        status_changed_at   AS last_status_at,
        is_synthetic,
        now()               AS updated_at
      FROM ({ranked})
      WHERE _win_rn = 1
    """

    # PK (brand_id, order_id). Source is already 1 row per PK (the _win_rn=1 filter), so merge_on_pk's
    # in-batch DESC re-dedup is a no-op. order_by_desc kept for framework-shape consistency.
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "order_id"],
                       order_by_desc=["first_event_at"])


if __name__ == "__main__":
    run_job("silver-return", build, target_table="silver_return")
