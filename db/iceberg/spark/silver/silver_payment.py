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
  - webhook connectors (gokwik | shopflo) : 'payment.attempted.v1' | 'payment.authorized.v1'
             (the source-neutral webhook-first canonical payment events — server-trusted, brand derived
              from the connector row. payment.attempted → 'initiated' (or 'failed' on a failure status),
              payment.authorized → 'authorized'. Carry authoritative amount_minor + currency_code and a
              hashed payment_id only — raw DROPPED at the strategy boundary. SOURCE DISCRIMINANT: the
              generic payment.*.v1 names cannot carry the source via event_type alone, so `source` is read
              from payload.properties.source (mapper-stamped 'gokwik' | 'shopflo'), defaulting to 'gokwik'
              for back-compat. See docs/architecture/{gokwik,shopflo}-connector-*.md.)

GRAIN   : 1 row per (brand_id, event_id) — the Bronze idempotency key. payment_status is the normalized
          discriminant (initiated|succeeded|failed|authorized|paid).
MONEY   : amount_minor is bigint MINOR units + currency_code (NULL/0 for pixel markers that carry no money).
PII     : hashed-only — pixel rows carry brain_anon_id (a pseudonymous id, not raw PII); razorpay rows carry
          payment_id_hash (raw DROPPED at the mapper boundary). NO raw financial/contact identifier here.
ISOLATION: brand_id first column + bucket() partition anchor.

STAGE-1 GATE (Brain V4 two-stage): this job now runs the Stage-2 BUSINESS-validation gate
  _silver_technical.validate_payment_amount over the staged rows BEFORE the canonical MERGE: a
  MONEY-BEARING payment (the connector lane — authorized/paid; source<>'pixel') with a negative/zero/
  non-integer amount_minor is diverted to brain_silver.silver_quarantine (stage='business') and NEVER
  written to silver_payment. Behavioral pixel markers carry no authoritative money (amount NULL) → they
  are untouched. Good rows are byte-identical to before (parity-faithful); Bronze keeps the original.

DATA AVAILABILITY (this session): current Bronze has ZERO payment.* and ZERO settlement.live.v1 rows, so
this writes a correct EMPTY table over current Bronze. Schema is the deliverable; populates with no code
change once a pixel payment marker or a Razorpay pre-settlement event lands in Bronze. Parity status=NEW.
"""
from __future__ import annotations

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from _silver_technical import payment_amount_violations_udf, write_quarantine
from pyspark.sql.functions import array_join, coalesce, col, lit, lower, size, when

TABLE = "silver_payment"

PIXEL_EVENTS = ["payment.initiated", "payment.succeeded", "payment.failed"]
# Pre-settlement razorpay variants ride settlement.live.v1; we keep only the payment-lifecycle entity_types.
CONNECTOR_EVENT = "settlement.live.v1"
# Source-neutral webhook-first canonical payment events (server-trusted) — money-bearing. Emitted by BOTH
# the gokwik and shopflo webhook strategies; the `source` is read from payload.properties.source (not the
# event_type, which is identical for both), defaulting to 'gokwik' for back-compat.
WEBHOOK_PAYMENT_EVENTS = ["payment.attempted.v1", "payment.authorized.v1"]
# Raw attempt-status tokens that mean the payment.attempted.v1 attempt FAILED (else it is 'initiated').
_GOKWIK_FAILED_STATES = ["failed", "failure", "declined", "error"]

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


def _normalize_status_gokwik(event_type_col, status_col):
    """GoKwik canonical payment events → the normalized payment_status discriminant.

    payment.authorized.v1 → 'authorized'. payment.attempted.v1 → 'failed' when the attempt's raw status
    is a failure token, else 'initiated' (the attempt was made; outcome ok/pending).
    """
    return (
        when(event_type_col == "payment.authorized.v1", lit("authorized"))
        .when(
            (event_type_col == "payment.attempted.v1") & lower(status_col).isin(*_GOKWIK_FAILED_STATES),
            lit("failed"),
        )
        .when(event_type_col == "payment.attempted.v1", lit("initiated"))
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
        col("pj").alias("_payload"),
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
            col("pj").alias("_payload"),
        )
    )

    # ── Lane 3: webhook-first canonical payment events (gokwik | shopflo, server-trusted) ────────────
    # Money-bearing (authoritative amount_minor + currency_code), hashed payment_id only — never raw.
    # SOURCE DISCRIMINANT: payload.properties.source (mapper-stamped), default 'gokwik' for back-compat —
    # so shopflo payments are labeled 'shopflo' while existing gokwik rows stay byte-identical.
    webhook = read_bronze_events(spark, WEBHOOK_PAYMENT_EVENTS).select(
        col("brand_id"),
        col("event_id"),
        coalesce(prop("pj", "source"), lit("gokwik")).alias("source"),
        _normalize_status_gokwik(
            col("event_type"), coalesce(prop("pj", "payment_status"), prop("pj", "status"))
        ).alias("payment_status"),
        prop("pj", "order_id").alias("order_id"),
        prop("pj", "payment_id_hash").alias("payment_id_hash"),
        lit(None).cast("string").alias("brain_anon_id"),
        lit(None).cast("string").alias("session_id"),
        prop("pj", "amount_minor").cast("bigint").alias("amount_minor"),
        prop("pj", "currency_code").alias("currency_code"),
        col("occurred_at"),
        col("ingested_at"),
        col("pj").alias("_payload"),
    )

    unioned = (
        pixel.unionByName(conn).unionByName(webhook)
        .where(col("event_id").isNotNull() & col("brand_id").isNotNull())
    )

    # ── Stage-2 BUSINESS gate: a money-bearing payment must be positive integer minor units ──────────
    # is_money_bearing := the deterministic connector lane (source<>'pixel'); pixel markers carry no money.
    gate = unioned.withColumn(
        "_violations",
        payment_amount_violations_udf()(col("amount_minor"), (col("source") != lit("pixel"))),
    )
    bad = gate.where(size(col("_violations")) > 0)
    good = gate.where(size(col("_violations")) == 0).drop("_violations", "_payload")

    rejects = bad.select(
        col("brand_id"),
        col("source"),
        col("event_id").alias("bronze_event_id"),
        lit(TABLE).alias("canonical_target"),
        array_join(col("_violations"), ",").alias("reason"),
        col("_payload").alias("payload"),
    )
    write_quarantine(spark, rejects, stage="business")

    merge_on_pk(spark, fqtn, good, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-payment", build, target_table="silver_payment")
