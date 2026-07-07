# SPEC: C.3
"""
gold_order_economics.py — NEW Wave-C per-order contribution-margin mart (AMD-17).

One row per (brand_id, order_id), recomputed IDEMPOTENTLY as facts arrive (MERGE on the PK). This is
the fact-based economics engine the delta-plan calls for: CM1/CM2/CM3 from MEASURED facts, spec
numbering (industry convention), the live gold_contribution_margin left UNTOUCHED (AMD-17;
knowledge-base/measurement/cm-mapping.md).

  CM1 = net_revenue − COGS
  CM2 = CM1 − shipping(forward + reverse) − packaging − payment/platform fees
  CM3 = CM2 − allocated marketing spend   (cm3_allocation_basis recorded per row)

MONEY (§1.2): every column is signed BIGINT minor units + the sibling currency_code — per-currency,
NEVER blended, NEVER a float (all math is bigint add/sub/floor-div, so GCC 3-decimal fils reconcile
with ZERO rounding loss). brand_id is the tenant key, FIRST column + partition anchor.

READS (recognized/reversal basis + WC-C2 facts, degrading gracefully where a fact is not yet built):
  - gold_revenue_ledger        — the recognition ledger (money SoR). net_revenue = Σ amount_minor over
                                 an order's NON-provisional events; the event_types set → economics_state
                                 (AMD-15: provisional | settled | reversed). RTO/refund/cancel flip
                                 revenue negative here → CM3 negative.
  - silver_order_state         — order currency + first_event_at (is_new_customer window, C.5.5).
  - silver_marketing_spend     — day×(brand,currency) spend, day-pro-rata allocated to CM3 (exact-sum
                                 largest-remainder; cm3_allocation_basis='day_channel_prorata').
  - gold_product_costs         — COGS per sku (WC-C2 C.2.4). ABSENT today → cogs degraded to 0.
  - gold_measurement_costs     — shipping (fwd+reverse) + packaging (WC-C2 C.2.4). ABSENT → 0.
  - gold_measurement_fees      — per-order payment/platform fees (WC-C2 C.2.3). ABSENT → 0.
Each degraded component is recorded (economics_components_source) so a null is never mistaken for a
measured zero.

economics_state (AMD-15) maps onto the live two-stage recognition: provisional at booking → settled
(finalized / COD-delivered) → reversed (RTO / cancellation / refund). A COD order pre-delivery is
provisional; an RTO flips revenue (reversal, from the ledger) AND — once gold_measurement_costs is
built — adds reverse-logistics cost, so economics recompute.

is_new_customer (C.5.5): True iff this is the customer's FIRST recognized order (window over
silver_order_state per brain_id, ordered by first_event_at). Unresolved brain_id (anonymous) → NULL
(honest unknown — never a silent False that would inflate 'new' counts).

REPLAY-SAFE: full recompute from the ledger + facts, MERGE-UPDATE'd on (brand_id, order_id). Run via
run-gold-order-economics.sh, AFTER gold_revenue_ledger + silver_order_state.
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _gold_base import (  # noqa: E402
    CATALOG,
    GOLD_NAMESPACE,
    SILVER_NS,
    ensure_gold_table,
    merge_on_pk,
    run_job,
    silver,
)
from pyspark.sql import SparkSession  # noqa: E402

TABLE = "gold_order_economics"

# WC-C2 fact tables this mart reads WHEN BUILT (AMD-16 measurement namespace). Absent → degrade to 0.
GOLD_NS = GOLD_NAMESPACE
_COSTS_FACT = "gold_measurement_costs"     # shipping (fwd+reverse) + packaging, per order
_FEES_FACT = "gold_measurement_fees"       # payment/platform fees, per order
_PRODUCT_COSTS = "gold_product_costs"      # COGS per sku (× order lines)

COLUMNS_SQL = """
          brand_id                   string    NOT NULL,
          order_id                   string    NOT NULL,
          brain_id                   string,
          currency_code              string    NOT NULL,
          economics_state            string    NOT NULL,
          is_new_customer            boolean,
          net_revenue_minor          bigint    NOT NULL,
          cogs_minor                 bigint    NOT NULL,
          shipping_fwd_minor         bigint    NOT NULL,
          shipping_rev_minor         bigint    NOT NULL,
          packaging_minor            bigint    NOT NULL,
          fees_minor                 bigint    NOT NULL,
          cm1_minor                  bigint    NOT NULL,
          cm2_minor                  bigint    NOT NULL,
          marketing_minor            bigint    NOT NULL,
          cm3_minor                  bigint    NOT NULL,
          cm3_allocation_basis       string    NOT NULL,
          components_source          string    NOT NULL,
          order_recognized_at        timestamp,
          source_system              string    NOT NULL,
          source_event_id            string,
          job_version                string    NOT NULL,
          updated_at                 timestamp NOT NULL
