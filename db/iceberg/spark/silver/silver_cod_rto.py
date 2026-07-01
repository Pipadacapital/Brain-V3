"""
silver_cod_rto.py — GAP canonical Silver `cod_rto` entity (Brain V4 Phase 1b, GROUP payments/logistics).

NO dbt predecessor (parity status=NEW). The COD / RTO (Return-To-Origin) risk-and-outcome surface — ONE
row per (brand_id, order_id) that reconciles the THREE COD/RTO signals into a single canonical view the
cod-rto dashboard, the RTO-risk recommender, and the cod_rto_clawback ledger all read:

  1. the COD ORDER itself (was this a cash-on-delivery order at all, and for how much) —
     from order.live.v1 WHERE payment_method = 'cod';
  2. the PREDICTED RTO risk (GoKwik RTO-Predict) — a CATEGORICAL flag (high|medium|low|control), NOT a
     numeric score (GoKwik exposes no number — @brain/gokwik-mapper records the categorical verbatim and
     NEVER fabricates one), from gokwik.rto_predict.v1;
  3. the ACTUAL outcome (forward shipment terminal status) — did it deliver, RTO, or cancel — from
     shiprocket.shipment_status.v1 (the RETIRED gokwik.awb_status.v1 was repointed here — 0117),
     collapsed to its latest terminal_class.

GRAIN   : exactly 1 row per (brand_id, order_id). order_id is the spine key shared by all three sources
          (the ledger spine — NOT PII). A LEFT-join keeps every COD order even before a prediction or an
          AWB outcome lands; predicted/actual columns are NULL until their signal arrives.
RISK    : rto_risk_flag is the CATEGORICAL GoKwik flag (closed set high|medium|low|control|unknown).
          rto_risk_score is intentionally ABSENT — GoKwik gives no number; we do not invent one (Brain
          rule: deterministic first, never fabricate). predicted_rto = (flag in high|medium); actual_rto =
          (AWB terminal_class = 'rto'). prediction_correct compares the two once both exist.
MONEY   : cod_amount_minor is the COD order value in bigint MINOR units (integer paisa, I-S07) +
          currency_code — the at-risk cash a terminal RTO would claw back.
PII     : hashed-only. awb_number is hashed at the GoKwik boundary (awb_number_hash); order_id is the
          non-PII ledger spine. This job NEVER sees or stores a raw AWB or contact identifier.
ISOLATION: brand_id is the first column + the bucket() partition anchor (tenant key on every row).

STAGE-1 GATE (Brain V4 two-stage): this job now runs the Stage-1 DQ gate _silver_technical.dq_check over
  the reconciled COD row BEFORE the canonical MERGE: a row whose cod_amount_minor is negative/non-integer,
  whose currency_code is not ISO-4217 alpha-3, or whose COD order time (occurred_at) is future/unparseable
  is diverted to brain_silver.silver_quarantine (stage='dq') and NEVER written to silver_cod_rto; Bronze
  keeps the original (replay-safe: fix + re-run re-admits). Good rows are byte-identical (parity-faithful).

DATA AVAILABILITY: Bronze HAS COD order.{live,backfill}.v1 rows, gokwik.rto_predict.v1 rows, AND
shiprocket.shipment_status.v1 rows carrying terminal_class (delivered/rto/other/none), so the `actual`
outcome columns now POPULATE (they were permanently NULL while this job read the retired
gokwik.awb_status.v1 — emitted by nothing). cod_amount + predicted-risk populate from live COD orders +
GoKwik predictions. Parity status=NEW.
"""
from __future__ import annotations

from _silver_base import BRONZE_TABLE, ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from _silver_technical import dq_violations_udf, write_quarantine
from pyspark.sql import functions as F
from pyspark.sql.functions import coalesce, col, lit, lower, when
from pyspark.sql.window import Window

TABLE = "silver_cod_rto"

# COD orders: BOTH lanes — order.live.v1 (webhook) AND order.backfill.v1 (historical connector backfill),
# so a backfilled COD order is in the cod_rto spine too (matches silver_order_state / gold_revenue_ledger).
ORDER_EVENTS = ["order.live.v1", "order.backfill.v1"]
RTO_PREDICT_EVENT = "gokwik.rto_predict.v1"
# ACTUAL outcome: the RETIRED gokwik.awb_status.v1 (migration 0117 — emitted by NOTHING) is replaced by the
# LIVE forward-shipment lane shiprocket.shipment_status.v1 (properties.terminal_class is the SAME
# deterministic class from @brain/logistics-status: delivered / rto / other / none). Read ONLY the forward
# lane — the return lane (shiprocket.return_status.v1) carries return_class, and folding a returned item's
# "delivered" as a forward delivery is the SR-4 false-delivery bug. Same repoint as silver_order_state /
# gold_revenue_ledger, which had drifted; without it actual_rto/actual_delivered NEVER populate.
AWB_EVENT = "shiprocket.shipment_status.v1"

