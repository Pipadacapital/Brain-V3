"""
silver_checkout_signal.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_checkout_signal.py.

Folds stg_checkout_signal_events → the silver_checkout_signal mart in ONE gated read over the keystone
rest.brain_silver.silver_collector_event (ADR-0006 P3 — the Spark job's BRONZE_TABLE is that same gated
source, NOT raw Bronze). Eight checkout-funnel event types → typed projection → earliest-occurred dedup →
TTL guard → idempotent MERGE on (brand_id, event_id). Parity target: brain_silver.silver_checkout_signal.

FAITHFUL to the Spark build():
  - event_type IN the 8 gokwik/shopflo checkout-funnel lanes.
  - signal_type / source CASE discriminants verbatim (source prefers payload.properties.source, falls
    back to the event_type map).
  - money: total_price_minor / total_discount_minor cast to BIGINT minor units (+ currency_code).
  - has_address / is_synthetic booleans from the JSON string flags.
  - dedup: row_number over (brand_id, event_id) ORDER BY occurred_at ASC == 1 (earliest-occurred wins).
  - TTL/partition guard: occurred_at IS NOT NULL AND occurred_at >= now() - {TTL_DAYS} days.
  - updated_at = now() (the mart's current_timestamp()).

CAVEAT — quarantine side-write SKIPPED: the Spark job diverts Stage-1 dq failures (negative/non-integer
amount, invalid/missing currency, future/unparseable occurred_at) to brain_silver.silver_quarantine
(stage='dq') and drops them from the mart. This DuckDB port does NOT write the quarantine side-table
(no _silver_technical analogue here). It DOES preserve the mart's own admission filter (the TTL guard and
NOT-NULL occurred_at); Bronze keeps the originals, so the quarantine ledger can be rebuilt separately.
Good rows are data-equivalent to the Spark mart output.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GATED_SOURCE, ensure_table, incremental_window, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_checkout_signal_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_checkout_signal{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# The 8 checkout-funnel lanes (gokwik/shopflo namespaced + the source-neutral checkout.abandoned.v1).
SIGNAL_EVENTS = [
    "gokwik.rto_predict.v1", "shopflo.checkout_abandoned.v1",
    "checkout.abandoned.v1", "gokwik.checkout_started.v1", "gokwik.checkout_step.v1",
    "shopflo.checkout_started.v1", "shopflo.checkout_step.v1", "shopflo.checkout_completed.v1",
]

# TTL/partition-window guard from the dbt mart (interval 400 day). Overridable for a full backfill.
TTL_DAYS = int(os.environ.get("CHECKOUT_SIGNAL_TTL_DAYS", "400"))

# Canonical Silver column contract — mirrors the Spark mart DDL column-for-column. Money is bigint
# minor units + currency_code (HARD RULE).
COLUMNS_SQL = """
  brand_id              string    NOT NULL,
  event_id              string    NOT NULL,
  signal_type           string,
  source                string,
  order_id              string,
  risk_flag             string,
  total_price_minor     bigint,
  total_discount_minor  bigint,
  has_address           boolean,
  currency_code         string,
  occurred_at           timestamp,
  is_synthetic          boolean,
  updated_at            timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "signal_type", "source", "order_id", "risk_flag",
    "total_price_minor", "total_discount_minor", "has_address", "currency_code",
    "occurred_at", "is_synthetic", "updated_at",
]

# signal_type discriminant — verbatim CASE port (event_type → signal_type).
_SIGNAL_TYPE = (
    "CASE event_type "
    "WHEN 'gokwik.rto_predict.v1'          THEN 'rto_predict' "
    "WHEN 'shopflo.checkout_abandoned.v1'  THEN 'checkout_abandoned' "
    "WHEN 'checkout.abandoned.v1'          THEN 'checkout_abandoned' "
    "WHEN 'gokwik.checkout_started.v1'     THEN 'checkout_started' "
    "WHEN 'gokwik.checkout_step.v1'        THEN 'checkout_step' "
    "WHEN 'shopflo.checkout_started.v1'    THEN 'checkout_started' "
    "WHEN 'shopflo.checkout_step.v1'       THEN 'checkout_step' "
    "WHEN 'shopflo.checkout_completed.v1'  THEN 'checkout_completed' END"
)

# SOURCE discriminant — prefer the mapper-stamped payload.properties.source (gokwik|shopflo); fall back
# to the event_type map for the namespaced events (verbatim COALESCE(get_json_object(...), CASE ...)).
_SOURCE = (
    "COALESCE(json_extract_string(pj, '$.properties.source'), "
    "CASE event_type "
    "WHEN 'gokwik.rto_predict.v1'          THEN 'gokwik' "
    "WHEN 'shopflo.checkout_abandoned.v1'  THEN 'shopflo' "
    "WHEN 'checkout.abandoned.v1'          THEN 'gokwik' "
    "WHEN 'gokwik.checkout_started.v1'     THEN 'gokwik' "
    "WHEN 'gokwik.checkout_step.v1'        THEN 'gokwik' "
    "WHEN 'shopflo.checkout_started.v1'    THEN 'shopflo' "
    "WHEN 'shopflo.checkout_step.v1'       THEN 'shopflo' "
    "WHEN 'shopflo.checkout_completed.v1'  THEN 'shopflo' END)"
)


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   PER-EVENT admission over the gated keystone: each source row → 0..1 mart row via the idempotent
    #   MERGE on (brand_id, event_id), so windowing the source read on ingested_at is safe. Default OFF →
    #   (None, None) → read_gated_events_sql omits the window predicate → SQL byte-identical (full scan).
    lo, hi = incremental_window(con, "silver-checkout-signal", GATED_SOURCE, ts_col="ingested_at")

    typed = f"""
      SELECT
        brand_id,
        event_id,
        {_SIGNAL_TYPE} AS signal_type,
        {_SOURCE} AS source,
        {prop('pj','order_id')} AS order_id,
        {prop('pj','risk_flag')} AS risk_flag,
        CAST({prop('pj','total_price_minor')}    AS BIGINT) AS total_price_minor,
        CAST({prop('pj','total_discount_minor')} AS BIGINT) AS total_discount_minor,
        CASE WHEN {prop('pj','has_address')} = 'true' THEN true ELSE false END AS has_address,
        {prop('pj','currency_code')} AS currency_code,
        occurred_at,
        CASE WHEN {prop('pj','data_source')} = 'synthetic' THEN true ELSE false END AS is_synthetic,
        now() AS updated_at
      FROM ({read_gated_events_sql(SIGNAL_EVENTS, lo=lo, hi=hi)})
    """

    # Mart admission filter: TTL/partition guard + NOT-NULL occurred_at (matches the Spark mart WHERE),
    # then the Spark staging dedup EARLIEST-occurred-wins (row_number ... ORDER BY occurred_at ASC == 1).
    # The base merge_on_pk only dedups DESC, so we reproduce the ASC dedup here; merge_on_pk's inner
    # DESC pass is then a no-op on the already-unique PKs (belt-and-braces, exactly as the Spark job).
    good = f"""
      SELECT {', '.join(COLUMNS)} FROM (
        SELECT *, row_number() OVER (PARTITION BY brand_id, event_id ORDER BY occurred_at ASC) AS _mrn
        FROM ({typed})
        WHERE occurred_at IS NOT NULL
          AND occurred_at >= now() - INTERVAL {TTL_DAYS} DAY
      ) WHERE _mrn = 1
    """

    return merge_on_pk(con, TARGET, good, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["occurred_at"])


if __name__ == "__main__":
    run_job("silver-checkout-signal", build, target_table="silver_checkout_signal")
