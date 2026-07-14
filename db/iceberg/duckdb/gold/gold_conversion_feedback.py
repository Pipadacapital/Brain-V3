"""
gold_conversion_feedback.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_conversion_feedback.py.

NET-NEW gap Gold `conversion_feedback` mart (Brain V4 Phase 2, GROUP "NEW gap Gold"). NO dbt
predecessor (parity status=NEW; matrix §3/4). The materialized conversion-feedback / lead surface —
one row per (brand_id, feedback_date, form_id) holding the daily form-submission volume + session/journey
reach + the payment-success reach for that day. Reads Iceberg brain_silver.silver_form_submission (the
lead/intent grain — STRUCTURAL metadata ONLY, NO raw field values / PII) and brain_silver.silver_payment
(the payment-event lane) DIRECTLY, exactly like the Spark job reads them via silver(). This is the Gold
materialization of the conversion-feedback dashboard surface (form submissions × payment outcomes), with
ZERO of the data a visitor typed.

GRAIN / PK : 1 row per (brand_id, feedback_date, form_id). feedback_date = occurred_at::date (UTC). NO money
             (a lead/intent + payment-reach counter — registered money_columns=[]). brand_id first + anchor.
COLUMNS (verbatim from the Spark COLUMNS_SQL order/types):
  submissions        — form.submitted events for this form_id in the day.
  sessions           — distinct session_id submitting this form.
  journeys           — distinct brain_anon_id submitting this form.
  payments_succeeded — day-level payment.succeeded count from silver_payment (broadcast onto every form_id of
                       the brand-day via LEFT JOIN pay USING (brand_id, feedback_date) — a brand-day total,
                       not per-form; the conversion side of the feedback loop, kept on the row so the
                       dashboard reads lead→payment in one place).

PII-SAFE   : silver_form_submission already strips entered values at the Bronze boundary; this projects only
             structural form_id + counts. NO raw email/phone/name column.
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on the PK. Idempotent.

CAVEAT — orphan-shedding: the Spark job passes delete_orphans=True (WHEN NOT MATCHED BY SOURCE DELETE) so a
full per-brand recompute sheds a disappeared group's Gold row. The DuckDB _base.merge_on_pk does NOT
implement a not-matched-by-source DELETE — this port is a MATCHED-UPDATE / NOT-MATCHED-INSERT MERGE only.
For the parallel-run parity harness (fresh <table>_duckdb_test built from the same Silver) the admission set
is identical; the divergence only exists after an upstream group disappears from Silver between runs. Noted,
not silently dropped.

QUARANTINE : the Spark job has NO Stage-1/quarantine side-write here (reads already-gated Silver). This
             framework has none either — nothing to skip.

Honors MIGRATION_TABLE_SUFFIX (→ gold_conversion_feedback_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_conversion_feedback.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_conversion_feedback_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_conversion_feedback"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_FORM = f"{CATALOG}.{SILVER_NAMESPACE}.silver_form_submission"
SILVER_PAYMENT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_payment"

# Mirrors the Spark COLUMNS_SQL order/types exactly. No money (lead/intent + payment-reach counting).
# feedback_date is a DATE.
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

COLUMNS = [
    "brand_id", "feedback_date", "form_id", "submissions",
    "sessions", "journeys", "payments_succeeded", "updated_at",
]

PK = ["brand_id", "feedback_date", "form_id"]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), feedback_date")

    # Faithful SQL port of the Spark staged CTE. forms (per-form submission/session/journey counts) LEFT
    # JOINed onto pay (the brand-day payment.succeeded total, broadcast onto every form_id of the brand-day
    # via USING (brand_id, feedback_date)). form_id is COALESCE(NULLIF(form_id,''),'unknown') so a blank/null
    # form still lands on the 'unknown' bucket. Distinct counts are stage-local identities.
    staged = f"""
        WITH forms AS (
            SELECT
                brand_id,
                CAST(occurred_at AS DATE)                  AS feedback_date,
                COALESCE(NULLIF(form_id, ''), 'unknown')   AS form_id,
                COUNT(*)                                   AS submissions,
                COUNT(DISTINCT session_id)                 AS sessions,
                COUNT(DISTINCT brain_anon_id)              AS journeys
            FROM {SILVER_FORM}
            WHERE brand_id IS NOT NULL AND occurred_at IS NOT NULL
            GROUP BY brand_id, CAST(occurred_at AS DATE), COALESCE(NULLIF(form_id, ''), 'unknown')
        ),
        pay AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS feedback_date,
                   COUNT(*)                  AS payments_succeeded
            FROM {SILVER_PAYMENT}
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
            now()                               AS updated_at
        FROM forms f
        LEFT JOIN pay USING (brand_id, feedback_date)
    """

    # The rollup is already 1 row per PK (GROUP BY forms upstream; the pay LEFT JOIN is key-unique on the
    # (brand_id, feedback_date) subset of the PK), so merge_on_pk's in-batch dedup is a no-op;
    # order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    run_job("gold-conversion-feedback", build, target_table=TABLE)
