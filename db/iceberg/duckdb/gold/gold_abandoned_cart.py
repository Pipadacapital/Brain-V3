"""
gold_abandoned_cart.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_abandoned_cart.py.

NET-NEW gap Gold mart (Brain V4 Phase 2, GROUP "NEW gap Gold"). NO dbt predecessor. The materialized
abandoned-cart recovery surface — one row per (brand_id, cart_date, currency_code) holding, for that UTC
day and currency: how many cart sessions there were, how many order_ids hit a checkout-abandonment signal,
how many were recovered (placeholder 0 until a cart→order stitch column lands), and the at-risk abandoned
cart value. Reads Iceberg brain_silver.silver_cart_event (the cart sessions) ⨝ brain_silver.
silver_checkout_signal (the checkout/abandonment signal). Lifts the TS computeAbandonedCart signal to a
daily mart.

DEFINITIONS (verbatim from the Spark job — session grain, per UTC day, per currency):
  cart_sessions          — distinct session_id with ≥1 cart_action='item_added' in the day
                           (silver_cart_event; currency = COALESCE(currency_code, 'INR')).
  abandoned_carts        — distinct order_id that hit a shopflo checkout_abandoned signal in the day
                           (silver_checkout_signal signal_type='checkout_abandoned').
  abandoned_value_minor  — the at-risk cart value: per-currency Σ total_price_minor of those signals
                           (bigint MINOR units + sibling currency_code; NEVER blended across currencies).
  recovered_carts        — placeholder 0 (kept so the shape is stable; fills with no schema change once a
                           cart→order stitch column lands on Silver).

GRAIN : 1 row per (brand_id, cart_date, currency_code). brand_id first + partition anchor.
MONEY : abandoned_value_minor is bigint MINOR units + currency_code (per-currency Σ; never a float).
REPLAY-SAFE: full daily recompute from Silver, MERGE-UPDATE'd on the PK (idempotent re-run).

CAVEAT — orphan-shedding: the Spark job passes delete_orphans=True (WHEN NOT MATCHED BY SOURCE DELETE) so
a full per-brand recompute sheds a disappeared group's Gold row. The DuckDB _base.merge_on_pk does NOT
implement a not-matched-by-source DELETE — this port is a MATCHED-UPDATE / NOT-MATCHED-INSERT MERGE only.
For the parallel-run parity harness (fresh <table>_duckdb_test built from the same Silver) the admission
set is identical; the divergence only exists after an upstream group disappears from Silver between runs.
Noted, not silently dropped.

Honors MIGRATION_TABLE_SUFFIX (→ gold_abandoned_cart_duckdb_test) for the parallel-run parity harness.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_abandoned_cart_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_abandoned_cart"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_CART = f"{CATALOG}.{SILVER_NAMESPACE}.silver_cart_event"
SILVER_CHECKOUT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_checkout_signal"

COLUMNS_SQL = """
  brand_id               string    NOT NULL,
  cart_date              date      NOT NULL,
  currency_code          string    NOT NULL,
  cart_sessions          bigint    NOT NULL,
  abandoned_carts        bigint    NOT NULL,
  recovered_carts        bigint    NOT NULL,
  abandoned_value_minor  bigint    NOT NULL,
  updated_at             timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "cart_date", "currency_code", "cart_sessions", "abandoned_carts",
    "recovered_carts", "abandoned_value_minor", "updated_at",
]

PK = ["brand_id", "cart_date", "currency_code"]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), cart_date")

    # Faithful SQL port of the Spark staged CTE. cart_agg (distinct item_added sessions/day/currency)
    # FULL-keyed against abandoned (distinct abandonment-signal order_ids + per-currency Σ at-risk value),
    # then LEFT JOINs onto the key union so a day with only carts or only abandonments still emits a row.
    staged = f"""
        WITH cart AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS cart_date,
                   COALESCE(currency_code, 'INR') AS currency_code,
                   session_id
            FROM {SILVER_CART}
            WHERE cart_action = 'item_added' AND session_id IS NOT NULL
        ),
        cart_agg AS (
            SELECT brand_id, cart_date, currency_code,
                   COUNT(DISTINCT session_id) AS cart_sessions
            FROM cart
            GROUP BY brand_id, cart_date, currency_code
        ),
        abandoned AS (
            SELECT brand_id,
                   CAST(occurred_at AS DATE) AS cart_date,
                   COALESCE(currency_code, 'INR') AS currency_code,
                   COUNT(DISTINCT order_id) AS abandoned_carts,
                   -- Per-currency Σ of the at-risk abandoned cart value (bigint minor; never blended).
                   COALESCE(SUM(COALESCE(total_price_minor, 0)), 0) AS abandoned_value_minor
            FROM {SILVER_CHECKOUT}
            WHERE signal_type = 'checkout_abandoned' AND occurred_at IS NOT NULL
            GROUP BY brand_id, CAST(occurred_at AS DATE), COALESCE(currency_code, 'INR')
        ),
        keys AS (
            SELECT brand_id, cart_date, currency_code FROM cart_agg
            UNION SELECT brand_id, cart_date, currency_code FROM abandoned
        )
        SELECT
            k.brand_id,
            k.cart_date,
            k.currency_code,
            COALESCE(cart_agg.cart_sessions, 0)             AS cart_sessions,
            COALESCE(abandoned.abandoned_carts, 0)          AS abandoned_carts,
            CAST(0 AS bigint)                               AS recovered_carts,
            COALESCE(abandoned.abandoned_value_minor, 0)    AS abandoned_value_minor,
            now()                                           AS updated_at
        FROM keys k
        LEFT JOIN cart_agg  USING (brand_id, cart_date, currency_code)
        LEFT JOIN abandoned USING (brand_id, cart_date, currency_code)
        WHERE k.brand_id IS NOT NULL AND k.cart_date IS NOT NULL
    """

    # The rollup is already 1 row per PK (GROUP BY upstream), so merge_on_pk's in-batch dedup is a no-op;
    # order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    run_job("gold-abandoned-cart", build, target_table=TABLE)
