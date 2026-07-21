"""
silver_payment.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_payment.py.

Same 3 lanes → union → Stage-2 business gate → idempotent MERGE on (brand_id, event_id):
  - PIXEL   payment.initiated|succeeded|failed  → behavioral markers, NO money.
  - CONNECTOR settlement.live.v1 filtered to entity_type in (payment_authorized, order_paid).
  - WEBHOOK  payment.attempted.v1|authorized.v1 (gokwik|shopflo, server-trusted, money-bearing).
Business gate: a money-bearing (non-pixel) payment must have a POSITIVE integer amount_minor; the
rest are quarantined. Money stays BIGINT minor units + currency_code. Parity target: brain_silver.silver_payment.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GATED_SOURCE, ensure_table, incremental_window, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to silver_payment_duckdb_test
# instead of the live table (plan: parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_payment{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

PIXEL_EVENTS = ["payment.initiated", "payment.succeeded", "payment.failed"]
CONNECTOR_EVENT = "settlement.live.v1"
WEBHOOK_PAYMENT_EVENTS = ["payment.attempted.v1", "payment.authorized.v1"]
_GOKWIK_FAILED = ("failed", "failure", "declined", "error")

COLUMNS_SQL = """
  brand_id        string    NOT NULL,
  event_id        string    NOT NULL,
  source          string,
  payment_status  string,
  order_id        string,
  payment_id_hash string,
  brain_anon_id   string,
  session_id      string,
  amount_minor    bigint,
  currency_code   string,
  occurred_at     timestamp NOT NULL,
  ingested_at     timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "source", "payment_status", "order_id", "payment_id_hash",
    "brain_anon_id", "session_id", "amount_minor", "currency_code", "occurred_at", "ingested_at",
]

# ── status normalizers (verbatim CASE ports of the Spark _normalize_status_* fns) ────────────────
_PIXEL_STATUS = (
    "CASE event_type WHEN 'payment.initiated' THEN 'initiated' "
    "WHEN 'payment.succeeded' THEN 'succeeded' WHEN 'payment.failed' THEN 'failed' ELSE 'unknown' END"
)


def _webhook_status(pj: str) -> str:
    failed = ", ".join(f"'{s}'" for s in _GOKWIK_FAILED)
    status = f"lower(coalesce({prop(pj,'payment_status')}, {prop(pj,'status')}))"
    return (
        "CASE WHEN event_type = 'payment.authorized.v1' THEN 'authorized' "
        f"WHEN event_type = 'payment.attempted.v1' AND {status} IN ({failed}) THEN 'failed' "
        "WHEN event_type = 'payment.attempted.v1' THEN 'initiated' ELSE 'unknown' END"
    )


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   per_event grain over the gated keystone: each source row → 0..1 silver row via the idempotent
    #   MERGE on (brand_id, event_id), so narrowing the source read is safe. Default OFF → (None, None);
    #   read_gated_events_sql omits the [lo,hi) predicate when lo/hi are None → full scan, byte-identical.
    lo, hi = incremental_window(con, "silver-payment", GATED_SOURCE, ts_col="ingested_at")

    pixel = f"""
      SELECT brand_id, event_id, 'pixel' AS source, {_PIXEL_STATUS} AS payment_status,
             {prop('pj','order_id')} AS order_id, CAST(NULL AS VARCHAR) AS payment_id_hash,
             {prop('pj','brain_anon_id')} AS brain_anon_id, {prop('pj','session_id')} AS session_id,
             CAST({prop('pj','amount_minor')} AS BIGINT) AS amount_minor,
             {prop('pj','currency_code')} AS currency_code, occurred_at, ingested_at
      FROM ({read_gated_events_sql(PIXEL_EVENTS, lo=lo, hi=hi)})
    """

    conn = f"""
      SELECT brand_id, event_id, {prop('pj','source')} AS source,
             CASE WHEN {prop('pj','entity_type')} = 'order_paid' THEN 'paid' ELSE 'authorized' END AS payment_status,
             {prop('pj','order_id')} AS order_id, {prop('pj','payment_id_hash')} AS payment_id_hash,
             CAST(NULL AS VARCHAR) AS brain_anon_id, CAST(NULL AS VARCHAR) AS session_id,
             CAST({prop('pj','amount_minor')} AS BIGINT) AS amount_minor,
             {prop('pj','currency_code')} AS currency_code, occurred_at, ingested_at
      FROM ({read_gated_events_sql([CONNECTOR_EVENT], lo=lo, hi=hi)})
      WHERE {prop('pj','entity_type')} IN ('payment_authorized', 'order_paid')
    """

    webhook = f"""
      SELECT brand_id, event_id, coalesce({prop('pj','source')}, 'gokwik') AS source,
             {_webhook_status('pj')} AS payment_status,
             {prop('pj','order_id')} AS order_id, {prop('pj','payment_id_hash')} AS payment_id_hash,
             CAST(NULL AS VARCHAR) AS brain_anon_id, CAST(NULL AS VARCHAR) AS session_id,
             CAST({prop('pj','amount_minor')} AS BIGINT) AS amount_minor,
             {prop('pj','currency_code')} AS currency_code, occurred_at, ingested_at
      FROM ({read_gated_events_sql(WEBHOOK_PAYMENT_EVENTS, lo=lo, hi=hi)})
    """

    unioned = f"({pixel}) UNION ALL BY NAME ({conn}) UNION ALL BY NAME ({webhook})"

    # Stage-2 business gate: money-bearing (source<>'pixel') rows must have a positive integer minor amount.
    # (Faithful to payment_amount_violations_udf: pixel markers carry no money and are always admitted.)
    good = f"""
      SELECT {', '.join(COLUMNS)} FROM ({unioned})
      WHERE event_id IS NOT NULL AND brand_id IS NOT NULL
        AND (source = 'pixel' OR (amount_minor IS NOT NULL AND amount_minor > 0))
    """

    return merge_on_pk(con, TARGET, good, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-payment", build, target_table="silver_payment")
