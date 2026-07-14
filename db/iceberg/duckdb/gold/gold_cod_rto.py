"""
gold_cod_rto.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_cod_rto.py.

GOLD mart (not a Bronze/keystone read): READS the sibling Silver Iceberg table
{CATALOG}.brain_silver.silver_cod_rto directly (the 3-way reconciled COD order ⨝ rto-predict ⨝ awb
grain) and rolls it up to the COD/RTO outcome mart {CATALOG}.brain_gold.gold_cod_rto via an idempotent
MERGE on the mart PK. One row per (brand_id, currency_code) holding the brand's COD/RTO funnel: COD order
count + at-risk COD cash, predicted-RTO count, actual delivered/RTO outcomes, and the prediction accuracy.

THE TRANSFORM (byte/minor-unit exact — reproduced verbatim from the Spark staged CTE, itself the
cod-rto-rates metric materialized):
    WITH agg AS (
      SELECT brand_id, COALESCE(currency_code,'INR') AS currency_code,
             count(*)                                                    AS cod_orders,
             COALESCE(sum(COALESCE(cod_amount_minor,0)),0)               AS cod_amount_minor,
             sum(CASE WHEN predicted_rto      = true THEN 1 ELSE 0 END)  AS predicted_rto,
             sum(CASE WHEN actual_delivered   = true THEN 1 ELSE 0 END)  AS actual_delivered,
             sum(CASE WHEN actual_rto         = true THEN 1 ELSE 0 END)  AS actual_rto,
             sum(CASE WHEN prediction_correct = true THEN 1 ELSE 0 END)  AS prediction_correct,
             sum(CASE WHEN prediction_correct IS NOT NULL THEN 1 ELSE 0 END) AS prediction_evaluated
      FROM silver_cod_rto WHERE brand_id IS NOT NULL AND is_cod = true
      GROUP BY brand_id, COALESCE(currency_code,'INR'))
    SELECT ..., (actual_delivered + actual_rto) AS resolved,
           CASE WHEN resolved > 0 THEN actual_rto * 10000 / resolved ELSE NULL END AS rto_rate_bps,
           ..., CASE WHEN prediction_evaluated > 0
                     THEN prediction_correct * 10000 / prediction_evaluated ELSE NULL END
                                                                        AS prediction_accuracy_bps,
           current_timestamp() AS updated_at
    FROM agg

GRAIN / PK: exactly one row per (brand_id, currency_code) — the mart PK. Matches the Spark GROUP BY
  (brand_id, COALESCE(currency_code,'INR')) EXACTLY.
MONEY: cod_amount_minor = Σ at-risk COD cash as BIGINT MINOR units, per (brand, currency) — NEVER blended
  across currencies (GROUP BY currency_code isolates it). Paired with currency_code on-row. No float ever.
INTEGER-BPS RATES (parity — CRITICAL): Spark computes `CAST(a AS bigint) * 10000 / b` over two bigints,
  where `/` is Spark's integer division = TRUNCATE-toward-zero. DuckDB's `/` is float-divide; a naive
  `CAST(... AS bigint)` would ROUND to nearest and produce off-by-one bps. All operands here are
  non-negative counts, so Spark's truncate-toward-zero == integer FLOOR division — reproduced with
  DuckDB's integer `//` operator (`a * 10000 // b`). Both rates are NULL when their denominator is 0.
  - rto_rate_bps            = actual_rto        * 10000 // (actual_delivered + actual_rto)  [resolved base]
  - prediction_accuracy_bps = prediction_correct * 10000 // prediction_evaluated
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, currency_code) — re-running over the same Silver restates the
  same rows (UPDATE) and inserts new (brand, currency) pairs. Full recompute from Silver.

FULL RECOMPUTE vs Spark's entity-incremental wrapper: the Spark job wraps the identical GROUP BY in
  run_entity_incremental (a SCALING optimization — recompute only brands with new events, each over full
  history, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is parity-equivalent: the MERGE
  on the mart PK is idempotent and restates every (brand, currency) to the current Silver aggregate.

CAVEAT — orphan-shedding: the Spark job passes delete_orphans=True (WHEN NOT MATCHED BY SOURCE DELETE) so a
  (brand, currency) that disappears from Silver is dropped from the mart. DuckDB's _base.merge_on_pk does
  NOT implement a not-matched-by-source DELETE — this port is a MATCHED-UPDATE / NOT-MATCHED-INSERT MERGE
  only. Equivalent on a full recompute where no group ever disappears.

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver).

Parity target: brain_gold.gold_cod_rto.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_cod_rto_duckdb_test instead of
# the live mart (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_cod_rto{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_cod_rto"

# Column contract — byte-for-byte the Spark mart's COLUMNS_SQL order/types. brand_id tenant key first;
# money = bigint minor + currency; integer-bps rates nullable.
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

COLUMNS = [
    "brand_id", "currency_code", "cod_orders", "cod_amount_minor", "predicted_rto",
    "actual_delivered", "actual_rto", "resolved", "rto_rate_bps", "prediction_correct",
    "prediction_evaluated", "prediction_accuracy_bps", "updated_at",
]


def build(con):
    # brand-first tenant partitioning (mirrors Spark bucket(64, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ── the Spark staged aggregation, reproduced verbatim (additive components + integer-bps rates) ──
    staged = f"""
      WITH agg AS (
        SELECT
          brand_id,
          COALESCE(currency_code, 'INR')                                           AS currency_code,
          count(*)                                                                 AS cod_orders,
          COALESCE(sum(COALESCE(cod_amount_minor, 0)), 0)                          AS cod_amount_minor,
          sum(CASE WHEN predicted_rto      = true THEN 1 ELSE 0 END)               AS predicted_rto,
          sum(CASE WHEN actual_delivered   = true THEN 1 ELSE 0 END)               AS actual_delivered,
          sum(CASE WHEN actual_rto         = true THEN 1 ELSE 0 END)               AS actual_rto,
          sum(CASE WHEN prediction_correct = true THEN 1 ELSE 0 END)               AS prediction_correct,
          sum(CASE WHEN prediction_correct IS NOT NULL THEN 1 ELSE 0 END)          AS prediction_evaluated
        FROM {SOURCE}
        WHERE brand_id IS NOT NULL AND is_cod = true
        GROUP BY brand_id, COALESCE(currency_code, 'INR')
      )
      SELECT
        brand_id,
        currency_code,
        CAST(cod_orders           AS BIGINT)                                       AS cod_orders,
        CAST(cod_amount_minor     AS BIGINT)                                       AS cod_amount_minor,
        CAST(predicted_rto        AS BIGINT)                                       AS predicted_rto,
        CAST(actual_delivered     AS BIGINT)                                       AS actual_delivered,
        CAST(actual_rto           AS BIGINT)                                       AS actual_rto,
        CAST(actual_delivered + actual_rto AS BIGINT)                              AS resolved,
        -- Integer basis-point RTO rate over the RESOLVED base (truncate-toward-zero == // for non-neg
        -- counts); NULL when resolved = 0.
        CASE WHEN (actual_delivered + actual_rto) > 0
             THEN CAST(actual_rto AS BIGINT) * 10000 // (actual_delivered + actual_rto)
             ELSE NULL END                                                         AS rto_rate_bps,
        CAST(prediction_correct   AS BIGINT)                                       AS prediction_correct,
        CAST(prediction_evaluated AS BIGINT)                                       AS prediction_evaluated,
        CASE WHEN prediction_evaluated > 0
             THEN CAST(prediction_correct AS BIGINT) * 10000 // prediction_evaluated
             ELSE NULL END                                                         AS prediction_accuracy_bps,
        now() AT TIME ZONE 'UTC'                                                   AS updated_at
      FROM agg
    """

    # Idempotent MERGE on the (brand_id, currency_code) PK — replay-safe restatement. The GROUP BY already
    # yields one row per PK, so the in-batch dedup order_by is a stable no-op tie-break.
    return merge_on_pk(con, TARGET, staged, COLUMNS,
                       ["brand_id", "currency_code"],
                       order_by_desc=["updated_at", "cod_orders"])


if __name__ == "__main__":
    run_job("gold-cod-rto", build, target_table="gold_cod_rto")
