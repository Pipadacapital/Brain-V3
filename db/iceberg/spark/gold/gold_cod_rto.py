"""
gold_cod_rto.py — NET-NEW gap Gold `cod_rto` mart (Brain V4 Phase 2, GROUP "NEW gap Gold products").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized COD/RTO outcome surface — one row
per (brand_id, currency_code) holding the brand's COD/RTO funnel: COD order count + at-risk COD cash,
predicted-RTO count, actual delivered/RTO outcomes, and the prediction accuracy, read from Iceberg
brain_silver.silver_cod_rto (the 3-way reconciled COD order ⨝ rto-predict ⨝ awb grain). This is the Gold
rollup of the cod-rto dashboard / RTO-risk recommender surface — the cod-rto-rates metric materialized.

Per-currency (the at-risk COD cash is money — NEVER blend currencies). Rates are reported as integer
basis points (no float — the metric-engine ratePct discipline: bps = num*10000/den; whole=bps/100,
frac=bps%100), so a consumer renders "X.YZ%" exactly without a float ever entering the mart.

GRAIN   : 1 row per (brand_id, currency_code).
COLUMNS :
  cod_orders             — COD orders for the brand (silver_cod_rto rows, is_cod=true).
  cod_amount_minor       — Σ at-risk COD cash (bigint minor units + currency_code; per-currency).
  predicted_rto          — orders flagged predicted_rto=true (GoKwik high|medium risk band).
  actual_delivered       — orders whose AWB terminal_class='delivered'.
  actual_rto             — orders whose AWB terminal_class='rto'.
  resolved               — actual_delivered + actual_rto (the resolved-outcome base).
  rto_rate_bps           — actual_rto * 10000 / resolved (integer bps; NULL when resolved=0).
  prediction_correct     — orders where prediction_correct=true (both prediction + outcome present).
  prediction_evaluated   — orders where both a prediction AND a terminal outcome exist.
  prediction_accuracy_bps— prediction_correct * 10000 / prediction_evaluated (integer bps; NULL when 0).
REPLAY-SAFE: full recompute from Silver, MERGE-UPDATE'd on (brand_id, currency_code).
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_cod_rto"

COLUMNS_SQL = """
          brand_id                 string    NOT NULL,
          currency_code            string    NOT NULL,
          cod_orders               bigint    NOT NULL,
          cod_amount_minor         bigint    NOT NULL,
          predicted_rto            bigint    NOT NULL,
          actual_delivered         bigint    NOT NULL,
          actual_rto               bigint    NOT NULL,
          resolved                 bigint    NOT NULL,
          rto_rate_bps             bigint,
          prediction_correct       bigint    NOT NULL,
          prediction_evaluated     bigint    NOT NULL,
          prediction_accuracy_bps  bigint,
          updated_at               timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    staged = spark.sql(
        f"""
        WITH agg AS (
            SELECT
                brand_id,
                COALESCE(currency_code, 'INR')                                        AS currency_code,
                COUNT(*)                                                              AS cod_orders,
                COALESCE(SUM(COALESCE(cod_amount_minor, 0)), 0)                       AS cod_amount_minor,
                SUM(CASE WHEN predicted_rto = true THEN 1 ELSE 0 END)                 AS predicted_rto,
                SUM(CASE WHEN actual_delivered = true THEN 1 ELSE 0 END)              AS actual_delivered,
                SUM(CASE WHEN actual_rto = true THEN 1 ELSE 0 END)                    AS actual_rto,
                SUM(CASE WHEN prediction_correct = true THEN 1 ELSE 0 END)            AS prediction_correct,
                SUM(CASE WHEN prediction_correct IS NOT NULL THEN 1 ELSE 0 END)       AS prediction_evaluated
            FROM {silver('silver_cod_rto')}
            WHERE brand_id IS NOT NULL AND is_cod = true
            GROUP BY brand_id, COALESCE(currency_code, 'INR')
        )
        SELECT
            brand_id,
            currency_code,
            cod_orders,
            cod_amount_minor,
            predicted_rto,
            actual_delivered,
            actual_rto,
            (actual_delivered + actual_rto)                                          AS resolved,
            -- Integer basis-point RTO rate over the RESOLVED base (no float); NULL when resolved=0.
            CASE WHEN (actual_delivered + actual_rto) > 0
                 THEN CAST(actual_rto AS bigint) * 10000 / (actual_delivered + actual_rto)
                 ELSE NULL END                                                       AS rto_rate_bps,
            prediction_correct,
            prediction_evaluated,
            CASE WHEN prediction_evaluated > 0
                 THEN CAST(prediction_correct AS bigint) * 10000 / prediction_evaluated
                 ELSE NULL END                                                       AS prediction_accuracy_bps,
            current_timestamp()                                                      AS updated_at
        FROM agg
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "currency_code"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-cod-rto", build)