""".strip("\n")

# job_version bumps when the economics math changes (lineage endpoint C.5.1 surfaces it).
JOB_VERSION = "c3.economics.v1"


def _gold_exists(spark: SparkSession, table: str) -> bool:
    """True iff a sibling Gold fact table exists (WC-C2 output). Absent → the component degrades to 0."""
    try:
        spark.table(f"{CATALOG}.{GOLD_NS}.{table}").schema
        return True
    except Exception:  # noqa: BLE001 — absent WC-C2 fact → graceful degradation
        return False


def build(spark: SparkSession):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ── Money SoR: the recognition ledger. net revenue = Σ non-provisional; event_types → state ──
    # brain_id + currency + occurred basis carried from the ledger. One group per (brand, order).
    spark.sql(
        f"""
        SELECT
            brand_id,
            order_id,
            max(brain_id)        AS brain_id,
            max(currency_code)   AS currency_code,
            -- provisional booking EXCLUDED (== silver_order_state.order_value_minor semantics).
            cast(sum(CASE WHEN event_type <> 'provisional_recognition'
                          THEN amount_minor ELSE 0 END) AS bigint) AS net_revenue_minor,
            -- economics_state (AMD-15): reversed > settled > provisional.
            CASE
              WHEN max(CASE WHEN event_type IN
                    ('cod_rto_clawback','cancellation','refund','chargeback','rto_reversal')
                    THEN 1 ELSE 0 END) = 1 THEN 'reversed'
              WHEN max(CASE WHEN event_type IN ('finalization','cod_delivery_confirmed')
                    THEN 1 ELSE 0 END) = 1 THEN 'settled'
              ELSE 'provisional'
            END AS economics_state,
            min(economic_effective_at) AS order_recognized_at,
            -- lineage: the earliest recognition event that seeded this order's economics.
            min(ledger_event_id)       AS source_event_id
        FROM {CATALOG}.{GOLD_NS}.gold_revenue_ledger
        WHERE order_id IS NOT NULL
        GROUP BY brand_id, order_id
        """
    ).createOrReplaceTempView("_econ_ledger")

    # ── is_new_customer (C.5.5): first recognized order per brain_id (window over order_state) ──
    # NULL brain_id → NULL is_new_customer (honest unknown). Ordered by first_event_at; ties broken by
    # order_id for determinism. Only recognized (order_value_minor set) orders anchor "new".
    spark.sql(
        f"""
        WITH ranked AS (
            SELECT brand_id, order_id, brain_id, first_event_at,
                   CASE WHEN brain_id IS NULL THEN NULL ELSE
                     row_number() OVER (
                       PARTITION BY brand_id, brain_id
                       ORDER BY first_event_at ASC, order_id ASC
                     ) END AS _rank
            FROM {silver('silver_order_state')}
            WHERE brand_id IS NOT NULL
        )
        SELECT brand_id, order_id,
               CASE WHEN _rank IS NULL THEN NULL WHEN _rank = 1 THEN true ELSE false END AS is_new_customer
        FROM ranked
        """
    ).createOrReplaceTempView("_econ_newcust")

    # ── COGS (WC-C2 C.2.4): gold_product_costs × silver_order_line quantities. Degrade → 0. ──
    have_cogs = _gold_exists(spark, _PRODUCT_COSTS)
    if have_cogs:
        spark.sql(
            f"""
            SELECT ol.brand_id, ol.order_id,
                   cast(coalesce(sum(coalesce(pc.cost_minor, 0) * coalesce(ol.quantity, 0)), 0) AS bigint)
                     AS cogs_minor
            FROM {silver('silver_order_line')} ol
            LEFT JOIN {CATALOG}.{GOLD_NS}.{_PRODUCT_COSTS} pc
              ON pc.brand_id = ol.brand_id AND pc.sku = ol.sku AND pc.currency_code = ol.currency_code
            GROUP BY ol.brand_id, ol.order_id
            """
        ).createOrReplaceTempView("_econ_cogs")
    else:
        spark.sql("SELECT '' AS brand_id, '' AS order_id, cast(0 AS bigint) AS cogs_minor WHERE 1=0") \
            .createOrReplaceTempView("_econ_cogs")

    # ── shipping (fwd+reverse) + packaging (WC-C2 C.2.4). Degrade → 0. ──
    have_costs = _gold_exists(spark, _COSTS_FACT)
    if have_costs:
        spark.sql(
            f"""
            SELECT brand_id, order_id,
                   cast(coalesce(sum(CASE WHEN cost_type = 'shipping_forward' THEN amount_minor ELSE 0 END), 0) AS bigint) AS shipping_fwd_minor,
                   cast(coalesce(sum(CASE WHEN cost_type = 'shipping_reverse' THEN amount_minor ELSE 0 END), 0) AS bigint) AS shipping_rev_minor,
                   cast(coalesce(sum(CASE WHEN cost_type = 'packaging'        THEN amount_minor ELSE 0 END), 0) AS bigint) AS packaging_minor
            FROM {CATALOG}.{GOLD_NS}.{_COSTS_FACT}
            GROUP BY brand_id, order_id
            """
        ).createOrReplaceTempView("_econ_costs")
    else:
        spark.sql(
            "SELECT '' AS brand_id, '' AS order_id, cast(0 AS bigint) AS shipping_fwd_minor, "
            "cast(0 AS bigint) AS shipping_rev_minor, cast(0 AS bigint) AS packaging_minor WHERE 1=0"
        ).createOrReplaceTempView("_econ_costs")

    # ── per-order payment/platform fees (WC-C2 C.2.3). Degrade → 0. ──
    have_fees = _gold_exists(spark, _FEES_FACT)
    if have_fees:
        spark.sql(
            f"""
            SELECT brand_id, order_id,
                   cast(coalesce(sum(coalesce(fee_minor, 0)), 0) AS bigint) AS fees_minor
            FROM {CATALOG}.{GOLD_NS}.{_FEES_FACT}
            GROUP BY brand_id, order_id
            """
        ).createOrReplaceTempView("_econ_fees")
    else:
        spark.sql("SELECT '' AS brand_id, '' AS order_id, cast(0 AS bigint) AS fees_minor WHERE 1=0") \
            .createOrReplaceTempView("_econ_fees")

    # provenance flag: which components were MEASURED vs degraded-to-0 (a null is never a measured 0).
    components_source = "|".join([
        f"cogs={'measured' if have_cogs else 'degraded0'}",
        f"costs={'measured' if have_costs else 'degraded0'}",
        f"fees={'measured' if have_fees else 'degraded0'}",
    ])

    # ── marketing day-pro-rata allocation (CM3 basis). Deterministic exact-sum largest-remainder. ──
    # For each (brand, currency, day) with recognized orders: split that day's silver_marketing_spend
    # equally across the orders; the first `remainder` orders (order_id asc) get +1 minor so Σ == spend
    # EXACTLY. currency-matched (M1): a KWD order only draws KWD spend. No spend for the day → 0, basis
    # 'none'. deterministic_attributed is a future basis (per-order attributed spend) — day pro-rata is
    # the honest degrade until that source is wired.
    spark.sql(
        f"""
        SELECT brand_id, currency_code, cast(stat_date AS date) AS spend_date,
               cast(sum(coalesce(spend_minor, 0)) AS bigint) AS day_spend_minor
        FROM {silver('silver_marketing_spend')}
        WHERE brand_id IS NOT NULL AND spend_minor IS NOT NULL
        GROUP BY brand_id, currency_code, cast(stat_date AS date)
        """
    ).createOrReplaceTempView("_econ_spend_day")

    spark.sql(
        """
        WITH orders_day AS (
            SELECT l.brand_id, l.order_id, l.currency_code,
                   cast(l.order_recognized_at AS date) AS spend_date
            FROM _econ_ledger l
        ),
        joined AS (
            SELECT od.brand_id, od.order_id, od.currency_code,
                   coalesce(sd.day_spend_minor, 0) AS day_spend_minor,
                   row_number() OVER (
                     PARTITION BY od.brand_id, od.currency_code, od.spend_date
                     ORDER BY od.order_id ASC
                   ) AS _rn,
                   count(*) OVER (
                     PARTITION BY od.brand_id, od.currency_code, od.spend_date
                   ) AS _n_orders
            FROM orders_day od
            LEFT JOIN _econ_spend_day sd
              ON sd.brand_id = od.brand_id AND sd.currency_code = od.currency_code
             AND sd.spend_date = od.spend_date
        )
        SELECT brand_id, order_id,
               cast(
                 (day_spend_minor div _n_orders)
                 + CASE WHEN _rn <= (day_spend_minor - (day_spend_minor div _n_orders) * _n_orders)
                        THEN 1 ELSE 0 END
               AS bigint) AS marketing_minor,
               CASE WHEN day_spend_minor > 0 THEN 'day_channel_prorata' ELSE 'none' END AS cm3_allocation_basis
        FROM joined
        """
    ).createOrReplaceTempView("_econ_marketing")

    # ── assemble the economics waterfall (integer minor units, spec numbering AMD-17) ──
    staged = spark.sql(
        f"""
        SELECT
            l.brand_id,
            l.order_id,
            l.brain_id,
            l.currency_code,
            l.economics_state,
            nc.is_new_customer,
            l.net_revenue_minor,
            coalesce(cg.cogs_minor, 0)                       AS cogs_minor,
            coalesce(ct.shipping_fwd_minor, 0)               AS shipping_fwd_minor,
            coalesce(ct.shipping_rev_minor, 0)               AS shipping_rev_minor,
            coalesce(ct.packaging_minor, 0)                  AS packaging_minor,
            coalesce(fe.fees_minor, 0)                       AS fees_minor,
            (l.net_revenue_minor - coalesce(cg.cogs_minor, 0)) AS cm1_minor,
            (l.net_revenue_minor - coalesce(cg.cogs_minor, 0)
              - coalesce(ct.shipping_fwd_minor, 0) - coalesce(ct.shipping_rev_minor, 0)
              - coalesce(ct.packaging_minor, 0) - coalesce(fe.fees_minor, 0)) AS cm2_minor,
            coalesce(mk.marketing_minor, 0)                  AS marketing_minor,
            (l.net_revenue_minor - coalesce(cg.cogs_minor, 0)
              - coalesce(ct.shipping_fwd_minor, 0) - coalesce(ct.shipping_rev_minor, 0)
              - coalesce(ct.packaging_minor, 0) - coalesce(fe.fees_minor, 0)
              - coalesce(mk.marketing_minor, 0))             AS cm3_minor,
            coalesce(mk.cm3_allocation_basis, 'none')        AS cm3_allocation_basis,
            '{components_source}'                            AS components_source,
            l.order_recognized_at,
            'gold_revenue_ledger'                            AS source_system,
            l.source_event_id,
            '{JOB_VERSION}'                                  AS job_version,
            current_timestamp()                              AS updated_at
        FROM _econ_ledger l
        LEFT JOIN _econ_newcust nc ON nc.brand_id = l.brand_id AND nc.order_id = l.order_id
        LEFT JOIN _econ_cogs cg     ON cg.brand_id = l.brand_id AND cg.order_id = l.order_id
        LEFT JOIN _econ_costs ct    ON ct.brand_id = l.brand_id AND ct.order_id = l.order_id
        LEFT JOIN _econ_fees fe     ON fe.brand_id = l.brand_id AND fe.order_id = l.order_id
        LEFT JOIN _econ_marketing mk ON mk.brand_id = l.brand_id AND mk.order_id = l.order_id
        WHERE l.currency_code IS NOT NULL
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "order_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    # FULL recompute every run (NOT entity-incremental): the driver is gold_revenue_ledger (a Gold
    # table read as a complete fold, not reachable via the brand-scoping silver() view), and the
    # is_new_customer / marketing-allocation windows are cross-order per (brand, brain_id) / (brand,
    # currency, day) — a brand-bucket filter would starve those windows and null-overwrite unscoped
    # brands. The recompute is order-grain (bounded) and MERGE-on-PK replay-safe (re-run = identical).
    run_job("gold-order-economics", build)
