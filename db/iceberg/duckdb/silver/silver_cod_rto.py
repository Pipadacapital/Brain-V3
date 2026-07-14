"""
silver_cod_rto.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_cod_rto.py.

The COD / RTO (Return-To-Origin) risk-and-outcome surface — exactly ONE row per (brand_id, order_id)
that reconciles the THREE COD/RTO signals into a single canonical view (parity status=NEW, no dbt
predecessor). Each source is collapsed to its latest row per order, then LEFT-joined onto the COD-order
spine so every COD order survives even before a prediction or AWB outcome lands:

  1. COD ORDER spine — order.{live,backfill}.v1 WHERE lower(payment_method) = 'cod'. Carries the COD
     value (cod_amount_minor, bigint MINOR units + currency_code) — the at-risk cash.
  2. PREDICTED RTO risk — gokwik.rto_predict.v1. rto_risk_flag is the CATEGORICAL GoKwik flag
     (high|medium|low|control|…); rto_risk_score is intentionally ABSENT (GoKwik gives no number, we
     never fabricate one). predicted_rto = flag IN (high, medium), NULL until a prediction lands.
  3. ACTUAL outcome — shiprocket.shipment_status.v1 (the forward lane; the retired gokwik.awb_status.v1
     was repointed here, migration 0117). Latest row per order; terminal_class ∈ delivered/rto/other.
     actual_rto = (terminal_class = 'rto'), actual_delivered = (terminal_class = 'delivered'), NULL
     until an outcome lands. prediction_correct = (predicted_rto == actual_rto) once BOTH exist.

GRAIN  : 1 row per (brand_id, order_id). order_id is the non-PII ledger spine shared by all 3 sources.
MONEY  : cod_amount_minor bigint MINOR units + currency_code (never a float / bare number).
PII    : hashed-only (awb_number_hash). This job never sees a raw AWB or contact identifier.
ISOLATION: brand_id first + the bucket() partition anchor.
occurred_at = the COD order time (the spine event); ingested_at = the latest of the three signals'
ingested_at (greatest). Dedup/latest-per-order uses (occurred_at DESC, ingested_at DESC) verbatim.

CAVEAT — Stage-1 DQ quarantine side-write SKIPPED: the Spark job runs dq_violations_udf over
(cod_amount_minor, currency_code, occurred_at) and diverts failures to brain_silver.silver_quarantine
(stage='dq'), dropping them from the mart. This DuckDB port has no _silver_technical analogue, so it does
NOT write the quarantine side-table and (matching the framework's other ports) does NOT re-implement the
dq drop — it preserves only the mart's own admission filter (order_id/brand_id NOT NULL). Bronze keeps the
originals, so the quarantine ledger can be rebuilt separately; good rows are data-equivalent.
Parity target: brain_silver.silver_cod_rto.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_cod_rto_duckdb_test beside the Spark-produced
# live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_cod_rto{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# COD orders: BOTH lanes — live webhook + historical connector backfill (parity with silver_order_state).
ORDER_EVENTS = ["order.live.v1", "order.backfill.v1"]
RTO_PREDICT_EVENT = "gokwik.rto_predict.v1"
# ACTUAL outcome: the LIVE forward-shipment lane (retired gokwik.awb_status.v1 repointed here — 0117).
AWB_EVENT = "shiprocket.shipment_status.v1"

# brand_id-first; money = bigint minor + currency_code; hashed-PII only. occurred_at = COD order time.
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

COLUMNS = [
    "brand_id", "order_id", "is_cod", "cod_amount_minor", "currency_code", "financial_status",
    "rto_risk_flag", "rto_risk_flag_raw", "rto_risk_reason", "predicted_rto",
    "awb_number_hash", "awb_status", "awb_terminal_class", "actual_rto", "actual_delivered",
    "prediction_correct", "cod_order_at", "predicted_at", "awb_terminal_at",
    "occurred_at", "ingested_at",
]


def _latest_per_order(inner_sql: str, cols: list[str]) -> str:
    """Collapse a multi-row-per-order signal to its latest row by (occurred_at DESC, ingested_at DESC) —
    the SQL analogue of the Spark _latest_per_order window (partitionBy brand_id, order_id)."""
    collist = ", ".join(cols)
    return (
        f"SELECT {collist} FROM ("
        f"  SELECT *, row_number() OVER (PARTITION BY brand_id, order_id "
        f"                               ORDER BY occurred_at DESC, ingested_at DESC) AS _rn "
        f"  FROM ({inner_sql})"
        f") WHERE _rn = 1"
    )


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # ── Source 1: COD orders (the spine) — only lower(payment_method)='cod' rows, latest per order ────
    cod_orders_raw = f"""
      SELECT brand_id,
             {prop('pj','order_id')} AS order_id,
             lower({prop('pj','payment_method')}) AS payment_method,
             coalesce(CAST({prop('pj','amount_minor')} AS BIGINT), CAST(0 AS BIGINT)) AS cod_amount_minor,
             coalesce({prop('pj','currency_code')}, 'INR') AS currency_code,
             {prop('pj','financial_status')} AS financial_status,
             occurred_at, ingested_at
      FROM ({read_gated_events_sql(ORDER_EVENTS)})
      WHERE {prop('pj','order_id')} IS NOT NULL AND lower({prop('pj','payment_method')}) = 'cod'
    """
    cod_orders = _latest_per_order(
        cod_orders_raw,
        ["brand_id", "order_id", "cod_amount_minor", "currency_code", "financial_status",
         "occurred_at AS cod_order_at", "ingested_at AS _order_ing"],
    )

    # ── Source 2: GoKwik RTO-Predict — categorical risk flag, latest per order ────────────────────────
    pred_raw = f"""
      SELECT brand_id,
             {prop('pj','order_id')} AS order_id,
             lower({prop('pj','risk_flag')}) AS rto_risk_flag,
             {prop('pj','risk_flag_raw')} AS rto_risk_flag_raw,
             {prop('pj','risk_reason')} AS rto_risk_reason,
             occurred_at, ingested_at
      FROM ({read_gated_events_sql([RTO_PREDICT_EVENT])})
      WHERE {prop('pj','order_id')} IS NOT NULL
    """
    pred = _latest_per_order(
        pred_raw,
        ["brand_id", "order_id", "rto_risk_flag", "rto_risk_flag_raw", "rto_risk_reason",
         "occurred_at AS predicted_at", "ingested_at AS _pred_ing"],
    )

    # ── Source 3: shiprocket shipment status — latest row per order (actual outcome) ──────────────────
    awb_raw = f"""
      SELECT brand_id,
             {prop('pj','order_id')} AS order_id,
             {prop('pj','awb_number_hash')} AS awb_number_hash,
             {prop('pj','status')} AS awb_status,
             lower({prop('pj','terminal_class')}) AS awb_terminal_class,
             occurred_at, ingested_at
      FROM ({read_gated_events_sql([AWB_EVENT])})
      WHERE {prop('pj','order_id')} IS NOT NULL
    """
    awb = _latest_per_order(
        awb_raw,
        ["brand_id", "order_id", "awb_number_hash", "awb_status", "awb_terminal_class",
         "occurred_at AS awb_terminal_at", "ingested_at AS _awb_ing"],
    )

    # ── Reconcile: COD order is the spine; LEFT-join prediction + outcome ──────────────────────────────
    joined = f"""
      SELECT o.brand_id, o.order_id,
             o.cod_amount_minor, o.currency_code, o.financial_status, o.cod_order_at, o._order_ing,
             p.rto_risk_flag, p.rto_risk_flag_raw, p.rto_risk_reason, p.predicted_at, p._pred_ing,
             a.awb_number_hash, a.awb_status, a.awb_terminal_class, a.awb_terminal_at, a._awb_ing
      FROM ({cod_orders}) o
      LEFT JOIN ({pred}) p ON o.brand_id = p.brand_id AND o.order_id = p.order_id
      LEFT JOIN ({awb})  a ON o.brand_id = a.brand_id AND o.order_id = a.order_id
    """

    # predicted_rto / actual_rto / actual_delivered / prediction_correct — verbatim CASE ports (NULL until
    # the driving signal exists). occurred_at = cod_order_at; ingested_at = greatest of the 3 signals'.
    staged = f"""
      SELECT
        brand_id,
        order_id,
        TRUE AS is_cod,
        cod_amount_minor,
        currency_code,
        financial_status,
        rto_risk_flag,
        rto_risk_flag_raw,
        rto_risk_reason,
        CASE WHEN rto_risk_flag IS NOT NULL
             THEN rto_risk_flag IN ('high', 'medium')
             ELSE CAST(NULL AS BOOLEAN) END AS predicted_rto,
        awb_number_hash,
        awb_status,
        awb_terminal_class,
        CASE WHEN awb_terminal_class IS NOT NULL
             THEN awb_terminal_class = 'rto'
             ELSE CAST(NULL AS BOOLEAN) END AS actual_rto,
        CASE WHEN awb_terminal_class IS NOT NULL
             THEN awb_terminal_class = 'delivered'
             ELSE CAST(NULL AS BOOLEAN) END AS actual_delivered,
        CASE WHEN rto_risk_flag IS NOT NULL AND awb_terminal_class IS NOT NULL
             THEN (rto_risk_flag IN ('high', 'medium')) = (awb_terminal_class = 'rto')
             ELSE CAST(NULL AS BOOLEAN) END AS prediction_correct,
        cod_order_at,
        predicted_at,
        awb_terminal_at,
        cod_order_at AS occurred_at,
        greatest(
          coalesce(_order_ing, CAST(NULL AS TIMESTAMP)),
          coalesce(_pred_ing,  CAST(NULL AS TIMESTAMP)),
          coalesce(_awb_ing,   CAST(NULL AS TIMESTAMP))
        ) AS ingested_at
      FROM ({joined})
      WHERE order_id IS NOT NULL AND brand_id IS NOT NULL
    """

    # NOTE: Stage-1 DQ quarantine side-write skipped (see module docstring) — no _silver_technical
    # analogue in the DuckDB framework; mart admission = order_id/brand_id NOT NULL only.
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "order_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-cod-rto", build, target_table="silver_cod_rto")
