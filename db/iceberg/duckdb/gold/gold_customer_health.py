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

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
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

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD (Phase 1b) ─────────────
    #   GRAIN = entity_fold: MANY silver_order_state rows aggregate into ONE (brand_id, brain_id) customer
    #   health row whose recency/frequency depend on that entity's FULL order history — including rows
    #   BELOW the watermark. Windowing the fold input directly would drop history → wrong frequency /
    #   recency / band. So we window ONLY to DISCOVER which entities changed (a new order landed since the
    #   last run), then re-fold each changed entity over its FULL, UNWINDOWED order history; the MERGE on
    #   the PK (brand_id, brain_id) upserts exactly those restated rows.
    #
    #   GOLD TIER GATE: enabled=GOLD_INCREMENTAL so Gold flips INDEPENDENTLY of Silver (already ON in prod).
    #
    #   CLOCK: the fold-driving source is silver_order_state, an ENTITY Silver mart with NO top-level
    #   `ingested_at` column (its arrival rollup max_ingested_at is a nullable payload-derived value, NOT a
    #   monotonic write clock). Its real arrival/write clock is `updated_at` (NOT NULL, now()-stamped on
    #   each rebuild — "which order rows changed since last run"), so ts_col='updated_at'.
    #
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the staged SQL
    #   below is BYTE-IDENTICAL to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-customer-health", SILVER_ORDER_STATE,
                                ts_col="updated_at", enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); an [lo, hi] range
    # over the order spine's write clock otherwise.
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    order_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: entities whose order spine changed within [lo, hi], using the SAME (brand_id,
    # brain_id) key + NOT-NULL guards the fold uses. Built ONLY when incremental (lo not None).
    changed = f"""
      SELECT DISTINCT brand_id, brain_id
      FROM {SILVER_ORDER_STATE}
      WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL{order_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed entities so
    # each re-folds over its ENTIRE order history. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        f"        AND (brand_id, brain_id) IN (SELECT brand_id, brain_id FROM ({changed}))\n"
        if lo is not None else ""
    )

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
{refold_filter}        GROUP BY brand_id, brain_id
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
    # The watermark tracks the order spine's write clock (silver_order_state.updated_at) — this Gold job's
    # changed-set is driven by that entity Silver mart, which has no top-level ingested_at column.
    run_job("gold-customer-health", build, target_table="gold_customer_health",
            source_table=SILVER_ORDER_STATE, ts_col="updated_at")
