"""
silver_dispute.py — GAP canonical Silver `dispute` entity (Brain V4 Phase 1b, GROUP payments/logistics).

NO dbt predecessor (parity status=NEW). The chargeback / dispute normalizer — one row per dispute
lifecycle signal, carrying the disputed (chargeback) amount in minor units + currency, the lifecycle
status (created → under_review → won|lost), the dispute_direction (debit = money withheld/taken,
credit = money returned), and the hashed payment / dispute references that link a chargeback back to its
order/payment. This is the payments-category dispute surface the cod-rto / margin / revenue-truth readers
join to answer "is there an open chargeback against this payment, and which way did it resolve".

SOURCE (multi-shape, forward-compatible):
  - settlement.live.v1 WHERE properties.entity_type = 'dispute'  ← the AUTHORITATIVE shape today.
        The @brain/razorpay-mapper rides ALL payment / refund / order / DISPUTE signals on the ONE
        settlement.live.v1 event lane, discriminated by entity_type. The RazorpayWebhookStrategy maps
        payment.dispute.{created,under_review,won,lost} → settlement.live.v1 with entity_type='dispute'
        + dispute_lifecycle (the exact lifecycle) + dispute_direction (debit|credit). See
        DisputeEventProperties in packages/razorpay-mapper/src/index.ts.
  - dispute.created | dispute.under_review | dispute.won | dispute.lost  ← standalone event_types.
        Accepted defensively so that if a future aggregator emits the dispute lifecycle as its own
        Bronze event_type (rather than folded onto settlement.live.v1), this job picks it up with NO
        code change. event_type itself then carries the lifecycle; entity_type is implied 'dispute'.

GRAIN   : exactly 1 row per (brand_id, event_id) — the Bronze idempotency key. The mapper seeds event_id
          deterministically per (webhook id, lifecycle), so a re-pull of the same dispute transition
          re-emits the SAME id → latest-ingested-wins MERGE = idempotent (replay-safe, I-E02).
MONEY   : amount_minor is the disputed/chargeback amount in bigint MINOR units (integer paisa, I-S07) +
          currency_code. SIGN CONVENTION: amount_minor is stored POSITIVE; consumers apply the sign from
          dispute_direction ('debit' = withheld/charged back → negative effect; 'credit' = returned →
          positive). We carry the direction verbatim and NEVER bake a sign into the stored amount.
PII     : hashed-only. The mapper DROPPED raw disp_/pay_ identifiers at its C1 boundary; only
          dispute_id_hash / payment_id_hash reach Bronze and we carry only those. NEVER a raw identifier.
ISOLATION: brand_id is the first column + the bucket() partition anchor (tenant key on every row).

DATA AVAILABILITY (this session): current Bronze has ZERO settlement.live.v1 and ZERO standalone dispute.*
rows (no Razorpay payments connector has emitted a dispute webhook yet), so this job writes a correct
EMPTY table over current Bronze. The schema + transform are the deliverable; the moment a Razorpay
dispute lands in Bronze, a re-run populates it with no code change. Parity status=NEW.

STAGE-1 GATE (Brain V4 two-stage): this job runs the Stage-1 DQ gate _silver_technical.dq_check (via
  dq_violations_udf) over each staged dispute BEFORE the canonical MERGE, on its amount_minor (the chargeback
  amount is stored POSITIVE by convention — the sign lives in dispute_direction — so a NEGATIVE stored
  amount_minor is a defect → negative_amount), its currency_code (invalid ISO-4217 alpha-3), and its
  occurred_at (future / unparseable timestamp). A row that fails is diverted to brain_silver.silver_quarantine
  (stage='dq', carrying the original Bronze payload for a replayable quarantine row) and NEVER written to
  silver_dispute; Bronze keeps the original (replay-safe). amount_minor is defaulted 0 and currency_code
  defaulted INR when the payload omits them (so missing_currency cannot fire on a well-formed dispute), and
  amount stays bigint MINOR units paired with currency_code. Good rows are byte-identical to before.
"""
from __future__ import annotations

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from _silver_technical import dq_violations_udf, write_quarantine
from pyspark.sql.functions import array_join, coalesce, col, lit, lower, size, to_timestamp, when

TABLE = "silver_dispute"

