"""
gold_measurement_fees.py — SPEC:C.2.3 canonical append-only per-order FEES fact (Brain V4 Wave C).

Platform / payment / checkout-provider fees per order, at the (brand_id, order_id, event_id) grain, money =
bigint minor units + currency, with source_system/source_event_id lineage. Append-only fact + derived
current-state Trino view (mv_gold_measurement_fees).

AMD-16 R1 (BINDING): fees today live ONLY inside razorpay settlements (silver_settlement.fee_minor/tax_minor).
This GOLD fact EXTRACTS them into a first-class per-order fee fact so CM2 (spec numbering) can read fees
directly rather than re-deriving them from the settlement rollup. Additive; no existing reader repointed.

FEE COMPONENTS (per settlement item that carries a fee, per-currency, integer minor, no float):
  fee_type='payment'  fee_minor = fee_minor (the MDR / gateway processing fee)
  fee_type='tax'      fee_minor = tax_minor (GST-on-MDR — a distinct withheld component)
Only rows with a non-zero component are emitted (a settlement item with no fee is not a fee fact). event_id
is suffixed with the component so payment + tax from ONE settlement item are two distinct, idempotent fact
rows that never collide on the merge key.

FORWARD-COMPAT: checkout-provider fees (Shopflo/GoKwik) and platform fees (marketplace commission) land in
the SAME table under fee_type='checkout'/'platform' the moment a connector exposes them — no schema change.

KEY/IDEMPOTENCY: merged on (brand_id, order_id, event_id) — order_id coalesced to ''. Partition
bucket(64, brand_id), days(occurred_at).
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver, silver_exists

TABLE = "gold_measurement_fees"

COLUMNS_SQL = """
          brand_id         string    NOT NULL,
          order_id         string    NOT NULL,
          event_id         string    NOT NULL,
          fee_type         string    NOT NULL,
          fee_minor        bigint    NOT NULL,
          currency_code    string,
          source_system    string,
          source_event_id  string,
          occurred_at      timestamp NOT NULL,
          ingested_at      timestamp,
          updated_at       timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), days(occurred_at)")

    if not silver_exists(spark, "silver_settlement"):
        return fqtn, spark.table(fqtn).count()

    staged = spark.sql(
        f"""
        WITH src AS (
            SELECT brand_id, event_id, coalesce(order_id, '') AS order_id,
                   cast(coalesce(fee_minor, 0) AS bigint) AS fee_minor,
                   cast(coalesce(tax_minor, 0) AS bigint) AS tax_minor,
                   currency_code, coalesce(source, 'razorpay') AS source_system, occurred_at, ingested_at
            FROM {silver('silver_settlement')}
            WHERE brand_id IS NOT NULL AND event_id IS NOT NULL
        ),
        payment_fee AS (
            SELECT brand_id, order_id, concat(event_id, ':payment') AS event_id, 'payment' AS fee_type,
                   fee_minor AS fee_minor, currency_code, source_system, event_id AS source_event_id,
                   occurred_at, ingested_at
            FROM src WHERE fee_minor <> 0
        ),
        tax_fee AS (
            SELECT brand_id, order_id, concat(event_id, ':tax') AS event_id, 'tax' AS fee_type,
                   tax_minor AS fee_minor, currency_code, source_system, event_id AS source_event_id,
                   occurred_at, ingested_at
            FROM src WHERE tax_minor <> 0
        )
        SELECT brand_id, order_id, event_id, fee_type, fee_minor, currency_code, source_system,
               source_event_id, occurred_at, ingested_at, current_timestamp() AS updated_at
        FROM payment_fee
        UNION ALL
        SELECT brand_id, order_id, event_id, fee_type, fee_minor, currency_code, source_system,
               source_event_id, occurred_at, ingested_at, current_timestamp() AS updated_at
        FROM tax_fee
        """
    )
    merge_on_pk(spark, fqtn, staged, ["brand_id", "order_id", "event_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    # Plain run_job (NOT entity_incremental) — see gold_measurement_settlements.py: ensure-table-on-empty.
    run_job("gold-measurement-fees", build)
