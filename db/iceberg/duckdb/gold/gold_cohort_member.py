"""
gold_cohort_member.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_cohort_member.py.

NET-NEW Gold `cohort_member` mart (Brain V4, GROUP "NEW gap Gold products", NO dbt predecessor). The
per-CUSTOMER membership companion to the aggregate gold_cohorts: where gold_cohorts holds one row per
(brand_id, cohort_month) with the cohort's size/value, THIS mart holds the row-level substrate the cohort
heatmap clicks through to — one row per distinct month a customer placed a recognized order, so a single
cohort CELL (acquisition month × months-since) can be DRILLED into to list exactly which customers are
active in it.

THE TRANSFORM (verbatim from the Spark job's staged SQL):
  recognized  = silver_order_state rows that are RECOGNIZED orders, restricted to the canonical customer
                set. A "recognized order" (same vocabulary as gold_customer_360's lifecycle fold) is one
                whose lifecycle has advanced past initial placement — lifecycle_state IS NOT NULL AND
                lifecycle_state <> 'placed'. Its month = date_trunc('MONTH', first_event_at) → DATE.
  cohort      = per (brand_id, customer_key): MIN(order_month) = the acquisition month = the customer's
                cohort_month (stable across all of that customer's rows; ⇒ period_index >= 0 always).
  per_period  = per (brand_id, customer_key, order_month): period_index = whole months from cohort_month
                to order_month; order_count_in_period = COUNT(*) recognized orders that month.
  result      = one row per (brand_id, customer_key, period_index): active=TRUE (a row EXISTS iff the
                customer was active that period), order_count_in_period bigint, updated_at = now() UTC.

GRAIN / PK : exactly 1 row per (brand_id, customer_key, period_index) — matches the Spark mart PK EXACTLY.
  brand_id is the tenant key + FIRST column + pk[0] (V4 rule 5). customer_key is the canonical customer
  (brain_id from gold_customer_360). period_index is the whole-months offset of an ACTIVE period from the
  cohort month — sparse (a silent month emits nothing), 0 = the cohort month itself.

CUSTOMER SET (the Spark _register_customer_set fallback, verbatim): PREFER the sibling Gold gold_customer_360
  (distinct post-merge canonical brain_ids). On a COLD cycle where the 360 is not yet built, DEGRADE to the
  distinct brain_ids carried on the orders themselves — honest-empty never blocks; the next refresh
  re-derives against the 360. Here the 360 exists → customer set = gold_customer_360.

MONTH MATH (parity — CRITICAL):
  - date_trunc('MONTH', first_event_at) : Spark truncates the UTC instant to month-start. DuckDB
    date_trunc('month', ts AT TIME ZONE 'UTC') pins the wall-clock to UTC first (session is SET
    TimeZone='UTC' too), then CAST(... AS DATE) → the same first-of-month DATE, TZ-artifact-free.
  - months_between(order_month, cohort_month) : Spark months_between on two FIRST-OF-MONTH dates yields
    an EXACT integer month count. DuckDB has no months_between, but date_diff('month', cohort_month,
    order_month) is the calendar-month-boundary difference — for two month-start DATEs it equals the whole
    -month offset EXACTLY (verified: 2025-01-01→2025-04-01 = 3, 2025-01-01→2026-02-01 = 13). CAST AS INT.

NO MONEY: this is an identity/membership + activity-count mart (counts only) — there is NO money column,
  so no minor-unit / currency_code pairing applies (the aggregate value/size lives in gold_cohorts).

REPLAY-SAFE: full recompute from Silver each run, MERGE-UPDATE'd on the (brand_id, customer_key,
  period_index) PK — a re-run over the same Silver yields byte-identical rows (the rollup is authoritative,
  never an add). The GROUP BY already yields one row per PK, so the in-batch dedup order_by is a stable
  no-op tie-break. (The Spark job also carries an entity_incremental brand-bucketing wrapper — a perf
  optimisation whose end-state is byte-identical to this full recompute; not ported, the DuckDB parallel
  run is the FULL_REFRESH-equivalent path.)

QUARANTINE: the Spark job has NO Stage-1 quarantine side-write here (it reads already-gated Silver / a
  sibling Gold set) — nothing to skip. This framework never writes a quarantine table either.

Parity target: brain_gold.gold_cohort_member (3400 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_cohort_member_duckdb_test
# instead of the live Spark-owned table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_cohort_member{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
GOLD_CUSTOMER_360 = f"{CATALOG}.{GOLD_NAMESPACE}.gold_customer_360"

# Mirrors the Spark COLUMNS_SQL order/types (NO money column — pure membership + activity counts).
COLUMNS_SQL = """
  brand_id              string    NOT NULL,
  customer_key          string    NOT NULL,
  cohort_month          date      NOT NULL,
  period_index          int       NOT NULL,
  active                boolean   NOT NULL,
  order_count_in_period bigint    NOT NULL,
  updated_at            timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "customer_key", "cohort_month", "period_index",
    "active", "order_count_in_period", "updated_at",
]