# The authoritative folded lane + the defensive standalone lifecycle event_types.
SETTLEMENT_EVENT = "settlement.live.v1"
STANDALONE_EVENTS = ["dispute.created", "dispute.under_review", "dispute.won", "dispute.lost"]

# brand_id-first; money = bigint minor + currency_code; hashed-PII only (*_hash). occurred_at drives days().
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


def _normalize_direction(lifecycle_col):
    """Resolve dispute_direction from the lifecycle when the payload omits it.

    Mirrors razorpay-mapper.resolveDisputeDirection: won = credit (money returned), everything else
    (created / under_review / lost) = debit (money withheld or charged back).
    """
    return (
        when(lifecycle_col == "dispute.won", lit("credit"))
        .when(lifecycle_col.isin("dispute.created", "dispute.under_review", "dispute.lost"), lit("debit"))
        .otherwise(lit("debit"))
    )


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    # ── Lane 1 (authoritative): settlement.live.v1 rows discriminated to entity_type='dispute' ──────
    folded_raw = read_bronze_events(spark, [SETTLEMENT_EVENT])
    folded = (
        folded_raw.where(prop("pj", "entity_type") == "dispute")
        .select(
            col("brand_id"),
            col("event_id"),
            coalesce(prop("pj", "source"), lit("razorpay")).alias("source"),
            prop("pj", "dispute_lifecycle").alias("dispute_lifecycle"),
            coalesce(
                prop("pj", "dispute_direction"),
                _normalize_direction(prop("pj", "dispute_lifecycle")),
            ).alias("dispute_direction"),
            prop("pj", "dispute_id_hash").alias("dispute_id_hash"),
            prop("pj", "payment_id_hash").alias("payment_id_hash"),
            prop("pj", "order_id").alias("order_id"),
            # Money: BIGINT minor units (integer paisa). Stored POSITIVE; sign lives in dispute_direction.
            coalesce(prop("pj", "amount_minor").cast("bigint"), lit(0).cast("bigint")).alias("amount_minor"),
            coalesce(prop("pj", "currency_code"), lit("INR")).alias("currency_code"),
            prop("pj", "reason_code").alias("reason_code"),
            prop("pj", "status").alias("status"),
            to_timestamp(prop("pj", "respond_by")).alias("respond_by"),
            col("occurred_at"),
            col("ingested_at"),
            col("pj").alias("_payload"),
        )
    )

    # ── Lane 2 (defensive): standalone dispute.* event_types — event_type carries the lifecycle ──────
    standalone_raw = read_bronze_events(spark, STANDALONE_EVENTS)
    standalone = standalone_raw.select(
        col("brand_id"),
        col("event_id"),
        coalesce(prop("pj", "source"), lit("razorpay")).alias("source"),
        # The Bronze event_type IS the lifecycle in this shape.
        lower(col("event_type")).alias("dispute_lifecycle"),
        coalesce(
            prop("pj", "dispute_direction"),
            _normalize_direction(lower(col("event_type"))),
        ).alias("dispute_direction"),
        prop("pj", "dispute_id_hash").alias("dispute_id_hash"),
        prop("pj", "payment_id_hash").alias("payment_id_hash"),
        prop("pj", "order_id").alias("order_id"),
        coalesce(prop("pj", "amount_minor").cast("bigint"), lit(0).cast("bigint")).alias("amount_minor"),
        coalesce(prop("pj", "currency_code"), lit("INR")).alias("currency_code"),
        prop("pj", "reason_code").alias("reason_code"),
        prop("pj", "status").alias("status"),
        to_timestamp(prop("pj", "respond_by")).alias("respond_by"),
        col("occurred_at"),
        col("ingested_at"),
        col("pj").alias("_payload"),
    )

    staged = folded.unionByName(standalone).where(
        col("event_id").isNotNull() & col("brand_id").isNotNull()
    )

    # ── Stage-1 DQ gate: amount sign (stored positive) + currency + occurred_at — see module docstring ─
    gated = staged.withColumn(
        "_dq",
        dq_violations_udf()(col("amount_minor"), col("currency_code"), col("occurred_at").cast("string")),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            col("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("_payload").alias("payload"),
        ),
        stage="dq",
    )
    good = gated.where(size(col("_dq")) == 0).drop("_dq", "_payload")

    merge_on_pk(spark, fqtn, good, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-dispute", build, target_table="silver_dispute")
