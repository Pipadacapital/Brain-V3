"""
gold_cohort_member.py — NET-NEW Gold `cohort_member` mart (Brain V4, GROUP "NEW gap Gold products").

NO dbt predecessor (parity status=NEW). The USER-GRAIN companion to the aggregate gold_cohorts: where
gold_cohorts holds one row per (brand_id, cohort_month) with the cohort's size/value, this mart holds the
per-CUSTOMER membership so a single cohort CELL — (acquisition month, months-since) — can be DRILLED into
to list exactly which customers are active in it. It is the row-level substrate the cohort heatmap clicks
through to.

GRAIN / PK : 1 row per (brand_id, customer_key, period_index). brand_id is the tenant key + FIRST column +
             pk[0] (V4 rule 5). customer_key is the canonical customer (brain_id from gold_customer_360).
             period_index is the whole-months offset of an ACTIVE (ordered-in) period from the cohort month
             — so a customer contributes one row per distinct month they placed a recognized order.
COLUMNS :
  cohort_month          — DATE, first-of-month of the customer's FIRST recognized order (the acquisition
                          month — the cohort this customer belongs to). Stable across all of a customer's rows.
  period_index          — INT whole months since cohort_month in which the customer placed a recognized
                          order. 0 = the cohort month itself; 3 = three calendar months later, etc. Only
                          ACTIVE periods get a row (sparse — a silent month emits nothing).
  active                — BOOLEAN, always TRUE: a row EXISTS iff the customer was active in that period
                          (one row per active period). The flag is carried explicitly so the serving cell
                          can COUNT(active) without re-deriving activity from a row's mere presence.
  order_count_in_period — BIGINT count of recognized orders the customer placed in that month bucket.

NO MONEY: this is an identity/membership + activity-count mart (counts only) — there is NO money column,
  so no minor-unit / currency_code pairing applies (the aggregate value/size lives in gold_cohorts).

"RECOGNIZED ORDER" (the membership basis — same vocabulary as gold_customer_360's lifecycle fold over
  silver_order_state): an order whose lifecycle has advanced past initial placement — lifecycle_state IS
  NOT NULL AND lifecycle_state <> 'placed' (revenue-recognized, never a bare unrecognized placement). The
  order's month is taken from first_event_at (the order-placement timestamp on the silver_order_state spine),
  truncated to month. cohort_month = MIN(order_month) over the customer ⇒ period_index is always >= 0.

SOURCES (read ONLY via the silver() seam for Silver; the sibling Gold 360 read is the canonical customer set):
  silver_order_state   — brand_id, brain_id, lifecycle_state, first_event_at. The order spine: supplies the
                         recognized-order months that drive cohort_month + the per-period activity rows.
  gold_customer_360    — OPTIONAL sibling Gold mart (one row per brand_id, brain_id) used ONLY as the
                         canonical customer set: membership rows are restricted to customers that exist in
                         the 360 (post-merge canonical brain_id). On a cold cycle where the 360 is not yet
                         built, the customer set degrades to the distinct brain_ids on the orders themselves
                         (honest-empty never blocks; the next refresh re-derives against the 360).

REPLAY-SAFE: full recompute from Silver, MERGE-UPDATE'd on the (brand_id, customer_key, period_index) PK —
  a re-run over the same Silver yields byte-identical rows (the rollup is authoritative, never an add).
"""
from __future__ import annotations

from _gold_base import (
    CATALOG,
    GOLD_NAMESPACE,
    ensure_gold_table,
    merge_on_pk,
    run_job,
    silver,
)

TABLE = "gold_cohort_member"

COLUMNS_SQL = """
          brand_id              string    NOT NULL,
          customer_key          string    NOT NULL,
          cohort_month          date      NOT NULL,
          period_index          int       NOT NULL,
          active                boolean   NOT NULL,
          order_count_in_period bigint    NOT NULL,
          updated_at            timestamp NOT NULL
""".strip("\n")


def _register_customer_set(spark, sos_view: str) -> str:
    """The canonical customer set view. Prefer the sibling Gold gold_customer_360 (one row per
    (brand_id, brain_id) — the post-merge canonical customers); if it is absent on a cold cycle, fall
    back to the distinct brain_ids carried on the orders themselves so the job still produces honest
    membership. Returns the temp-view name to JOIN the recognized orders against."""
    c360 = f"{CATALOG}.{GOLD_NAMESPACE}.gold_customer_360"
    view = "_cohort_member_custset"
    try:
        spark.table(c360).schema  # force metadata resolution — absent table raises here
        src = f"SELECT DISTINCT brand_id, brain_id AS customer_key FROM {c360} WHERE brain_id IS NOT NULL"
        print(f"[gold_cohort_member] customer set = gold_customer_360 ({c360})", flush=True)
    except Exception:  # noqa: BLE001 — cold cycle: 360 not built yet → derive set from the orders
        src = f"SELECT DISTINCT brand_id, brain_id AS customer_key FROM {sos_view} WHERE brain_id IS NOT NULL"
        print("[gold_cohort_member] gold_customer_360 absent → customer set from silver_order_state", flush=True)
    spark.sql(f"CREATE OR REPLACE TEMPORARY VIEW {view} AS {src}")
    return view


def build(spark):
    sos = silver("silver_order_state")          # the order spine (brand-filtered under partition-incremental)
    custset = _register_customer_set(spark, sos)  # canonical customer set (gold_customer_360, else orders)

    staged = spark.sql(
        f"""
        WITH recognized AS (
            SELECT
                o.brand_id,
                o.brain_id                                          AS customer_key,
                CAST(date_trunc('MONTH', o.first_event_at) AS DATE) AS order_month
            FROM {sos} o
            JOIN {custset} c
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
                CAST(months_between(r.order_month, c.cohort_month) AS INT) AS period_index,
                COUNT(*)                                                   AS order_count_in_period
            FROM recognized r
            JOIN cohort c
              ON c.brand_id = r.brand_id AND c.customer_key = r.customer_key
            GROUP BY r.brand_id, r.customer_key, c.cohort_month,
                     CAST(months_between(r.order_month, c.cohort_month) AS INT)
        )
        SELECT
            brand_id,
            customer_key,
            cohort_month,
            period_index,
            TRUE                                  AS active,
            CAST(order_count_in_period AS BIGINT) AS order_count_in_period,
            current_timestamp()                   AS updated_at
        FROM per_period
        WHERE brand_id IS NOT NULL AND customer_key IS NOT NULL
        """
    )

    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")
    merge_on_pk(spark, fqtn, staged, ["brand_id", "customer_key", "period_index"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-cohort-member", build, entity_incremental={
        "table_name": "gold_cohort_member",
        "source_tables": ["silver_order_state"],
    })
