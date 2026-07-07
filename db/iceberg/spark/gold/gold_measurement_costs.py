"""
gold_measurement_costs.py — SPEC:C.2.4 per-order COSTS fact (Brain V4 Wave C).

Every per-order cost the measurement engine needs for CM2: COGS, forward shipping, REVERSE-logistics
shipping (RTO), and packaging — at the (brand_id, order_id, event_id) grain, money = bigint minor units +
currency, source_system/source_event_id lineage. Append-only fact + derived current-state Trino view
(mv_gold_measurement_costs).

COST COMPONENTS (one row per (order, cost_type); per-currency, integer minor, no float):
  cost_type='cogs'            — Σ over the order's silver_order_line of (quantity × per-unit gold_product_costs
                                for the SKU, valid at the order date). source_system='catalog'.
  cost_type='shipping_forward'— the brand-configured global shipping cost (billing.cost_input scope='global',
                                cost_type='shipping', fixed amount_minor). source_system='cost_config'.
  cost_type='shipping_reverse'— SPEC:C.2.4 REVERSE LOGISTICS: an RTO (return-to-origin) incurs a SECOND
                                shipping leg (the parcel travels back). It is a REAL cost, captured here as a
                                distinct row emitted ONLY for orders whose forward shipment reached
                                terminal_class='rto'. Amount = the same brand shipping config (the return leg
                                is billed at ~the forward rate). source_system='cost_config'. This is the CM2
                                cost side of an RTO; the value REVERSED to the customer is the refunds fact,
                                and the revenue reversal is the ledger — three separate, non-double-counted
                                ledgers.
  cost_type='packaging'       — the brand-configured global packaging cost (scope='global',
                                cost_type='packaging'). source_system='cost_config'.

CURRENCY DISCIPLINE: a configured cost is applied to an order ONLY when its currency matches the order's
currency (per-currency, never a fabricated FX conversion). A cost with no matching config / no product cost
is simply NOT emitted (honest absence — never a fabricated 0-money row). event_id = deterministic
sha2(brand_id, order_id, cost_type) so a re-run is byte-idempotent.

DATA NOTE: billing.cost_input + gold_product_costs are EMPTY live → this writes a correct EMPTY fact today;
it populates the moment a brand configures costs. The RTO reverse-logistics row appears for the golden RTO
orders as soon as a shipping cost is configured (covered by the C.2.4 unit test with a seeded cost).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _gold_base import CATALOG, GOLD_NAMESPACE, ensure_gold_table, run_job, silver, silver_exists  # noqa: E402

TABLE = "gold_measurement_costs"

PG_JDBC_URL = os.environ.get("GOLD_PG_JDBC_URL", os.environ.get("SILVER_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain"))
PG_USER = os.environ.get("GOLD_PG_USER", os.environ.get("SILVER_PG_USER", "brain"))
PG_PASSWORD = os.environ.get("GOLD_PG_PASSWORD", os.environ.get("SILVER_PG_PASSWORD", "brain"))

COLUMNS_SQL = """
          brand_id         string    NOT NULL,
          order_id         string    NOT NULL,
          event_id         string    NOT NULL,
          cost_type        string    NOT NULL,
          amount_minor     bigint    NOT NULL,
          currency_code    string,
          cost_confidence  string,
          source_system    string,
          source_event_id  string,
          occurred_at      timestamp NOT NULL,
          updated_at       timestamp NOT NULL
