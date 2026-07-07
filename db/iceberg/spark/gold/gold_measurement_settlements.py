"""
gold_measurement_settlements.py — SPEC:C.2.2 canonical append-only SETTLEMENTS fact (Brain V4 Wave C).

Per-settlement-item fact (COD + gateway) at the (brand_id, order_id, event_id) grain, money = bigint minor
units + currency, with source_system/source_event_id lineage and a settlement_batch_id. Append-only fact +
derived current-state Trino view (mv_gold_measurement_settlements). Mirrors gold_revenue_ledger's
event-sourced pattern.

AMD-16 R1 (BINDING): the single settlement fact is brain_silver.silver_settlement (razorpay lane, real
mapper + 2y backfill). This GOLD fact is its measurement-namespace projection to gross/fees/net with a
canonical settlement_batch_id + lineage — it does NOT fork a second settlement copy and does NOT touch the
live gold_settlement_summary (that brand×currency rollup stays as-is). Additive.

RECONCILIATION (SPEC:C.5.4): net_minor here reconciles against the ledger's recognized inflow. A companion
Trino view (mv_gold_measurement_settlements) exposes the fact; the C.5.4 acceptance test asserts
Σ(net_minor) per (brand_id, currency) vs the ledger's recognized net = 0 on the golden set (documented
tolerance live). We do NOT rewrite the ledger.

SIGN/COMPONENT MODEL (per row, per-currency, integer minor, no float):
  gross_minor = amount_minor (the settled item's face value — CREDIT items positive; refund/reversal items
                carry their native sign, preserved).
  fees_minor  = fee_minor + tax_minor (MDR processing fee + GST-on-MDR — the amount withheld by the gateway).
  net_minor   = gross_minor - fees_minor (the net cash actually settled to the brand).
settlement_batch_id = settlement_id (the gateway's payout batch ref; opaque, not PII).

KEY/IDEMPOTENCY: merged on (brand_id, order_id, event_id) — order_id coalesced to '' (a settlement item may
be batch-level, not order-linked). Partition bucket(64, brand_id), days(occurred_at).
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver, silver_exists

TABLE = "gold_measurement_settlements"

COLUMNS_SQL = """
          brand_id            string    NOT NULL,
          order_id            string    NOT NULL,
          event_id            string    NOT NULL,
          settlement_batch_id string,
          entity_type         string,
          gross_minor         bigint    NOT NULL,
          fees_minor          bigint    NOT NULL,
          net_minor           bigint    NOT NULL,
          currency_code       string,
          reconciliation_type string,
          settled_at          timestamp,
          source_system       string,
          source_event_id     string,
          occurred_at         timestamp NOT NULL,
          ingested_at         timestamp,
          updated_at          timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), days(occurred_at)")

    if not silver_exists(spark, "silver_settlement"):
        # Absent upstream → write a correct EMPTY fact (schema is the deliverable; populates on a live sync).
        return fqtn, spark.table(fqtn).count()

    staged = spark.sql(
        f"""
        SELECT
            brand_id,
            coalesce(order_id, '')                                                     AS order_id,
            event_id,
            settlement_id                                                              AS settlement_batch_id,
            entity_type,
            cast(coalesce(amount_minor, 0) AS bigint)                                  AS gross_minor,
            cast(coalesce(fee_minor, 0) + coalesce(tax_minor, 0) AS bigint)            AS fees_minor,
            cast(coalesce(amount_minor, 0) - (coalesce(fee_minor, 0) + coalesce(tax_minor, 0)) AS bigint) AS net_minor,
            currency_code,
            reconciliation_type,
            settlement_at                                                              AS settled_at,
            coalesce(source, 'razorpay')                                               AS source_system,
            event_id                                                                   AS source_event_id,
            occurred_at,
            ingested_at,
            current_timestamp()                                                        AS updated_at
        FROM {silver('silver_settlement')}
        WHERE brand_id IS NOT NULL AND event_id IS NOT NULL
        """
    )
    merge_on_pk(spark, fqtn, staged, ["brand_id", "order_id", "event_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    # Plain run_job (NOT entity_incremental): the incremental driver skips build_fn — and therefore
    # ensure_gold_table — when the source has zero changed brands, so an EMPTY silver_settlement would leave
    # the Gold fact table never created (the delta's "ensure-table-on-empty" gap). A full recompute over the
    # small settlement source is idempotent (MERGE UPDATE *) and always ensures the table exists.
    run_job("gold-measurement-settlements", build)
