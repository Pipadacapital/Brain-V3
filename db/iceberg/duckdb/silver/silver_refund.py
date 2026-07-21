"""
silver_refund.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_refund.py.

One canonical Silver `refund` row per (brand_id, event_id) from the refund lane
(refund.recorded.v1 | refund.processed), with the SPEC:C.2.1 measurement taxonomy/lineage
columns, gated by the Stage-2 BUSINESS rule "a refund cannot economically precede its order":
  - order ref UNRESOLVABLE (order not in the spine yet) → FLAG order_unresolved=true, keep the row.
  - refund strictly BEFORE its order → BUSINESS reject (dropped; NOT written to silver_refund).
  - otherwise → keep with order_unresolved=false.

The order's CREATION time is folded straight from the Bronze/keystone order lane
(min(occurred_at) over order.{live,backfill}.v1, per brand_id+order_id) — SPEC:C.2.1 bugfix:
NOT from silver_order_state.first_event_at (which for a refunded order collapses to the refund's
own occurred_at, false-quarantining legit refunds).

Money stays BIGINT minor units (settled refund total) + currency_code. reason_code taxonomy is the
ordered first-match rule table (RTO first-class), verbatim from _measurement_taxonomy.REASON_CODE_RULES.
Quarantine side-write (refund_before_order rejects) is SKIPPED here — only the main target is produced.
Parity target: brain_silver.silver_refund.
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

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to silver_refund_duckdb_test
# instead of the live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_refund{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

REFUND_EVENTS = ["refund.recorded.v1", "refund.processed"]
ORDER_EVENTS = ["order.live.v1", "order.backfill.v1"]

# ── reason_code taxonomy — verbatim port of _measurement_taxonomy.REASON_CODE_RULES (ordered, first
# match wins, applied to the lowercased free-text note). RTO is first-class, matched before 'return'. ──
_REASON_CODE_RULES = (
    (("rto", "return to origin", "undelivered"), "rto"),
    (("damage", "defect", "broken"), "damaged"),
    (("cancel",), "cancellation"),
    (("return", "exchange"), "return"),
)
_DEFAULT_WITH_NOTE = "customer_request"  # a note exists but matches no rule
_DEFAULT_EMPTY = "other"                 # no note at all

COLUMNS_SQL = """
  brand_id         string    NOT NULL,
  event_id         string    NOT NULL,
  source           string,
  refund_id        string,
  order_id         string,
  order_line_id    string,
  amount_minor     bigint,
  currency_code    string,
  reason           string,
  reason_code      string,
  refund_method    string,
  status           string,
  initiated_at     timestamptz,
  settled_at       timestamptz,
  occurred_at      timestamptz NOT NULL,
  ingested_at      timestamptz NOT NULL,
  source_system    string,
  source_event_id  string,
  order_unresolved boolean
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "source", "refund_id", "order_id", "order_line_id",
    "amount_minor", "currency_code", "reason", "reason_code", "refund_method", "status",
    "initiated_at", "settled_at", "occurred_at", "ingested_at",
    "source_system", "source_event_id", "order_unresolved",
]


def _reason_code_sql(reason_expr: str) -> str:
    """SQL CASE mirroring _measurement_taxonomy.classify_reason_code: lowercased note, empty → 'other',
    ordered substring rules (first match wins), otherwise 'customer_request'. Matches classify_reason_code's
    strip() before the empty test."""
    r = f"lower(trim({reason_expr}))"
    parts = [f"CASE WHEN {r} IS NULL OR {r} = '' THEN '{_DEFAULT_EMPTY}'"]
    for substrings, code in _REASON_CODE_RULES:
        conds = " OR ".join(f"{r} LIKE '%' || '{s}' || '%'" for s in substrings)
        parts.append(f"WHEN {conds} THEN '{code}'")
    parts.append(f"ELSE '{_DEFAULT_WITH_NOTE}' END")
    return " ".join(parts)


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   per_event grain: each gated keystone row → 0..1 silver_refund row via the idempotent MERGE on
    #   (brand_id, event_id), so windowing the refund-lane source read is safe. Default OFF → (None, None)
    #   → read_gated_events_sql omits the [lo,hi) predicate → full scan, BYTE-IDENTICAL to before.
    #   NOTE: the order_times CTE reads GATED_SOURCE directly (not via read_gated_events_sql) and is
    #   intentionally NOT windowed — it must see ALL order-creation times to gate refunds correctly.
    lo, hi = incremental_window(con, "silver-refund", GATED_SOURCE, ts_col="ingested_at")

    # ── Order creation times from the keystone order lane (min occurred_at per brand_id+order_id). ──
    # Absent order lane → empty → every refund resolves NULL → flagged order_unresolved (never dropped).
    order_times = f"""
      SELECT brand_id, {prop('payload','order_id')} AS order_id,
             min(occurred_at) AS _order_first_event_at
      FROM {GATED_SOURCE}
      WHERE event_type IN ({", ".join(f"'{e}'" for e in ORDER_EVENTS)})
        AND {prop('payload','order_id')} IS NOT NULL
      GROUP BY brand_id, {prop('payload','order_id')}
    """

    base = f"""
      SELECT brand_id, event_id,
             {prop('pj','source')} AS source,
             coalesce({prop('pj','refund_id')}, {prop('pj','shopify_refund_id')}) AS refund_id,
             {prop('pj','order_id')} AS order_id,
             {prop('pj','order_line_id')} AS order_line_id,
             coalesce(CAST({prop('pj','amount_minor')} AS BIGINT), CAST(0 AS BIGINT)) AS amount_minor,
             {prop('pj','currency_code')} AS currency_code,
             {prop('pj','reason')} AS reason,
             {_reason_code_sql(prop('pj','reason'))} AS reason_code,
             {prop('pj','refund_method')} AS refund_method,
             {prop('pj','status')} AS status,
             occurred_at AS initiated_at,
             occurred_at AS settled_at,
             occurred_at, ingested_at,
             coalesce({prop('pj','source')}, 'unknown') AS source_system,
             event_id AS source_event_id
      FROM ({read_gated_events_sql(REFUND_EVENTS, lo=lo, hi=hi)})
      WHERE event_id IS NOT NULL AND brand_id IS NOT NULL
    """

    # LEFT JOIN the order spine, then apply the Stage-2 timing gate (validate_refund_timing):
    #   order_first_event_at NULL           → order_unresolved=true, keep.
    #   refund occurred_at < order creation → refund_before_order BUSINESS reject, drop.
    #   otherwise                           → order_unresolved=false, keep.
    joined = f"""
      SELECT b.*, o._order_first_event_at
      FROM ({base}) b
      LEFT JOIN ({order_times}) o
        ON b.brand_id = o.brand_id AND b.order_id = o.order_id
    """

    gated = f"""
      SELECT {', '.join(c for c in COLUMNS if c != 'order_unresolved')},
             (_order_first_event_at IS NULL) AS order_unresolved
      FROM ({joined})
      WHERE _order_first_event_at IS NULL
         OR occurred_at >= _order_first_event_at
    """

    return merge_on_pk(con, TARGET, gated, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-refund", build, target_table="silver_refund")