""".strip("\n")


def _read_global_costs(spark):
    """Brand-configured GLOBAL shipping/packaging costs (fixed amount_minor) from PG billing.cost_input."""
    query = (
        "(SELECT brand_id::text AS brand_id, cost_type, amount_minor, currency_code, cost_confidence "
        "FROM billing.cost_input "
        "WHERE scope = 'global' AND cost_type IN ('shipping','packaging') AND amount_minor IS NOT NULL) g"
    )
    try:
        return (
            spark.read.format("jdbc").option("url", PG_JDBC_URL).option("user", PG_USER)
            .option("password", PG_PASSWORD).option("driver", "org.postgresql.Driver")
            .option("dbtable", query).load()
        )
    except Exception as exc:  # noqa: BLE001 — PG unreachable → no config → empty (honest)
        print(f"[gold_measurement_costs] cost_input unavailable ({exc}); no global costs", flush=True)
        return spark.createDataFrame([], "brand_id string, cost_type string, amount_minor bigint, currency_code string, cost_confidence string")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), days(occurred_at)")

    if not silver_exists(spark, "silver_collector_event"):
        return fqtn, spark.table(fqtn).count()

    # ── orders: dedup latest per (brand, order) + is_rto flag (from the forward shipment lane) ──────────
    spark.sql(
        f"""
        WITH ord AS (
            SELECT brand_id,
                   get_json_object(payload, '$.properties.order_id')      AS order_id,
                   get_json_object(payload, '$.properties.currency_code')  AS currency_code,
                   occurred_at,
                   row_number() OVER (partition by brand_id, get_json_object(payload, '$.properties.order_id')
                                      order by occurred_at desc, event_id desc) AS _rn
            FROM {silver('silver_collector_event')}
            WHERE event_type IN ('order.live.v1','order.backfill.v1')
              AND get_json_object(payload, '$.properties.order_id') IS NOT NULL
        ),
        rto AS (
            SELECT DISTINCT brand_id, get_json_object(payload, '$.properties.order_id') AS order_id
            FROM {silver('silver_collector_event')}
            WHERE event_type = 'shiprocket.shipment_status.v1'
              AND get_json_object(payload, '$.properties.terminal_class') = 'rto'
        )
        SELECT o.brand_id, o.order_id, o.currency_code, o.occurred_at,
               (r.order_id IS NOT NULL) AS is_rto
        FROM ord o LEFT JOIN rto r ON r.brand_id = o.brand_id AND r.order_id = o.order_id
        WHERE o._rn = 1
        """
    ).createOrReplaceTempView("_cost_orders")

    _read_global_costs(spark).createOrReplaceTempView("_cost_global")

    # ── COGS per order from order lines × gold_product_costs (valid at order date) ─────────────────────
    product_costs_fqtn = f"{CATALOG}.{GOLD_NAMESPACE}.gold_product_costs"
    has_product_costs = silver_exists(spark, "silver_order_line")
    try:
        spark.table(product_costs_fqtn).schema
        pc_exists = True
    except Exception:  # noqa: BLE001
        pc_exists = False

    if has_product_costs and pc_exists:
        spark.sql(
            f"""
            SELECT
                ol.brand_id, ol.order_id,
                cast(sum(cast(coalesce(ol.quantity, 0) AS bigint) * cast(coalesce(pc.cost_minor, 0) AS bigint)) AS bigint) AS cogs_minor,
                max(pc.cost_confidence) AS cost_confidence
            FROM {silver('silver_order_line')} ol
            JOIN _cost_orders o ON o.brand_id = ol.brand_id AND o.order_id = ol.order_id
            JOIN {product_costs_fqtn} pc
              ON pc.brand_id = ol.brand_id AND pc.sku = ol.sku
             AND pc.currency_code = o.currency_code
             AND cast(o.occurred_at AS date) >= pc.valid_from
             AND (pc.valid_to IS NULL OR cast(o.occurred_at AS date) < pc.valid_to)
            WHERE ol.sku IS NOT NULL
            GROUP BY ol.brand_id, ol.order_id
            HAVING sum(cast(coalesce(pc.cost_minor,0) AS bigint)) > 0
            """
        ).createOrReplaceTempView("_cost_cogs")
    else:
        spark.createDataFrame([], "brand_id string, order_id string, cogs_minor bigint, cost_confidence string").createOrReplaceTempView("_cost_cogs")

    # ── assemble the 4 cost lanes → one append-only fact (only determinable rows; honest absence) ──────
    staged = spark.sql(
        """
        WITH cogs AS (
            SELECT o.brand_id, o.order_id, 'cogs' AS cost_type, c.cogs_minor AS amount_minor,
                   o.currency_code, coalesce(c.cost_confidence, 'Estimated') AS cost_confidence,
                   'catalog' AS source_system, o.occurred_at
            FROM _cost_orders o JOIN _cost_cogs c ON c.brand_id = o.brand_id AND c.order_id = o.order_id
        ),
        shipping_fwd AS (
            SELECT o.brand_id, o.order_id, 'shipping_forward' AS cost_type, g.amount_minor,
                   o.currency_code, g.cost_confidence, 'cost_config' AS source_system, o.occurred_at
            FROM _cost_orders o JOIN _cost_global g
              ON g.brand_id = o.brand_id AND g.cost_type = 'shipping' AND g.currency_code = o.currency_code
        ),
        shipping_rev AS (
            SELECT o.brand_id, o.order_id, 'shipping_reverse' AS cost_type, g.amount_minor,
                   o.currency_code, g.cost_confidence, 'cost_config' AS source_system, o.occurred_at
            FROM _cost_orders o JOIN _cost_global g
              ON g.brand_id = o.brand_id AND g.cost_type = 'shipping' AND g.currency_code = o.currency_code
            WHERE o.is_rto = true
        ),
        packaging AS (
            SELECT o.brand_id, o.order_id, 'packaging' AS cost_type, g.amount_minor,
                   o.currency_code, g.cost_confidence, 'cost_config' AS source_system, o.occurred_at
            FROM _cost_orders o JOIN _cost_global g
              ON g.brand_id = o.brand_id AND g.cost_type = 'packaging' AND g.currency_code = o.currency_code
        ),
        unioned AS (
            SELECT * FROM cogs UNION ALL SELECT * FROM shipping_fwd
            UNION ALL SELECT * FROM shipping_rev UNION ALL SELECT * FROM packaging
        )
        SELECT
            brand_id, order_id,
            sha2(concat_ws('\\0', brand_id, order_id, cost_type), 256) AS event_id,
            cost_type,
            cast(coalesce(amount_minor, 0) AS bigint) AS amount_minor,
            currency_code, cost_confidence, source_system,
            sha2(concat_ws('\\0', brand_id, order_id, cost_type), 256) AS source_event_id,
            occurred_at, current_timestamp() AS updated_at
        FROM unioned
        WHERE amount_minor IS NOT NULL AND amount_minor <> 0
        """
    )
    # WRITE MODE — atomic partition overwrite (NOT merge-upsert). Unlike the event-sourced facts (refunds/
    # settlements/fees, where an event never un-happens → MERGE is correct), costs are CONFIG-DERIVED: a brand
    # can lower or remove a shipping/packaging cost, or a per-SKU COGS can be re-costed. A MERGE would leave
    # the STALE cost row (orphan), so a re-run over changed config would keep the old amount. overwritePartitions
    # atomically REPLACES every (brand-bucket, order-day) partition present in the fresh fold → the fact exactly
    # matches the current config, orphan-free + idempotent. (Edge: a brand that removes ALL cost config emits no
    # partitions, so its rows are not auto-cleared — a full config removal needs an explicit clear; documented.)
    if staged.take(1):
        staged.writeTo(fqtn).overwritePartitions()
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-measurement-costs", build)
