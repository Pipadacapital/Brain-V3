"""
gold_customer_health.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_customer_health.py.

NET-NEW gap Gold `customer_health` mart (Brain V4 Phase 2, GROUP "NEW gap Gold products"). The
DETERMINISTIC, historical per-customer health/churn surface.

NO dbt predecessor (parity status=NEW). One row per resolved customer (brand_id, brain_id) holding the
deterministic recency/frequency health band that the customer-health dashboard reads. This is the
HISTORICAL (deterministic) variant ONLY — the PREDICTIVE health variant stays DISABLED in the registry;
NOTHING here calls a model. Read from Iceberg brain_silver.silver_order_state (order spine, for the
recency/frequency facts) LEFT JOIN brain_silver.silver_customer (the canonical customer entity, for the
sibling lifetime_value_minor + currency_code money pair — carried VERBATIM, never blended into the score).

GRAIN / PK: exactly one row per (brand_id, brain_id) — matches the Spark mart PK EXACTLY. brand_id first +
  tenant key + partition anchor. Unlinked orders (brain_id NULL) are EXCLUDED — not yet a known customer.
COLUMNS :
  recency_days         — INT days since this customer's most recent order (date_diff to current_date).
  frequency            — BIGINT distinct-order count for this customer.
  health_score         — INTEGER 0-100, deterministic from recency + frequency (formula below). NO money.
  health_band          — string healthy | at_risk | churned (deterministic recency thresholds below).
  last_order_at        — timestamp of the customer's most recent order (max first_event_at).
  lifetime_value_minor — BIGINT minor units carried VERBATIM from silver_customer (sibling money pair).
  currency_code        — the sibling currency for lifetime_value_minor (never blended across currencies).

HEALTH_SCORE FORMULA (deterministic, pure integer math — NO float, NO money input):
  health_score = recency_component + frequency_component, where
    recency_component (0-60) = 60 if recency_days <= 30 / 45 <= 60 / 30 <= 90 / 15 <= 180 / else 0
    frequency_component (0-40) = 40 if freq >= 10 / 30 >= 5 / 20 >= 3 / 10 >= 2 / else 5 (>=1 order)
  → range is [5, 100], a confidence-style INTEGER 0-100 (never blended with money).

HEALTH_BAND THRESHOLDS (deterministic, on recency_days — the churn signal):
  healthy  : recency_days <= 90 / at_risk : 90 < recency_days <= 180 / churned : recency_days > 180

DATE MATH (Spark → DuckDB): Spark datediff(current_date(), CAST(last_order_at AS DATE)) = whole-day
  (end − start) → DuckDB date_diff('day', CAST(last_order_at AS DATE), current_date) — the ARGUMENT ORDER
  flips (start first, end second) so the sign matches. Both truncate to a plain DATE before the diff, so a
  same-instant timestamptz yields the identical whole-day count.
MONEY (I-S07): lifetime_value_minor carried VERBATIM from silver_customer (never re-derived, never a
  float), paired with currency_code on-row (one currency per customer — never blended). The health_score /
  health_band are non-money deterministic tiers. brand_id is the tenant key, first column.

REPLAY-SAFE: full recompute from Silver each refresh, MERGE-UPDATE'd on the PK (brand_id, brain_id).

FULL RECOMPUTE vs Spark's entity_incremental wrapper: the Spark job wraps the identical rollup in
  run_job(entity_incremental=...) (a SCALING optimization — recompute only brands whose source Silver
  changed since the watermark, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is
  parity-equivalent: the MERGE on the mart PK is idempotent and restates every (brand_id, brain_id).

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver).
VENDORED: nothing — the Spark job uses only built-in functions (no pure helper module).

Parity target: brain_gold.gold_customer_health (NEW — no Spark-produced oracle). PK (brand_id, brain_id);
  money col lifetime_value_minor.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_customer_health_duckdb_test
# instead of the live mart (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_customer_health{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
SILVER_CUSTOMER = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"

# Column contract — byte-for-byte the Spark mart's COLUMNS_SQL. brand_id tenant key first; money =
# bigint minor + currency. Uses Iceberg/Spark type names (ensure_table maps them).
COLUMNS_SQL = """
  brand_id             string    NOT NULL,
  brain_id             string    NOT NULL,
  recency_days         int       NOT NULL,
  frequency            bigint    NOT NULL,
  health_score         int       NOT NULL,
  health_band          string    NOT NULL,
  last_order_at        timestamp,
  lifetime_value_minor bigint,
  currency_code        string,
  updated_at           timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_id", "recency_days", "frequency", "health_score", "health_band",
    "last_order_at", "lifetime_value_minor", "currency_code", "updated_at",
]

PK = ["brand_id", "brain_id"]


def build(con):
    # brand-first tenant bucketing (mirrors the Spark bucket(16, brand_id) hidden partitioning).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(16, brand_id)")

    # ── recency/frequency facts from the order spine, one row per resolved customer, then the
    #    deterministic score/band + the VERBATIM sibling money pair from silver_customer. ──
    staged = f"""
      WITH order_rollup AS (
        SELECT
          brand_id,
          brain_id,
          COUNT(DISTINCT order_id) AS frequency,
          MAX(first_event_at)      AS last_order_at
        FROM {SILVER_ORDER_STATE}
        WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL
        GROUP BY brand_id, brain_id
      ),
      scored AS (
        SELECT
          brand_id,
          brain_id,
          frequency,
          last_order_at,
          -- recency_days: integer days since the most recent order. Spark datediff(current_date(),
          -- CAST(last_order_at AS DATE)) → date_diff('day', <date>, current_date) (args flipped).
          CAST(date_diff('day', CAST(last_order_at AS DATE), current_date) AS INT) AS recency_days
        FROM order_rollup
      )
      SELECT
        s.brand_id,
        s.brain_id,
        s.recency_days,
        s.frequency,
        -- health_score 0-100 = recency_component(0-60) + frequency_component(0-40). Pure integer math;
        -- NO money input — a confidence-style INTEGER, never blended with the money pair.
        CAST(
          (CASE WHEN s.recency_days <= 30  THEN 60
                WHEN s.recency_days <= 60  THEN 45
                WHEN s.recency_days <= 90  THEN 30
                WHEN s.recency_days <= 180 THEN 15
                ELSE 0 END)
          +
          (CASE WHEN s.frequency >= 10 THEN 40
                WHEN s.frequency >= 5  THEN 30
                WHEN s.frequency >= 3  THEN 20
                WHEN s.frequency >= 2  THEN 10
                ELSE 5 END)
        AS INTEGER)                                        AS health_score,
        -- health_band: deterministic recency thresholds (the churn signal).
        CASE WHEN s.recency_days <= 90  THEN 'healthy'
             WHEN s.recency_days <= 180 THEN 'at_risk'
             ELSE 'churned' END                            AS health_band,
        s.last_order_at,
        -- Sibling money pair carried VERBATIM from the canonical customer entity (never blended into
        -- health_score, never summed across currencies — one currency per customer row).
        sc.lifetime_value_minor,
        sc.currency_code,
        now() AT TIME ZONE 'UTC'                           AS updated_at
      FROM scored s
      LEFT JOIN {SILVER_CUSTOMER} sc
        ON sc.brand_id = s.brand_id AND sc.brain_id = s.brain_id
    """

    # Idempotent MERGE on the (brand_id, brain_id) PK — the order rollup yields one row per PK, so the
    # in-batch dedup order_by is a stable tie-break no-op.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK,
                       order_by_desc=["updated_at", "frequency"])


if __name__ == "__main__":
    run_job("gold-customer-health", build, target_table="gold_customer_health")
