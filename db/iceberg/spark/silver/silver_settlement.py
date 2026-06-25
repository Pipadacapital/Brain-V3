"""
silver_settlement.py — NET-NEW canonical Silver `settlement` entity (Brain V4 Phase 1, GROUP new-entities).

NO dbt predecessor (parity status=NEW). This is the payments-category settlement/refund/dispute normalizer
that silver_checkout_signal's deferred sibling (`silver_settlement`, see [[payments-checkout-silver]]) was
always meant to be — built here as a Spark→Iceberg Silver job reading raw Bronze.

SOURCE  : rest.brain_bronze.collector_events WHERE event_type = 'settlement.live.v1'
          (emitted by the @brain/razorpay-mapper boundary — payment / refund / dispute / order_paid /
           payment_authorized variants all ride this ONE event_name, discriminated by entity_type.)
GRAIN   : exactly 1 row per (brand_id, event_id) — the Bronze idempotency key (the mapper seeds event_id
          deterministically per settlement item / webhook, so a trailing re-pull re-emits the SAME id →
          latest-ingested-wins MERGE = idempotent).
MONEY   : amount_minor / fee_minor / tax_minor are bigint MINOR units (integer paisa, I-S07) + currency_code.
PII     : the mapper already DROPPED raw utr / payment_id at its boundary (C1) — only *_hash identifiers
          reach Bronze, and we carry only those. settlement_id is an opaque batch ref (not person-linkable).
          This job NEVER sees or stores a raw financial identifier.
ISOLATION: brand_id is the first column + the bucket() partition anchor (tenant key on every row).

DATA AVAILABILITY (this session): current Bronze has ZERO settlement.live.v1 rows (no Razorpay settlement
connector has synced live), so this job writes a correct EMPTY table over current Bronze. The schema is the
deliverable; the moment a Razorpay settlement repull lands settlement.live.v1 in Bronze, a re-run populates
it with no code change. Parity status=NEW (no dbt/StarRocks settlement table to compare against).
"""
from __future__ import annotations

from _silver_base import (
    CATALOG,
    SILVER_NAMESPACE,
    ensure_silver_table,
    merge_on_pk,
    prop,
    read_bronze_events,
    run_job,
)
from pyspark.sql.functions import coalesce, col, lit, to_timestamp

TABLE = "silver_settlement"

# brand_id-first; money = bigint minor + currency_code; hashed-PII only (*_hash). occurred_at drives days().
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


def build(spark):
    fqtn = ensure_silver_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)")

    raw = read_bronze_events(spark, ["settlement.live.v1"])
    staged = (
        raw.select(
            col("brand_id"),
            col("event_id"),
            prop("pj", "source").alias("source"),
            prop("pj", "entity_type").alias("entity_type"),
            prop("pj", "settlement_id").alias("settlement_id"),
            prop("pj", "order_id").alias("order_id"),
            prop("pj", "payment_id_hash").alias("payment_id_hash"),
            prop("pj", "utr_hash").alias("utr_hash"),
            prop("pj", "refund_id_hash").alias("refund_id_hash"),
            prop("pj", "dispute_id_hash").alias("dispute_id_hash"),
            prop("pj", "dispute_lifecycle").alias("dispute_lifecycle"),
            prop("pj", "dispute_direction").alias("dispute_direction"),
            prop("pj", "status").alias("status"),
            # Money: BIGINT minor units (integer paisa) — cast the string property to bigint, default 0.
            coalesce(prop("pj", "amount_minor").cast("bigint"), lit(0).cast("bigint")).alias("amount_minor"),
            coalesce(prop("pj", "fee_minor").cast("bigint"), lit(0).cast("bigint")).alias("fee_minor"),
            coalesce(prop("pj", "tax_minor").cast("bigint"), lit(0).cast("bigint")).alias("tax_minor"),
            coalesce(prop("pj", "currency_code"), lit("INR")).alias("currency_code"),
            prop("pj", "reconciliation_type").alias("reconciliation_type"),
            to_timestamp(prop("pj", "settlement_at")).alias("settlement_at"),
            col("occurred_at"),
            col("ingested_at"),
        )
        .where(col("event_id").isNotNull() & col("brand_id").isNotNull())
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-settlement", build)
