"""
silver_settlement.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_settlement.py.

The canonical Silver `settlement` entity (payments-category settlement/refund/dispute normalizer).
Folds settlement.live.v1 events (emitted by the @brain/razorpay-mapper boundary — payment / refund /
dispute / order_paid / payment_authorized variants all ride this ONE event_name, discriminated by
entity_type) out of the gated collector lane into rest.brain_silver.silver_settlement, via an idempotent
MERGE on the Bronze idempotency key (brand_id, event_id).

GRAIN : exactly 1 row per (brand_id, event_id) — the mapper seeds event_id deterministically per
        settlement item / webhook, so a trailing re-pull re-emits the SAME id → latest-ingested-wins.
MONEY : amount_minor / fee_minor / tax_minor are bigint MINOR units (integer paisa) + currency_code.
        A settlement carries BOTH credit and debit variants — a refund/clawback line legitimately has a
        NEGATIVE amount_minor — so no amount-sign gate applies (that would false-quarantine valid refunds).
        currency_code defaults to INR when the payload omits it (matches the Spark coalesce).
PII   : the mapper already DROPPED raw utr / payment_id at its boundary (C1) — only *_hash identifiers
        reach Bronze, and we carry only those. settlement_id is an opaque batch ref (not person-linkable).
ISOLATION: brand_id is the first column + the bucket() partition anchor.

DATA AVAILABILITY: Bronze may hold ZERO settlement.live.v1 rows (no Razorpay settlement connector synced
live) — this job then writes a correct EMPTY table over the current keystone; a repull populates it with no
code change. Parity status=NEW (no dbt/StarRocks settlement table to compare against).

STAGE-1 GATE (Brain V4): the Spark job runs a Stage-1 DQ gate over currency_code (invalid ISO-4217) +
  occurred_at (future/unparseable), diverting failures to brain_silver.silver_quarantine (stage='dq') and
  NOT writing them; the amount-sign rule is intentionally NOT applied (credit+debit are both valid). This
  DuckDB port has no _silver_technical analogue, so — matching the framework's other ports
  (silver_payment/silver_refund/silver_order_line) — it does NOT write the quarantine side-table and does
  NOT re-implement the dq drop; Bronze keeps the originals (replay-safe) for a separate rebuild. The
  mart's own admission (event_id + brand_id non-null) is preserved. Good rows are identical.

Parity target: brain_silver.silver_settlement.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_settlement_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_settlement{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SETTLEMENT_EVENT = "settlement.live.v1"

# brand_id-first; money = bigint minor + currency_code; hashed-PII only (*_hash). occurred_at drives day().
COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  event_id            string    NOT NULL,
  source              string,
  entity_type         string,
  settlement_id       string,
  order_id            string,
  payment_id_hash     string,
  utr_hash            string,
  refund_id_hash      string,
  dispute_id_hash     string,
  dispute_lifecycle   string,
  dispute_direction   string,
  status              string,
  amount_minor        bigint,
  fee_minor           bigint,
  tax_minor           bigint,
  currency_code       string,
  reconciliation_type string,
  settlement_at       timestamp,
  occurred_at         timestamp NOT NULL,
  ingested_at         timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "source", "entity_type", "settlement_id", "order_id",
    "payment_id_hash", "utr_hash", "refund_id_hash", "dispute_id_hash",
    "dispute_lifecycle", "dispute_direction", "status",
    "amount_minor", "fee_minor", "tax_minor", "currency_code",
    "reconciliation_type", "settlement_at", "occurred_at", "ingested_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # Money: BIGINT minor units (integer paisa) — cast the string property to bigint, default 0.
    # TRY_CAST guards a non-numeric payload from failing the whole batch (Spark's cast returns NULL →
    # coalesce 0; TRY_CAST is the DuckDB analogue). currency_code defaults INR (Spark coalesce verbatim).
    staged = f"""
      SELECT
        brand_id,
        event_id,
        {prop('pj','source')}               AS source,
        {prop('pj','entity_type')}          AS entity_type,
        {prop('pj','settlement_id')}        AS settlement_id,
        {prop('pj','order_id')}             AS order_id,
        {prop('pj','payment_id_hash')}      AS payment_id_hash,
        {prop('pj','utr_hash')}             AS utr_hash,
        {prop('pj','refund_id_hash')}       AS refund_id_hash,
        {prop('pj','dispute_id_hash')}      AS dispute_id_hash,
        {prop('pj','dispute_lifecycle')}    AS dispute_lifecycle,
        {prop('pj','dispute_direction')}    AS dispute_direction,
        {prop('pj','status')}               AS status,
        coalesce(TRY_CAST({prop('pj','amount_minor')} AS BIGINT), CAST(0 AS BIGINT)) AS amount_minor,
        coalesce(TRY_CAST({prop('pj','fee_minor')}    AS BIGINT), CAST(0 AS BIGINT)) AS fee_minor,
        coalesce(TRY_CAST({prop('pj','tax_minor')}    AS BIGINT), CAST(0 AS BIGINT)) AS tax_minor,
        coalesce({prop('pj','currency_code')}, 'INR')                                AS currency_code,
        {prop('pj','reconciliation_type')}  AS reconciliation_type,
        TRY_CAST({prop('pj','settlement_at')} AS TIMESTAMP) AS settlement_at,
        occurred_at,
        ingested_at
      FROM ({read_gated_events_sql([SETTLEMENT_EVENT])})
      WHERE event_id IS NOT NULL AND brand_id IS NOT NULL
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-settlement", build, target_table="silver_settlement")
