"""
gold_funnel_user.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_funnel_user.py.

NET-NEW user-grain Gold `funnel_user` mart (Brain V4, GROUP "NEW gap Gold products"). NO dbt
predecessor (parity status=NEW). The per-VISITOR furthest-funnel-stage surface — one row per
(brand_id, visitor_id) recording the DEEPEST funnel step that visitor ever reached. Unlike the daily
aggregate gold_funnel (counts per step), this is the visitor-resolution behind it: a funnel STEP
panel can list the exact visitors who reached it but NOT the next one (dropped at that step) by
selecting furthest_step = '<step>'.

GRAIN / PK : 1 row per (brand_id, visitor_id). brand_id is the tenant key + FIRST column + pk[0]
             (V4 rule 5). visitor_id is the journey/visitor key: the pixel `brain_anon_id`, upgraded
             to the stitched canonical `brain_id` when the identity graph has resolved one
             (silver_touchpoint stitched_brain_id) — so a logged-in/stitched journey collapses onto
             its canonical identity.

COLUMNS (booleans + a step label + a timestamp — NO money; funnel-stage identity bookkeeping):
  reached_session      bool — the visitor fired a `session.started` pixel event.
  reached_product_view bool — fired a `page.viewed` or `product.viewed` pixel event.
  reached_cart         bool — fired a `cart.viewed` or `cart.item_added` pixel event.
  reached_checkout     bool — fired a `checkout.started` pixel event.
  reached_purchase     bool — the stitched identity links this visitor to an order in
                              silver_order_state (order.brain_id = visitor_id). FALSE for any visitor
                              with no stitched order (an un-stitched brain_anon_id can never equal an
                              order brain_id → purchase=false).
  furthest_step  varchar — the DEEPEST reached_* that is true, in funnel order
                           session < product_view < cart < checkout < purchase. A pixel visitor with
                           none of the named events still originates from a session → floor 'session'.
  last_seen_at   — the most recent activity timestamp: MAX over the visitor's pixel events, extended
                   by the purchasing order's state_effective_at when reached_purchase.

SOURCES (read as sibling Silver Iceberg tables directly, exactly like the Spark job reads them via
  the silver() seam — this GOLD framework reads {CATALOG}.brain_silver.<t> directly):
  silver_collector_event — pixel events; brain_anon_id via json_extract_string(payload,
                           '$.properties.brain_anon_id'); event_type drives every reached_* flag
                           (the visitor universe = pixel visitors).
  silver_touchpoint      — per (brand_id, brain_anon_id) the stitched canonical identity
                           (stitched_brain_id): (a) upgrades visitor_id to the canonical brain_id and
                           (b) links to orders.
  silver_order_state     — per-order canonical state; order.brain_id matched to the stitched
                           visitor_id gives reached_purchase (un-stitched visitors stay purchase=false).

REPLAY-SAFE: full recompute from Silver, MERGE-UPDATE'd on the (brand_id, visitor_id) PK. The Spark
  job calls merge_on_pk with delete_orphans DEFAULT False (plain MATCHED-UPDATE / NOT-MATCHED-INSERT
  MERGE) — identical to DuckDB _base.merge_on_pk. No orphan-shed divergence to note here (unlike
  gold_funnel).

FULL RECOMPUTE vs Spark's entity-incremental wrapper: the Spark job wraps the identical build in
  run_entity_incremental (a SCALING optimization — recompute only brands with new events, each over
  full history, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is parity-equivalent:
  the MERGE on the mart PK is idempotent and restates every (brand, visitor) to the current aggregate.

QUARANTINE : none — this Gold mart has no Stage-1/quarantine side-write (it reads already-gated
             Silver). Nothing to skip.

Honors MIGRATION_TABLE_SUFFIX (→ gold_funnel_user_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_funnel_user.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_funnel_user_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_funnel_user"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_COLLECTOR = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
SILVER_TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"

# Mirrors the Spark COLUMNS_SQL order/types exactly. No money (funnel-stage identity bookkeeping).
# last_seen_at is a nullable naive timestamp; updated_at NOT NULL.
COLUMNS_SQL = """
  brand_id              string    NOT NULL,
  visitor_id            string    NOT NULL,
  reached_session       boolean   NOT NULL,
  reached_product_view  boolean   NOT NULL,
  reached_cart          boolean   NOT NULL,
  reached_checkout      boolean   NOT NULL,
  reached_purchase      boolean   NOT NULL,
  furthest_step         string    NOT NULL,
  last_seen_at          timestamp,
  updated_at            timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "visitor_id", "reached_session", "reached_product_view", "reached_cart",
    "reached_checkout", "reached_purchase", "furthest_step", "last_seen_at", "updated_at",
]