# brand_id-first; money = bigint minor + currency_code; hashed-PII only. occurred_at (= COD order time
# when present, else the latest signal time) drives days() partitioning.
COLUMNS_SQL = """
          brand_id            string    NOT NULL,
          order_id            string    NOT NULL,
          is_cod              boolean   NOT NULL,
          cod_amount_minor    bigint,
          currency_code       string,
          financial_status    string,
          rto_risk_flag       string,
          rto_risk_flag_raw   string,
          rto_risk_reason     string,
          predicted_rto       boolean,
          awb_number_hash     string,
          awb_status          string,
          awb_terminal_class  string,
          actual_rto          boolean,
          actual_delivered    boolean,
          prediction_correct  boolean,
          cod_order_at        timestamp,
          predicted_at        timestamp,
          awb_terminal_at     timestamp,
          occurred_at         timestamp NOT NULL,
          ingested_at         timestamp NOT NULL
""".strip("\n")


def _latest_per_order(df, order_col_present=True):
    """Collapse a multi-row-per-order signal to its latest row by (occurred_at, ingested_at)."""
    win = Window.partitionBy("brand_id", "order_id").orderBy(
        col("occurred_at").desc(), col("ingested_at").desc()
    )
    return df.withColumn("_rn", F.row_number().over(win)).where(col("_rn") == 1).drop("_rn")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    # ── Source 1: COD orders (the spine) — only payment_method='cod' rows ───────────────────────────
    orders_raw = read_bronze_events(spark, ORDER_EVENTS)
    cod_orders = (
        orders_raw.select(
            col("brand_id"),
            prop("pj", "order_id").alias("order_id"),
            lower(prop("pj", "payment_method")).alias("payment_method"),
            coalesce(prop("pj", "amount_minor").cast("bigint"), lit(0).cast("bigint")).alias("cod_amount_minor"),
            coalesce(prop("pj", "currency_code"), lit("INR")).alias("currency_code"),
            prop("pj", "financial_status").alias("financial_status"),
            col("occurred_at"),
            col("ingested_at"),
        )
        .where(col("order_id").isNotNull() & (col("payment_method") == "cod"))
    )
    cod_orders = _latest_per_order(cod_orders).select(
        "brand_id", "order_id", "cod_amount_minor", "currency_code", "financial_status",
        col("occurred_at").alias("cod_order_at"), col("ingested_at").alias("_order_ing"),
    )

    # ── Source 2: GoKwik RTO-Predict — categorical risk flag, latest per order ──────────────────────
    pred_raw = read_bronze_events(spark, [RTO_PREDICT_EVENT])
    pred = (
        pred_raw.select(
            col("brand_id"),
            prop("pj", "order_id").alias("order_id"),
            lower(prop("pj", "risk_flag")).alias("rto_risk_flag"),
            prop("pj", "risk_flag_raw").alias("rto_risk_flag_raw"),
            prop("pj", "risk_reason").alias("rto_risk_reason"),
            col("occurred_at"),
            col("ingested_at"),
        )
        .where(col("order_id").isNotNull())
    )
    pred = _latest_per_order(pred).select(
        "brand_id", "order_id", "rto_risk_flag", "rto_risk_flag_raw", "rto_risk_reason",
        col("occurred_at").alias("predicted_at"), col("ingested_at").alias("_pred_ing"),
    )

    # ── Source 3: GoKwik AWB status — latest TERMINAL state per order (actual outcome) ──────────────
    awb_raw = read_bronze_events(spark, [AWB_EVENT])
    awb = (
        awb_raw.select(
            col("brand_id"),
            prop("pj", "order_id").alias("order_id"),
            prop("pj", "awb_number_hash").alias("awb_number_hash"),
            prop("pj", "status").alias("awb_status"),
            lower(prop("pj", "terminal_class")).alias("awb_terminal_class"),
            (lower(prop("pj", "is_terminal")) == "true").alias("_is_terminal"),
            col("occurred_at"),
            col("ingested_at"),
        )
        .where(col("order_id").isNotNull())
    )
    # Prefer the latest TERMINAL row; if none terminal yet, fall back to the latest row overall.
    awb = _latest_per_order(awb).select(
        "brand_id", "order_id", "awb_number_hash", "awb_status", "awb_terminal_class",
        col("occurred_at").alias("awb_terminal_at"), col("ingested_at").alias("_awb_ing"),
    )

    # ── Reconcile: COD order is the spine; LEFT-join prediction + outcome ────────────────────────────
    joined = (
        cod_orders.join(pred, ["brand_id", "order_id"], "left")
        .join(awb, ["brand_id", "order_id"], "left")
    )

    predicted_rto = col("rto_risk_flag").isin("high", "medium")
    actual_rto = col("awb_terminal_class") == "rto"
    actual_delivered = col("awb_terminal_class") == "delivered"

    staged = joined.select(
        col("brand_id"),
        col("order_id"),
        lit(True).alias("is_cod"),
        col("cod_amount_minor"),
        col("currency_code"),
        col("financial_status"),
        coalesce(col("rto_risk_flag"), lit(None).cast("string")).alias("rto_risk_flag"),
        col("rto_risk_flag_raw"),
        col("rto_risk_reason"),
        when(col("rto_risk_flag").isNotNull(), predicted_rto).otherwise(lit(None).cast("boolean")).alias("predicted_rto"),
        col("awb_number_hash"),
        col("awb_status"),
        col("awb_terminal_class"),
        when(col("awb_terminal_class").isNotNull(), actual_rto).otherwise(lit(None).cast("boolean")).alias("actual_rto"),
        when(col("awb_terminal_class").isNotNull(), actual_delivered).otherwise(lit(None).cast("boolean")).alias("actual_delivered"),
        # prediction_correct: only meaningful once BOTH a prediction and a terminal outcome exist.
        when(
            col("rto_risk_flag").isNotNull() & col("awb_terminal_class").isNotNull(),
            predicted_rto == actual_rto,
        ).otherwise(lit(None).cast("boolean")).alias("prediction_correct"),
        col("cod_order_at"),
        col("predicted_at"),
        col("awb_terminal_at"),
        # occurred_at = the COD order time (the spine event); ingested = latest of the three signals.
        col("cod_order_at").alias("occurred_at"),
        F.greatest(
            coalesce(col("_order_ing"), lit(None).cast("timestamp")),
            coalesce(col("_pred_ing"), lit(None).cast("timestamp")),
            coalesce(col("_awb_ing"), lit(None).cast("timestamp")),
        ).alias("ingested_at"),
    ).where(col("order_id").isNotNull() & col("brand_id").isNotNull())

    # ── Stage-1 DQ gate: COD money (cod_amount_minor + currency) + the COD order timestamp. Negative/non-int
    # amount, non-ISO-4217 currency, or a future/unparseable order time → silver_quarantine (stage='dq'),
    # NEVER silver_cod_rto; Bronze keeps the original (replay-safe). order_id is the non-PII grain spine.
    gated = staged.withColumn(
        "_dq",
        dq_violations_udf()(col("cod_amount_minor"), col("currency_code"), col("occurred_at").cast("string")),
    )
    write_quarantine(
        spark,
        gated.where(F.size(col("_dq")) > 0).select(
            col("brand_id"),
            lit(ORDER_EVENTS[0]).alias("source"),
            col("order_id").alias("bronze_event_id"),
            lit(TABLE).alias("canonical_target"),
            F.array_join(col("_dq"), ",").alias("reason"),
            F.to_json(
                F.struct("brand_id", "order_id", "cod_amount_minor", "currency_code", "financial_status")
            ).alias("payload"),
        ),
        stage="dq",
    )
    good = gated.where(F.size(col("_dq")) == 0).drop("_dq")

    merge_on_pk(spark, fqtn, good, ["brand_id", "order_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    # Watermark on ALL THREE sources that change a cod_rto row: the COD order (both lanes), the GoKwik
    # prediction, AND the shiprocket shipment outcome — so a newly-arrived RTO/delivered terminal_class
    # re-folds its order and refreshes actual_rto/actual_delivered (previously only order events triggered
    # a re-fold, so outcomes that landed after the order would never update — a latent staleness bug).
    run_job("silver-cod-rto", build, entity_incremental={
        "table_name": "silver_cod_rto",
        "event_types": ORDER_EVENTS + [RTO_PREDICT_EVENT, AWB_EVENT],
        "entity_path": "$.properties.order_id",
    })
