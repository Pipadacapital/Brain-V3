"""
gold_customer_health.py — NET-NEW gap Gold `customer_health` mart (Brain V4 Phase 2, GROUP "NEW gap
Gold products"). The DETERMINISTIC, historical per-customer health/churn surface.

NO dbt predecessor (parity status=NEW). One row per resolved customer (brand_id, brain_id) holding the
deterministic recency/frequency health band that the customer-health dashboard reads. This is the
HISTORICAL (deterministic) variant ONLY — the PREDICTIVE health variant stays DISABLED in the registry;
NOTHING here calls a model. Read from Iceberg brain_silver.silver_order_state (order spine, for the
recency/frequency facts) LEFT JOIN brain_silver.silver_customer (the canonical customer entity, for the
sibling lifetime_value_minor + currency_code money pair — carried VERBATIM, never blended into the score).

GRAIN   : 1 row per (brand_id, brain_id). brand_id first + tenant key + partition anchor. Unlinked
          orders (brain_id NULL) are EXCLUDED — not yet a known customer (mirrors silver_customer).
COLUMNS :
  recency_days         — INT days since this customer's most recent order (datediff to current_date).
  frequency            — BIGINT distinct-order count for this customer.
  health_score         — INTEGER 0-100, deterministic from recency + frequency (formula below). NO money.
  health_band          — string healthy | at_risk | churned (deterministic recency thresholds below).
  last_order_at        — timestamp of the customer's most recent order (max first_event_at).
  lifetime_value_minor — BIGINT minor units carried VERBATIM from silver_customer (sibling money pair).
  currency_code        — the sibling currency for lifetime_value_minor (never blended across currencies).

HEALTH_SCORE FORMULA (deterministic, pure integer math — NO float, NO money input):
  health_score = recency_component + frequency_component, where
    recency_component (0-60) = 60 if recency_days <= 30
                               45 if recency_days <= 60
                               30 if recency_days <= 90
                               15 if recency_days <= 180
                                0 otherwise
    frequency_component (0-40) = 40 if frequency >= 10
                                 30 if frequency >= 5
                                 20 if frequency >= 3
                                 10 if frequency >= 2
                                  5 otherwise (a customer with >=1 order)
  → range is [5, 100], a confidence-style INTEGER 0-100 (never blended with money).

HEALTH_BAND THRESHOLDS (deterministic, on recency_days — the churn signal):
  healthy  : recency_days <= 90
  at_risk  : 90 < recency_days <= 180
  churned  : recency_days > 180

REPLAY-SAFE: full recompute from Silver each refresh, MERGE-UPDATE'd on the PK (brand_id, brain_id).
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_customer_health"

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


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(16, brand_id)")

    staged = spark.sql(
        f"""
        WITH order_rollup AS (
            -- recency/frequency facts from the order spine, one row per resolved customer.
            SELECT
                brand_id,
                brain_id,
                COUNT(DISTINCT order_id)   AS frequency,
                MAX(first_event_at)        AS last_order_at
            FROM {silver('silver_order_state')}
            WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL
            GROUP BY brand_id, brain_id
        ),
        scored AS (
            SELECT
                brand_id,
                brain_id,
                frequency,
                last_order_at,
                -- recency_days: integer days since the most recent order (datediff is INT).
                CAST(datediff(current_date(), CAST(last_order_at AS DATE)) AS INT) AS recency_days
            FROM order_rollup
        )
        SELECT
            s.brand_id,
            s.brain_id,
            s.recency_days,
            s.frequency,
            -- health_score 0-100 = recency_component(0-60) + frequency_component(0-40). Pure integer
            -- math; NO money input — a confidence-style INTEGER, never blended with the money pair.
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
            AS INT)                                            AS health_score,
            -- health_band: deterministic recency thresholds (the churn signal).
            CASE WHEN s.recency_days <= 90  THEN 'healthy'
                 WHEN s.recency_days <= 180 THEN 'at_risk'
                 ELSE 'churned' END                            AS health_band,
            s.last_order_at,
            -- Sibling money pair carried VERBATIM from the canonical customer entity (never blended
            -- into health_score, never summed across currencies — one currency per customer row).
            sc.lifetime_value_minor,
            sc.currency_code,
            current_timestamp()                                AS updated_at
        FROM scored s
        LEFT JOIN {silver('silver_customer')} sc
          ON sc.brand_id = s.brand_id AND sc.brain_id = s.brain_id
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "brain_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-customer-health", build, entity_incremental={
        "table_name": "gold_customer_health", "source_tables": ["silver_order_state", "silver_customer"],
    })
