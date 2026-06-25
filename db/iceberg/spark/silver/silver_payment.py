"""
silver_payment.py — NET-NEW canonical Silver `payment` entity (Brain V4 Phase 1, GROUP new-entities).

NO dbt predecessor (parity status=NEW). The payment-EVENT grain — one row per payment signal across BOTH
the behavioral (pixel) and deterministic (connector) lanes, normalized to one shape. This is the
journey/funnel-facing payment surface, distinct from `silver_settlement` (the money-truth settlement/refund
batch grain). A reader that wants "did this checkout reach the payment step / succeed / fail" reads here;
revenue truth still comes from the order/settlement connectors (Brain rule: revenue truth over platform truth).

SOURCES (multi-source by design):
  - pixel  : 'payment.initiated' | 'payment.succeeded' | 'payment.failed'
             (collector pixel-asset.route.ts — BEHAVIORAL markers on the payment/thank-you screen; carry
              brain_anon_id + session_id but NO authoritative money.)
  - razorpay (settlement.live.v1, pre-settlement variants): entity_type='payment_authorized' | 'order_paid'
             (the @brain/razorpay-mapper pre-settlement signals — carry authoritative amount_minor + currency,
              hashed payment_id only.)

GRAIN   : 1 row per (brand_id, event_id) — the Bronze idempotency key. payment_status is the normalized
          discriminant (initiated|succeeded|failed|authorized|paid).
MONEY   : amount_minor is bigint MINOR units + currency_code (NULL/0 for pixel markers that carry no money).
PII     : hashed-only — pixel rows carry brain_anon_id (a pseudonymous id, not raw PII); razorpay rows carry
          payment_id_hash (raw DROPPED at the mapper boundary). NO raw financial/contact identifier here.
ISOLATION: brand_id first column + bucket() partition anchor.

DATA AVAILABILITY (this session): current Bronze has ZERO payment.* and ZERO settlement.live.v1 rows, so
this writes a correct EMPTY table over current Bronze. Schema is the deliverable; populates with no code
change once a pixel payment marker or a Razorpay pre-settlement event lands in Bronze. Parity status=NEW.
"""
from __future__ import annotations

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from pyspark.sql.functions import col, lit, when

TABLE = "silver_payment"

PIXEL_EVENTS = ["payment.initiated", "payment.succeeded", "payment.failed"]
# Pre-settlement razorpay variants ride settlement.live.v1; we keep only the payment-lifecycle entity_types.
CONNECTOR_EVENT = "settlement.live.v1"

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


def _normalize_status_pixel(event_type_col):
    return (
        when(event_type_col == "payment.initiated", lit("initiated"))
        .when(event_type_col == "payment.succeeded", lit("succeeded"))
        .when(event_type_col == "payment.failed", lit("failed"))
        .otherwise(lit("unknown"))
    )


def build(spark):
    fqtn = ensure_silver_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)")

    # ── Lane 1: behavioral pixel payment markers ──────────────────────────────────────────────────
    pixel = read_bronze_events(spark, PIXEL_EVENTS).select(
        col("brand_id"),
        col("event_id"),
        lit("pixel").alias("source"),
        _normalize_status_pixel(col("event_type")).alias("payment_status"),
        prop("pj", "order_id").alias("order_id"),
        lit(None).cast("string").alias("payment_id_hash"),
        prop("pj", "brain_anon_id").alias("brain_anon_id"),
        prop("pj", "session_id").alias("session_id"),
        # Pixel markers carry NO authoritative money — NULL minor (never fabricate a number).
        prop("pj", "amount_minor").cast("bigint").alias("amount_minor"),
        prop("pj", "currency_code").alias("currency_code"),
        col("occurred_at"),
        col("ingested_at"),
    )

    # ── Lane 2: deterministic razorpay pre-settlement payment events (subset of settlement.live.v1) ─
    conn_raw = read_bronze_events(spark, [CONNECTOR_EVENT])
    conn = (
        conn_raw.where(prop("pj", "entity_type").isin("payment_authorized", "order_paid"))
        .select(
            col("brand_id"),
            col("event_id"),
            prop("pj", "source").alias("source"),
            when(prop("pj", "entity_type") == "order_paid", lit("paid")).otherwise(lit("authorized")).alias("payment_status"),
            prop("pj", "order_id").alias("order_id"),
            prop("pj", "payment_id_hash").alias("payment_id_hash"),
            lit(None).cast("string").alias("brain_anon_id"),
            lit(None).cast("string").alias("session_id"),
            prop("pj", "amount_minor").cast("bigint").alias("amount_minor"),
            prop("pj", "currency_code").alias("currency_code"),
            col("occurred_at"),
            col("ingested_at"),
        )
    )

    staged = pixel.unionByName(conn).where(col("event_id").isNotNull() & col("brand_id").isNotNull())
    merge_on_pk(spark, fqtn, staged, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-payment", build)