PK = ["brand_id", "visitor_id"]

# Extract the pixel brain_anon_id from payload.properties (get_json_object → json_extract_string).
ANON = f"json_extract_string(payload, '$.properties.brain_anon_id')"


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # Faithful SQL port of the Spark staged CTE chain.
    #   events    — pixel events with a non-null extracted brain_anon_id (occurred_at → UTC-naive).
    #   identity  — MAX(stitched_brain_id) per anon: a stable single value where the graph resolved one.
    #   resolved  — visitor_id = COALESCE(stitched canonical, raw anon).
    #   per_visitor — the reached_* funnel flags (MAX over booleans = OR) + last_pixel_at.
    #   orders    — order.brain_id ⇒ (stitched) visitor_id; un-stitched anon never matches → purchase=false.
    # last_seen_at extends last_pixel_at by the purchasing order's state_effective_at when it is later.
    staged = f"""
        WITH events AS (
            SELECT
                brand_id,
                {ANON} AS brain_anon_id,
                event_type,
                occurred_at AT TIME ZONE 'UTC' AS occurred_at
            FROM {SILVER_COLLECTOR}
            WHERE brand_id IS NOT NULL
              AND {ANON} IS NOT NULL
        ),
        identity AS (
            SELECT
                brand_id,
                brain_anon_id,
                MAX(stitched_brain_id) AS stitched_brain_id
            FROM {SILVER_TOUCHPOINT}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
            GROUP BY brand_id, brain_anon_id
        ),
        resolved AS (
            SELECT
                e.brand_id,
                COALESCE(i.stitched_brain_id, e.brain_anon_id) AS visitor_id,
                e.event_type,
                e.occurred_at
            FROM events e
            LEFT JOIN identity i
              ON e.brand_id = i.brand_id AND e.brain_anon_id = i.brain_anon_id
        ),
        per_visitor AS (
            SELECT
                brand_id,
                visitor_id,
                MAX(event_type = 'session.started')                   AS reached_session,
                MAX(event_type IN ('page.viewed', 'product.viewed'))  AS reached_product_view,
                MAX(event_type IN ('cart.viewed', 'cart.item_added')) AS reached_cart,
                MAX(event_type = 'checkout.started')                  AS reached_checkout,
                MAX(occurred_at)                                      AS last_pixel_at
            FROM resolved
            WHERE visitor_id IS NOT NULL
            GROUP BY brand_id, visitor_id
        ),
        orders AS (
            SELECT
                brand_id,
                brain_id                                  AS visitor_id,
                MAX(state_effective_at AT TIME ZONE 'UTC') AS last_order_at
            FROM {SILVER_ORDER_STATE}
            WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL
            GROUP BY brand_id, brain_id
        )
        SELECT
            v.brand_id,
            v.visitor_id,
            v.reached_session,
            v.reached_product_view,
            v.reached_cart,
            v.reached_checkout,
            (o.visitor_id IS NOT NULL)                                         AS reached_purchase,
            CASE
                WHEN o.visitor_id IS NOT NULL    THEN 'purchase'
                WHEN v.reached_checkout          THEN 'checkout'
                WHEN v.reached_cart              THEN 'cart'
                WHEN v.reached_product_view      THEN 'product_view'
                ELSE 'session'
            END                                                                AS furthest_step,
            CASE
                WHEN o.last_order_at IS NOT NULL AND o.last_order_at > v.last_pixel_at
                    THEN o.last_order_at
                ELSE v.last_pixel_at
            END                                                                AS last_seen_at,
            now() AT TIME ZONE 'UTC'                                           AS updated_at
        FROM per_visitor v
        LEFT JOIN orders o
          ON v.brand_id = o.brand_id AND v.visitor_id = o.visitor_id
        WHERE v.brand_id IS NOT NULL AND v.visitor_id IS NOT NULL
    """

    # The rollup is already 1 row per PK (GROUP BY per_visitor + LEFT JOIN orders on the same grain),
    # so merge_on_pk's in-batch dedup is a no-op; order_by_desc=[updated_at, last_seen_at] is a
    # deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT (delete_orphans default in Spark).
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK,
                       order_by_desc=["updated_at", "last_seen_at"])


if __name__ == "__main__":
    run_job("gold-funnel-user", build, target_table=TABLE)
