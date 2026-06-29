"""
gold_conversion_feedback.py — NET-NEW gap Gold `conversion_feedback` mart (Brain V4 Phase 2, GROUP "NEW gap Gold").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized conversion-feedback / lead surface —
one row per (brand_id, feedback_date, form_id) holding the daily form-submission volume + session/journey
reach + the payment-success reach for that day, read from Iceberg brain_silver.silver_form_submission
(the lead/intent grain — STRUCTURAL metadata ONLY, NO raw field values / PII) and brain_silver.silver_payment
(the payment-event lane). This is the Gold materialization of the conversion-feedback dashboard surface
(form submissions × payment outcomes), with ZERO of the data a visitor typed.

GRAIN   : 1 row per (brand_id, feedback_date, form_id). feedback_date = occurred_at::date (UTC). No money
          (a lead/intent + payment-reach counter — registered money_columns=[]). brand_id first + anchor.
COLUMNS :
  submissions       — form.submitted events for this form_id in the day.
  sessions          — distinct session_id submitting this form.
  journeys          — distinct brain_anon_id submitting this form.
  payments_succeeded— day-level payment.succeeded count from silver_payment (broadcast onto every form_id of
                      the brand-day — the conversion side of the feedback loop; a form is the lead, the
                      payment is the outcome). It is a brand-day total, not per-form (forms don't carry a
                      payment id); kept on the row so the dashboard reads lead→payment in one place.
PII-SAFE: silver_form_submission already strips entered values at the Bronze boundary; this projects only
          structural form_id + counts. NO raw email/phone/name column.
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on the PK.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_conversion_feedback"

COLUMNS_SQL = """
          brand_id            string    NOT NULL,
          feedback_date       date      NOT NULL,
          form_id             string    NOT NULL,
          submissions         bigint    NOT NULL,
          sessions            bigint    NOT NULL,
          journeys            bigint    NOT NULL,
          payments_succeeded  bigint    NOT NULL,
          updated_at          timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), feedback_date")

    staged = spark.sql(
        f"""
        WITH forms AS (
            SELECT
                brand_id,
                CAST(occurred_at AS DATE)                  AS feedback_date,
                COALESCE(NULLIF(form_id, ''), 'unknown')   AS form_id,
                COUNT(*)                                   AS submissions,
                COUNT(DISTINCT session_id)                 AS sessions,
                COUNT(DISTINCT brain_anon_id)              AS journeys
            FROM {silver('silver_form_submission')}
            WHERE brand_id IS NOT NULL AND occurred_at IS NOT NULL
            GROUP BY brand_id, CAST(occurred_at AS DATE), COALESCE(NULLIF(form_id, ''), 'unknown')
        ),
        pay AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS feedback_date,
                   COUNT(*)                  AS payments_succeeded
            FROM {silver('silver_payment')}
            WHERE payment_status = 'succeeded' AND occurred_at IS NOT NULL
            GROUP BY brand_id, CAST(occurred_at AS DATE)
        )
        SELECT
            f.brand_id,
            f.feedback_date,
            f.form_id,
            f.submissions,
            f.sessions,
            f.journeys,
            COALESCE(pay.payments_succeeded, 0) AS payments_succeeded,
            current_timestamp()                 AS updated_at
        FROM forms f
        LEFT JOIN pay USING (brand_id, feedback_date)
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "feedback_date", "form_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-conversion-feedback", build, entity_incremental={
        "table_name": "gold_conversion_feedback", "source_tables": ["silver_form_submission", "silver_payment"],
    })
