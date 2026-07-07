"""
gold_measurement_refunds.py — SPEC:C.2.1 canonical append-only REFUNDS/RETURNS fact (Brain V4 Wave C).

The measurement engine's single source of refund + return value-reversal, at the (brand_id, order_id,
event_id) grain, money = bigint minor units + currency, with source_system/source_event_id lineage. It is
an APPEND-ONLY fact (one row per refund/return event) with a derived current-state Trino view
(mv_gold_measurement_refunds) — mirroring gold_revenue_ledger's event-sourced pattern.

AMD-16 R1 (BINDING): this is NOT a fork of the settlement/spend facts. It is the GOLD projection of the
extended live `silver_refund` (the single refund fact) UNIONed with the RTO (return-to-origin) lane, which
`silver_refund` cannot see (RTO is a logistics signal, not a refund.recorded.v1). No live refund reader is
repointed; additive + flag-neutral (no flag needed — it is a pure additive fact, empty until refunds/RTO
exist for a brand).

TWO SOURCES → ONE FACT (per-currency, integer minor units, never blended, no float):
  A. EXPLICIT REFUNDS — brain_silver.silver_refund (the extended taxonomy/lineage fact). reason_code is the
     note-derived taxonomy ('rto' first-class | 'return' | 'damaged' | 'cancellation' | 'customer_request'
     | 'other'); amount_minor is the settled refund total; refund_method honest-null when the connector
     omits it.
  B. RTO RETURNS — shiprocket.shipment_status.v1 with terminal_class='rto' (the return-to-origin terminal
     state). This is a FIRST-CLASS reason_code='rto' row: the order's value is reversed to the customer's
     account of record. amount_minor = the order's amount_minor (the reversed value); refund_method =
     'cod_not_collected' for COD (no cash ever changed hands, the value is un-recognized) else
     'original_payment'. To avoid double-reversal in downstream CM, an RTO row is emitted ONLY for orders
     that do NOT already carry an explicit refund (anti-join on order_id) — the explicit refund wins.

RTO REVERSE-LOGISTICS NOTE: the *return shipping cost* of an RTO is a real COST and is captured in
gold_measurement_costs (cost_type='shipping_reverse'), NOT here — this fact is the value REVERSED to the
customer, cost is a separate ledger. The ledger's cod_rto_clawback / refund events remain the revenue
reversal; this fact is the measurement-domain refund catalog that CM3 reads.

KEY/IDEMPOTENCY: merged on (brand_id, order_id, event_id) — order_id coalesced to '' so the merge key is
never NULL (idempotent re-run). event_id is the deterministic Bronze/transition id. Partition
bucket(64, brand_id), days(occurred_at). brand_id first column + partition anchor.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver, silver_exists

TABLE = "gold_measurement_refunds"

COLUMNS_SQL = """
          brand_id         string    NOT NULL,
          order_id         string    NOT NULL,
          event_id         string    NOT NULL,
          order_line_id    string,
          amount_minor     bigint    NOT NULL,
          currency_code    string,
          reason_code      string,
          refund_method    string,
          initiated_at     timestamp,
          settled_at       timestamp,
          source_system    string,
          source_event_id  string,
          occurred_at      timestamp NOT NULL,
          ingested_at      timestamp,
          updated_at       timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), days(occurred_at)")

    # ── A. explicit refunds from the extended silver_refund fact ──────────────────────────────────────
    if silver_exists(spark, "silver_refund"):
        explicit = spark.sql(
            f"""
            SELECT
                brand_id,
                coalesce(order_id, '')                          AS order_id,
                event_id,
                order_line_id,
                cast(coalesce(amount_minor, 0) AS bigint)       AS amount_minor,
                currency_code,
                coalesce(reason_code, 'other')                  AS reason_code,
                refund_method,
                initiated_at,
                settled_at,
                coalesce(source_system, source, 'unknown')      AS source_system,
                coalesce(source_event_id, event_id)             AS source_event_id,
                occurred_at,
                ingested_at
            FROM {silver('silver_refund')}
            WHERE brand_id IS NOT NULL AND event_id IS NOT NULL
              AND coalesce(order_unresolved, false) = false
            """
        )
    else:
        explicit = spark.createDataFrame([], _empty_schema())
    explicit.createOrReplaceTempView("_refunds_explicit")

    # ── B. RTO returns from the forward shipment lane (terminal_class='rto'), joined to the order for the
    #      reversed value + payment method. Read the SAME collector_event source the ledger folds from. ──
    if silver_exists(spark, "silver_collector_event"):
        spark.sql(
            f"""
            WITH rto AS (
                SELECT
                    brand_id,
                    event_id,
                    get_json_object(payload, '$.properties.order_id')       AS order_id,
                    lower(get_json_object(payload, '$.properties.payment_method')) AS payment_method,
                    occurred_at,
                    ingested_at,
                    row_number() OVER (
                        partition by brand_id, get_json_object(payload, '$.properties.order_id')
                        order by occurred_at desc, event_id desc
                    ) AS _rn
                FROM {silver('silver_collector_event')}
                WHERE event_type = 'shiprocket.shipment_status.v1'
                  AND get_json_object(payload, '$.properties.terminal_class') = 'rto'
                  AND get_json_object(payload, '$.properties.order_id') IS NOT NULL
            ),
            orders AS (
                SELECT
                    brand_id,
                    get_json_object(payload, '$.properties.order_id')                     AS order_id,
                    cast(get_json_object(payload, '$.properties.amount_minor') AS bigint)  AS amount_minor,
                    get_json_object(payload, '$.properties.currency_code')                AS currency_code,
                    lower(get_json_object(payload, '$.properties.payment_method'))         AS payment_method,
                    row_number() OVER (
                        partition by brand_id, get_json_object(payload, '$.properties.order_id')
                        order by occurred_at desc, event_id desc
                    ) AS _orn
                FROM {silver('silver_collector_event')}
                WHERE event_type IN ('order.live.v1', 'order.backfill.v1')
                  AND get_json_object(payload, '$.properties.order_id') IS NOT NULL
            )
            SELECT
                r.brand_id,
                r.order_id                                          AS order_id,
                r.event_id                                          AS event_id,
                cast(NULL AS string)                                AS order_line_id,
                cast(coalesce(o.amount_minor, 0) AS bigint)         AS amount_minor,
                o.currency_code                                     AS currency_code,
                'rto'                                               AS reason_code,
                CASE WHEN coalesce(r.payment_method, o.payment_method) = 'cod'
                     THEN 'cod_not_collected' ELSE 'original_payment' END AS refund_method,
                r.occurred_at                                       AS initiated_at,
                r.occurred_at                                       AS settled_at,
                'shiprocket'                                        AS source_system,
                r.event_id                                          AS source_event_id,
                r.occurred_at                                       AS occurred_at,
                r.ingested_at                                       AS ingested_at
            FROM rto r
            LEFT JOIN orders o ON o.brand_id = r.brand_id AND o.order_id = r.order_id AND o._orn = 1
            -- anti-join: skip RTO orders that already carry an explicit refund (no double-reversal).
            LEFT ANTI JOIN _refunds_explicit e ON e.brand_id = r.brand_id AND e.order_id = r.order_id
            WHERE r._rn = 1
            """
        ).createOrReplaceTempView("_refunds_rto")
    else:
        spark.createDataFrame([], _empty_schema()).createOrReplaceTempView("_refunds_rto")

    staged = spark.sql(
        """
        SELECT *, current_timestamp() AS updated_at FROM (
            SELECT * FROM _refunds_explicit
            UNION ALL
            SELECT * FROM _refunds_rto
        )
        """
    )
    merge_on_pk(spark, fqtn, staged, ["brand_id", "order_id", "event_id"])
    return fqtn, spark.table(fqtn).count()


def _empty_schema() -> str:
    return (
        "brand_id string, order_id string, event_id string, order_line_id string, amount_minor bigint, "
        "currency_code string, reason_code string, refund_method string, initiated_at timestamp, "
        "settled_at timestamp, source_system string, source_event_id string, occurred_at timestamp, "
        "ingested_at timestamp"
    )


if __name__ == "__main__":
    run_job("gold-measurement-refunds", build, entity_incremental={
        # Both sources make a brand "affected": silver_refund (explicit refunds) AND silver_collector_event
        # (the RTO logistics + order lanes). A brand with only a NEW RTO shipment still recomputes.
        "table_name": TABLE, "source_tables": ["silver_refund", "silver_collector_event"],
    })
