"""
gold_funnel.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_funnel.py.

NET-NEW gap Gold mart (Brain V4 Phase 2, GROUP "NEW gap Gold products"). NO dbt predecessor
(parity status=NEW). The materialized checkout/browse FUNNEL — one row per (brand_id, funnel_date)
holding the distinct-session reach counts for each funnel stage over that UTC day. Reads Iceberg
brain_silver.silver_page_view (browse/product stages) + brain_silver.silver_cart_event (cart stage)
+ brain_silver.silver_checkout_signal (checkout stage) DIRECTLY (exactly like the Spark job reads
them via silver()). This is the Gold materialization of the TS computeStorefrontFunnel signal.

STAGES (distinct-session reach per UTC day — verbatim from the Spark job):
  sessions         — distinct sessions that emitted ANY page view   (silver_page_view, funnel top).
  product_viewed   — distinct sessions with a product.viewed page    (silver_page_view page_event='product').
  cart_added       — distinct sessions with a cart item_added         (silver_cart_event cart_action='item_added').
  checkout_started — distinct order_ids reaching a checkout signal    (silver_checkout_signal, all rows).
  purchased        — distinct order_ids whose signal is NOT abandonment (signal_type <> 'checkout_abandoned').

"Session" key: silver_page_view / silver_cart_event carry session_id; silver_checkout_signal has no
session grain, so its stage counts distinct order_id (the closest available checkout identity).

GRAIN / PK : 1 row per (brand_id, funnel_date). funnel_date = occurred_at::date (UTC). NO money (a
             funnel is session counting). brand_id first column + partition anchor.
ISOLATION  : brand_id first; the cross-brand Gold ETL writer (per-brand enforced at the read seam).
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on (brand_id, funnel_date). Idempotent.

CAVEAT — orphan-shedding: the Spark job passes delete_orphans=True (WHEN NOT MATCHED BY SOURCE DELETE)
so a full per-brand recompute sheds a disappeared group's Gold row. The DuckDB _base.merge_on_pk does
NOT implement a not-matched-by-source DELETE — this port is a MATCHED-UPDATE / NOT-MATCHED-INSERT MERGE
only. For the parallel-run parity harness (fresh <table>_duckdb_test built from the same Silver) the
admission set is identical; the divergence only exists after an upstream group disappears from Silver
between runs. Noted, not silently dropped.

QUARANTINE : the Spark job has NO Stage-1/quarantine side-write here (reads already-gated Silver).
             This framework has none either — nothing to skip.

Honors MIGRATION_TABLE_SUFFIX (→ gold_funnel_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_funnel.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_funnel_duckdb_test beside the Spark-produced
# live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_funnel"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_PAGE_VIEW = f"{CATALOG}.{SILVER_NAMESPACE}.silver_page_view"
SILVER_CART = f"{CATALOG}.{SILVER_NAMESPACE}.silver_cart_event"
SILVER_CHECKOUT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_checkout_signal"

# Mirrors the Spark COLUMNS_SQL order/types exactly. No money (session counting). funnel_date is a DATE.
COLUMNS_SQL = """
  brand_id          string    NOT NULL,
  funnel_date       date      NOT NULL,
  sessions          bigint    NOT NULL,
  product_viewed    bigint    NOT NULL,
  cart_added        bigint    NOT NULL,
  checkout_started  bigint    NOT NULL,
  purchased         bigint    NOT NULL,
  updated_at        timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "funnel_date", "sessions", "product_viewed",
    "cart_added", "checkout_started", "purchased", "updated_at",
]

PK = ["brand_id", "funnel_date"]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # Faithful SQL port of the Spark staged CTE. pv_agg (top-of-funnel session/product-view counts) plus
    # cart (cart_added) plus chk (checkout_started + purchased) are keyed by (brand_id, funnel_date) and
    # LEFT JOINed onto the key union so a day present in only one source still emits a row. Distinct
    # counts are stage-local identities — monotonicity is a property of the data, never forced.
    staged = f"""
        WITH pv AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS funnel_date,
                   session_id,
                   page_event
            FROM {SILVER_PAGE_VIEW}
            WHERE session_id IS NOT NULL
        ),
        pv_agg AS (
            SELECT brand_id, funnel_date,
                   COUNT(DISTINCT session_id) AS sessions,
                   COUNT(DISTINCT CASE WHEN page_event = 'product' THEN session_id END) AS product_viewed
            FROM pv
            GROUP BY brand_id, funnel_date
        ),
        cart AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS funnel_date,
                   COUNT(DISTINCT CASE WHEN cart_action = 'item_added' THEN session_id END) AS cart_added
            FROM {SILVER_CART}
            WHERE session_id IS NOT NULL
            GROUP BY brand_id, CAST(occurred_at AS DATE)
        ),
        chk AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS funnel_date,
                   COUNT(DISTINCT order_id) AS checkout_started,
                   -- A checkout signal that is NOT an abandonment is a (potential) purchase reach.
                   COUNT(DISTINCT CASE WHEN signal_type <> 'checkout_abandoned' THEN order_id END) AS purchased
            FROM {SILVER_CHECKOUT}
            WHERE order_id IS NOT NULL AND occurred_at IS NOT NULL
            GROUP BY brand_id, CAST(occurred_at AS DATE)
        ),
        keys AS (
            SELECT brand_id, funnel_date FROM pv_agg
            UNION SELECT brand_id, funnel_date FROM cart
            UNION SELECT brand_id, funnel_date FROM chk
        )
        SELECT
            k.brand_id,
            k.funnel_date,
            COALESCE(pv_agg.sessions, 0)        AS sessions,
            COALESCE(pv_agg.product_viewed, 0)  AS product_viewed,
            COALESCE(cart.cart_added, 0)        AS cart_added,
            COALESCE(chk.checkout_started, 0)   AS checkout_started,
            COALESCE(chk.purchased, 0)          AS purchased,
            now()                               AS updated_at
        FROM keys k
        LEFT JOIN pv_agg USING (brand_id, funnel_date)
        LEFT JOIN cart   USING (brand_id, funnel_date)
        LEFT JOIN chk    USING (brand_id, funnel_date)
        WHERE k.brand_id IS NOT NULL AND k.funnel_date IS NOT NULL
    """

    # The rollup is already 1 row per PK (GROUP BY / UNION upstream), so merge_on_pk's in-batch dedup is a
    # no-op; order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    run_job("gold-funnel", build, target_table=TABLE)
