"""
gold_funnel_user.py — NET-NEW user-grain Gold `funnel_user` mart (Brain V4, GROUP "NEW gap Gold products").

NO dbt predecessor (parity status=NEW). The per-VISITOR furthest-funnel-stage surface — one row per
(brand_id, visitor_id) recording the DEEPEST funnel step that visitor ever reached. Unlike the daily
aggregate gold_funnel (counts per step), this is the visitor-resolution behind it: a funnel STEP panel can
list the exact visitors who reached it but NOT the next one (i.e. dropped at that step) by selecting
furthest_step = '<step>'.

GRAIN / PK : 1 row per (brand_id, visitor_id). brand_id is the tenant key + FIRST column + pk[0]
             (V4 rule 5). visitor_id is the journey/visitor key: the pixel `brain_anon_id`, upgraded to the
             stitched canonical `brain_id` when the identity graph has resolved one (silver_touchpoint
             stitched_brain_id) — so a logged-in/stitched journey collapses onto its canonical identity.
COLUMNS :
  reached_session      bool — the visitor fired a `session.started` pixel event.
  reached_product_view bool — fired a `page.viewed` or `product.viewed` pixel event.
  reached_cart         bool — fired a `cart.viewed` or `cart.item_added` pixel event.
  reached_checkout     bool — fired a `checkout.started` pixel event.
  reached_purchase     bool — the stitched identity links this visitor to an order in silver_order_state
                              (order.brain_id = visitor_id). FALSE for any visitor with no stitched order
                              (an un-stitched brain_anon_id can never equal an order brain_id → purchase=false).
  furthest_step varchar — the DEEPEST reached_* that is true, in funnel order
                          session < product_view < cart < checkout < purchase. A pixel visitor with none of
                          the named events still originates from a session, so the floor is 'session'.
  last_seen_at  — the most recent activity timestamp: MAX over the visitor's pixel events, extended by the
                  purchasing order's state_effective_at when reached_purchase.

NO money — this mart is funnel-stage identity bookkeeping (booleans + a step label + counts of nothing),
so registered money_columns=[]. brand_id first + partition anchor.

SOURCES (read ONLY via the silver() seam — bounded + brand-filtered under partition-incremental):
  silver_collector_event — pixel events; brain_anon_id via get_json_object(payload,'$.properties.brain_anon_id');
                           event_type drives every reached_* funnel flag (the visitor universe = pixel visitors).
  silver_touchpoint      — per (brand_id, brain_anon_id) the stitched canonical identity (stitched_brain_id),
                           used to (a) upgrade visitor_id to the canonical brain_id and (b) link to orders.
  silver_order_state     — per-order canonical state; order.brain_id matched to the stitched visitor_id gives
                           reached_purchase (the journey-to-revenue join; un-stitched visitors stay purchase=false).

REPLAY-SAFE: full recompute from Silver, MERGE-UPDATE'd on the (brand_id, visitor_id) PK.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_funnel_user"

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


def build(spark):
    # Resolve each Silver source ONCE via the silver() seam (under partition-incremental it returns a
    # brand-filtered temp view, keeping every read bounded to this bucket's brands).
    sce = silver("silver_collector_event")   # pixel events (funnel flags + brain_anon_id)
    stp = silver("silver_touchpoint")        # brain_anon_id -> stitched canonical brain_id
    sos = silver("silver_order_state")        # canonical order state (purchase link via brain_id)

    staged = spark.sql(
        f"""
        WITH events AS (
            SELECT
                brand_id,
                get_json_object(payload, '$.properties.brain_anon_id') AS brain_anon_id,
                event_type,
                occurred_at
            FROM {sce}
            WHERE brand_id IS NOT NULL
              AND get_json_object(payload, '$.properties.brain_anon_id') IS NOT NULL
        ),
        -- the stitched canonical identity per anon (MAX = a stable single value where the graph resolved one)
        identity AS (
            SELECT
                brand_id,
                brain_anon_id,
                MAX(stitched_brain_id) AS stitched_brain_id
            FROM {stp}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
            GROUP BY brand_id, brain_anon_id
        ),
        -- visitor_id = stitched canonical brain_id when present, else the raw anon id
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
                MAX(event_type = 'session.started')                            AS reached_session,
                MAX(event_type IN ('page.viewed', 'product.viewed'))           AS reached_product_view,
                MAX(event_type IN ('cart.viewed', 'cart.item_added'))          AS reached_cart,
                MAX(event_type = 'checkout.started')                           AS reached_checkout,
                MAX(occurred_at)                                               AS last_pixel_at
            FROM resolved
            WHERE visitor_id IS NOT NULL
            GROUP BY brand_id, visitor_id
        ),
        -- purchase link: order.brain_id resolves to the (stitched) visitor_id. An un-stitched anon visitor
        -- can never equal an order brain_id, so it stays purchase=false (the spec's else-branch).
        orders AS (
            SELECT
                brand_id,
                brain_id            AS visitor_id,
                MAX(state_effective_at) AS last_order_at
            FROM {sos}
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
            current_timestamp()                                                AS updated_at
        FROM per_visitor v
        LEFT JOIN orders o
          ON v.brand_id = o.brand_id AND v.visitor_id = o.visitor_id
        WHERE v.brand_id IS NOT NULL AND v.visitor_id IS NOT NULL
        """
    )

    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")
    merge_on_pk(spark, fqtn, staged, ["brand_id", "visitor_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-funnel-user", build, entity_incremental={
        "table_name": "gold_funnel_user",
        "source_tables": ["silver_collector_event", "silver_touchpoint", "silver_order_state"],
    })
