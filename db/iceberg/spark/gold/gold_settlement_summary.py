"""
gold_settlement_summary.py — NET-NEW gap Gold `settlement_summary` mart (Brain V4 Phase 2, GROUP "NEW gap Gold").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized settlement (net-of-fees) surface —
one row per (brand_id, currency_code) holding gross recognized credit, total fees + tax, net settled, and
the refund/dispute deductions, read from Iceberg brain_silver.silver_settlement (the payments-category
settlement/refund/dispute normalizer — settlement.live.v1, discriminated by entity_type). This is the Gold
materialization of the TS computeSettlementSummary signal (settlement-summary.ts), aggregated to the
brand/currency grain.

Sign + component model (mirrors the TS settlement taxonomy, reproduced on the Silver entity grain):
  silver_settlement carries POSITIVE-magnitude amount_minor / fee_minor / tax_minor per item, discriminated
  by entity_type (settlement / payment / refund / dispute / …). We reconstruct the TS gross/net/fee model:
    gross_minor   = Σ amount_minor of the CREDIT items (entity_type IN settlement/payment/order_paid/
                    payment_authorized — the recognized inflow), per currency.
    fee_minor     = Σ fee_minor of those items   (POSITIVE magnitude — MDR processing fees).
    tax_minor     = Σ tax_minor of those items   (POSITIVE magnitude — GST on MDR, separate from fee).
    refund_minor  = Σ amount_minor of refund items (POSITIVE magnitude — settlement reversals).
    dispute_minor = Σ amount_minor of dispute items (POSITIVE magnitude — chargeback deductions).
    net_minor     = gross − fee − tax − refund − dispute  (the net settled cash; integer minor math).

Per-currency (NEVER blend currencies). All money bigint MINOR units; net is integer arithmetic over the
per-currency component sums (no float, no cross-currency add).

GRAIN   : 1 row per (brand_id, currency_code).  brand_id first column + partition anchor.
REPLAY-SAFE: full recompute from Silver, MERGE-UPDATE'd on (brand_id, currency_code).

DATA NOTE: current Bronze has ZERO settlement.live.v1 → silver_settlement is empty → this writes a correct
EMPTY Gold mart today; it populates with no code change once a Razorpay settlement connector syncs.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_settlement_summary"

# Credit (recognized inflow) entity types vs the deduction lanes (the TS gross-credit vs fee/reversal split,
# expressed over the silver_settlement entity_type discriminant).
CREDIT_TYPES = "('settlement', 'payment', 'order_paid', 'payment_authorized', 'settlement_finalization', 'rolling_reserve_release')"
REFUND_TYPES = "('refund', 'settlement_reversal')"
DISPUTE_TYPES = "('dispute', 'chargeback')"

COLUMNS_SQL = """
          brand_id        string    NOT NULL,
          currency_code   string    NOT NULL,
          settlements     bigint    NOT NULL,
          gross_minor     bigint    NOT NULL,
          fee_minor       bigint    NOT NULL,
          tax_minor       bigint    NOT NULL,
          refund_minor    bigint    NOT NULL,
          dispute_minor   bigint    NOT NULL,
          net_minor       bigint    NOT NULL,
          updated_at      timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    staged = spark.sql(
        f"""
        WITH agg AS (
            SELECT
                brand_id,
                COALESCE(currency_code, 'INR')                                                       AS currency_code,
                COUNT(*)                                                                             AS settlements,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type,'') IN {CREDIT_TYPES}
                                  THEN COALESCE(amount_minor, 0) ELSE 0 END), 0)                     AS gross_minor,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type,'') IN {CREDIT_TYPES}
                                  THEN COALESCE(fee_minor, 0) ELSE 0 END), 0)                        AS fee_minor,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type,'') IN {CREDIT_TYPES}
                                  THEN COALESCE(tax_minor, 0) ELSE 0 END), 0)                        AS tax_minor,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type,'') IN {REFUND_TYPES}
                                  THEN COALESCE(amount_minor, 0) ELSE 0 END), 0)                     AS refund_minor,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type,'') IN {DISPUTE_TYPES}
                                  THEN COALESCE(amount_minor, 0) ELSE 0 END), 0)                     AS dispute_minor
            FROM {silver('silver_settlement')}
            WHERE brand_id IS NOT NULL
            GROUP BY brand_id, COALESCE(currency_code, 'INR')
        )
        SELECT
            brand_id,
            currency_code,
            settlements,
            gross_minor,
            fee_minor,
            tax_minor,
            refund_minor,
            dispute_minor,
            -- Net = gross − fee − tax − refund − dispute (integer minor units; per-currency; no float).
            (gross_minor - fee_minor - tax_minor - refund_minor - dispute_minor) AS net_minor,
            current_timestamp()                                                  AS updated_at
        FROM agg
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "currency_code"], delete_orphans=True)  # AUD-IMPL-012: full per-brand recompute — shed disappeared-group orphans
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-settlement-summary", build, entity_incremental={
        "table_name": "gold_settlement_summary", "source_tables": ["silver_settlement"],
    })