PK = ["brand_id", "customer_key", "period_index"]


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent table → optional source degrades (cold-cycle fallback)
        return False


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ── canonical customer set (Spark _register_customer_set): prefer the sibling Gold gold_customer_360
    #    (post-merge canonical brain_ids); on a cold cycle where it is absent, derive the set from the
    #    distinct brain_ids on the orders themselves. Same set the Spark job JOINs recognized orders to. ──
    if _table_exists(con, GOLD_CUSTOMER_360):
        custset = (
            f"SELECT DISTINCT brand_id, brain_id AS customer_key FROM {GOLD_CUSTOMER_360} "
            "WHERE brain_id IS NOT NULL"
        )
        print(f"[gold_cohort_member] customer set = gold_customer_360 ({GOLD_CUSTOMER_360})", flush=True)
    else:
        custset = (
            f"SELECT DISTINCT brand_id, brain_id AS customer_key FROM {SILVER_ORDER_STATE} "
            "WHERE brain_id IS NOT NULL"
        )
        print("[gold_cohort_member] gold_customer_360 absent → customer set from silver_order_state", flush=True)

    staged = f"""
      WITH recognized AS (
          SELECT
              o.brand_id,
              o.brain_id                                                       AS customer_key,
              CAST(date_trunc('month', o.first_event_at AT TIME ZONE 'UTC') AS DATE) AS order_month
          FROM {SILVER_ORDER_STATE} o
          JOIN ({custset}) c
            ON c.brand_id = o.brand_id AND c.customer_key = o.brain_id
          WHERE o.brain_id IS NOT NULL
            AND o.first_event_at IS NOT NULL
            AND o.lifecycle_state IS NOT NULL
            AND o.lifecycle_state <> 'placed'   -- recognized: advanced past initial placement
      ),
      cohort AS (
          SELECT brand_id, customer_key, MIN(order_month) AS cohort_month
          FROM recognized
          GROUP BY brand_id, customer_key
      ),
      per_period AS (
          SELECT
              r.brand_id,
              r.customer_key,
              c.cohort_month,
              CAST(date_diff('month', c.cohort_month, r.order_month) AS INT) AS period_index,
              COUNT(*)                                                       AS order_count_in_period
          FROM recognized r
          JOIN cohort c
            ON c.brand_id = r.brand_id AND c.customer_key = r.customer_key
          GROUP BY r.brand_id, r.customer_key, c.cohort_month,
                   CAST(date_diff('month', c.cohort_month, r.order_month) AS INT)
      )
      SELECT
          brand_id,
          customer_key,
          cohort_month,
          period_index,
          TRUE                                  AS active,
          CAST(order_count_in_period AS BIGINT) AS order_count_in_period,
          now() AT TIME ZONE 'UTC'              AS updated_at
      FROM per_period
      WHERE brand_id IS NOT NULL AND customer_key IS NOT NULL
    """

    # Idempotent MERGE on the (brand_id, customer_key, period_index) PK — the per_period GROUP BY already
    # yields one row per PK, so order_by_desc (updated_at then cohort_month) is a stable no-op tie-break.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK,
                       order_by_desc=["updated_at", "cohort_month"])


if __name__ == "__main__":
    run_job("gold-cohort-member", build, target_table="gold_cohort_member")
