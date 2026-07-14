"""
silver_dispute.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_dispute.py.

The chargeback / dispute normalizer — one row per (brand_id, event_id) dispute lifecycle signal, carrying
the disputed amount (bigint MINOR units + currency_code, stored POSITIVE — the sign lives in
dispute_direction), the lifecycle status, and the hashed payment/dispute references. Two forward-compatible
lanes union → the entity PK MERGE:
  - LANE 1 (authoritative): settlement.live.v1 WHERE properties.entity_type = 'dispute' (the
    @brain/razorpay-mapper folds dispute.{created,under_review,won,lost} onto settlement.live.v1).
  - LANE 2 (defensive): standalone dispute.* event_types — event_type itself carries the lifecycle.

MONEY : amount_minor is bigint MINOR units, stored POSITIVE (coalesce → 0), currency_code coalesced INR.
        NEVER a float; the sign is applied downstream from dispute_direction.
PII   : hashed-only (dispute_id_hash / payment_id_hash). ISOLATION: brand_id first + bucket() anchor.

QUARANTINE SKIPPED: the Spark job runs a Stage-1 DQ gate (dq_violations_udf → silver_quarantine,
  stage='dq') diverting negative amount_minor / non-ISO-4217 currency / future-unparseable occurred_at
  BEFORE the MERGE. The migration framework has no quarantine seam, so — matching the other ports
  (silver_payment / silver_marketing_spend) — this port does NOT write the side-table and does NOT
  re-implement the dq drop; Bronze keeps the originals (replay-safe) for a separate rebuild. The mart's own
  admission (event_id + brand_id present) is preserved. Good rows are identical.

DATA AVAILABILITY: Bronze holds ZERO settlement.live.v1 disputes and ZERO standalone dispute.* today, so
  this writes a correct EMPTY table; a Razorpay dispute repull populates it with no code change.

Parity target: brain_silver.silver_dispute (NEW — no dbt/StarRocks baseline).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_dispute_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_dispute{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SETTLEMENT_EVENT = "settlement.live.v1"
STANDALONE_EVENTS = ["dispute.created", "dispute.under_review", "dispute.won", "dispute.lost"]

# brand_id-first; money = bigint minor + currency_code; hashed-PII only (*_hash). occurred_at drives day().
COLUMNS_SQL = """
  brand_id           string    NOT NULL,
  event_id           string    NOT NULL,
  source             string,
  dispute_lifecycle  string,
  dispute_direction  string,
  dispute_id_hash    string,
  payment_id_hash    string,
  order_id           string,
  amount_minor       bigint,
  currency_code      string,
  reason_code        string,
  status             string,
  respond_by         timestamp,
  occurred_at        timestamp NOT NULL,
  ingested_at        timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "source", "dispute_lifecycle", "dispute_direction", "dispute_id_hash",
    "payment_id_hash", "order_id", "amount_minor", "currency_code", "reason_code", "status",
    "respond_by", "occurred_at", "ingested_at",
]


def _normalize_direction(lifecycle_sql: str) -> str:
    """Resolve dispute_direction from the lifecycle when the payload omits it (verbatim port of
    razorpay-mapper.resolveDisputeDirection): won = credit (money returned), everything else = debit."""
    return (
        f"CASE WHEN {lifecycle_sql} = 'dispute.won' THEN 'credit' "
        f"WHEN {lifecycle_sql} IN ('dispute.created', 'dispute.under_review', 'dispute.lost') THEN 'debit' "
        "ELSE 'debit' END"
    )


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # ── Lane 1 (authoritative): settlement.live.v1 discriminated to entity_type='dispute'. ──
    folded = f"""
      SELECT
        brand_id, event_id,
        coalesce({prop('pj','source')}, 'razorpay')                 AS source,
        {prop('pj','dispute_lifecycle')}                            AS dispute_lifecycle,
        coalesce({prop('pj','dispute_direction')},
                 {_normalize_direction(prop('pj','dispute_lifecycle'))}) AS dispute_direction,
        {prop('pj','dispute_id_hash')}                              AS dispute_id_hash,
        {prop('pj','payment_id_hash')}                              AS payment_id_hash,
        {prop('pj','order_id')}                                     AS order_id,
        coalesce(CAST({prop('pj','amount_minor')} AS BIGINT), CAST(0 AS BIGINT)) AS amount_minor,
        coalesce({prop('pj','currency_code')}, 'INR')               AS currency_code,
        {prop('pj','reason_code')}                                  AS reason_code,
        {prop('pj','status')}                                       AS status,
        CAST({prop('pj','respond_by')} AS TIMESTAMP)                AS respond_by,
        occurred_at, ingested_at
      FROM ({read_gated_events_sql([SETTLEMENT_EVENT])})
      WHERE {prop('pj','entity_type')} = 'dispute'
    """

    # ── Lane 2 (defensive): standalone dispute.* — the Bronze event_type IS the lifecycle. ──
    standalone = f"""
      SELECT
        brand_id, event_id,
        coalesce({prop('pj','source')}, 'razorpay')                 AS source,
        lower(event_type)                                           AS dispute_lifecycle,
        coalesce({prop('pj','dispute_direction')},
                 {_normalize_direction('lower(event_type)')})       AS dispute_direction,
        {prop('pj','dispute_id_hash')}                              AS dispute_id_hash,
        {prop('pj','payment_id_hash')}                              AS payment_id_hash,
        {prop('pj','order_id')}                                     AS order_id,
        coalesce(CAST({prop('pj','amount_minor')} AS BIGINT), CAST(0 AS BIGINT)) AS amount_minor,
        coalesce({prop('pj','currency_code')}, 'INR')               AS currency_code,
        {prop('pj','reason_code')}                                  AS reason_code,
        {prop('pj','status')}                                       AS status,
        CAST({prop('pj','respond_by')} AS TIMESTAMP)                AS respond_by,
        occurred_at, ingested_at
      FROM ({read_gated_events_sql(STANDALONE_EVENTS)})
    """

    staged = f"""
      SELECT {', '.join(COLUMNS)} FROM (({folded}) UNION ALL BY NAME ({standalone}))
      WHERE event_id IS NOT NULL AND brand_id IS NOT NULL
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-dispute", build, target_table="silver_dispute")
