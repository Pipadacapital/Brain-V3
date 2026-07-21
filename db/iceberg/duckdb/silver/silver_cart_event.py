"""
silver_cart_event.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_cart_event.py.

The pre-checkout cart-interaction grain — one row per (brand_id, event_id) cart mutation/view signal
from the universal first-party pixel, normalized to one shape (powers add-to-cart-rate, cart-abandonment,
promo-attach). Two lanes → union → Stage-1 anon gate → Stage-1 DQ gate → idempotent MERGE on
(brand_id, event_id). Parity target: brain_silver.silver_cart_event.

FAITHFUL to the Spark build():
  - Lane 1 (cart.*): cart.item_added|item_removed|updated|viewed → variant_id, quantity, product_handle,
    value_minor (bigint minor units, NULL when the storefront carries no cart price), currency_code, path,
    referrer, device_class (device.ua_class). coupon_code = NULL.
  - Lane 2 (coupon.applied): folded as cart_action='coupon_applied'; coupon_code = coalesce(code, coupon_code)
    (a discount code, NOT PII). product_handle/variant_id/quantity = NULL.
  - cart_action discriminant CASE verbatim (item_added|item_removed|updated|viewed|coupon_applied|unknown).
  - Structural PK guard (event_id + brand_id NOT NULL), then the Stage-1 empty_identifier:brain_anon_id
    drop (anon-keyed; a no-anon row cannot tie to a journey), then the Stage-1 DQ gate below.
  - dedup: merge_on_pk dedups DESC by (ingested_at, occurred_at) — same as the Spark merge_on_pk call.

MONEY: value_minor is BIGINT minor units + a sibling currency_code (never a float, never blended). NULL for
storefronts that carry no cart price — NEVER fabricated.

STAGE-1 DQ GATE (dq_violations_udf(value_minor, currency_code, occurred_at::string, quantity)) translated to
SQL. A NULL column is OMITTED from the checked record in the UDF, so each rule is guarded on the presence of
its column. A row is admitted only when NO rule fires:
  - negative_amount        value_minor < 0                            (integer post-CAST → non_integer N/A)
  - invalid_currency       currency_code present & not ^[A-Z]{3}$ (uppercase alpha-3)
  - missing_currency       value_minor present but currency_code NULL/empty (money needs a sibling)
  - unparseable_timestamp  occurred_at NULL
  - future_occurred_at     occurred_at > now() + 5min skew
  - impossible_quantity    quantity present & (quantity < 0 OR quantity > 1,000,000)

CAVEAT — quarantine side-write SKIPPED: the Spark job diverts the empty_identifier + dq rejects to
brain_silver.silver_quarantine (stage='dq') and drops them. This DuckDB port preserves the SAME admission
set (good rows are data-equivalent) but does NOT write the quarantine ledger (no _silver_technical analogue
here). Bronze keeps the originals, so the quarantine ledger can be rebuilt separately.

Honors MIGRATION_TABLE_SUFFIX (→ silver_cart_event_duckdb_test) for the parallel-run parity harness.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GATED_SOURCE, ensure_table, incremental_window, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write to silver_cart_event_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_cart_event{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

CART_EVENTS = ["cart.item_added", "cart.item_removed", "cart.updated", "cart.viewed"]
COUPON_EVENT = "coupon.applied"

# DQ constants — verbatim from _silver_technical (DEFAULT_SKEW_MS = 5min, DEFAULT_ABSURD_QTY = 1,000,000).
SKEW_MINUTES = 5
ABSURD_QTY = 1_000_000

COLUMNS_SQL = """
  brand_id        string    NOT NULL,
  event_id        string    NOT NULL,
  brain_anon_id   string    NOT NULL,
  session_id      string,
  cart_action     string,
  product_handle  string,
  variant_id      string,
  quantity        bigint,
  value_minor     bigint,
  currency_code   string,
  coupon_code     string,
  path            string,
  referrer        string,
  device_class    string,
  occurred_at     timestamp NOT NULL,
  ingested_at     timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "brain_anon_id", "session_id", "cart_action", "product_handle",
    "variant_id", "quantity", "value_minor", "currency_code", "coupon_code", "path", "referrer",
    "device_class", "occurred_at", "ingested_at",
]

# cart_action discriminant — verbatim CASE port of _cart_action (event_type → normalized action).
_CART_ACTION = (
    "CASE event_type "
    "WHEN 'cart.item_added'   THEN 'item_added' "
    "WHEN 'cart.item_removed' THEN 'item_removed' "
    "WHEN 'cart.updated'      THEN 'updated' "
    "WHEN 'cart.viewed'       THEN 'viewed' "
    "WHEN 'coupon.applied'    THEN 'coupon_applied' "
    "ELSE 'unknown' END"
)


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   Per-event grain over the gated keystone: each source row → 0..1 silver row via the idempotent
    #   MERGE on (brand_id, event_id), so narrowing the source read is safe. read_gated_events_sql builds
    #   the [lo,hi) predicate on ingested_at itself and OMITS it when lo/hi are None → default OFF (lo=None)
    #   yields a byte-identical full scan.
    lo, hi = incremental_window(con, "silver-cart-event", GATED_SOURCE, ts_col="ingested_at")

    # ── Lane 1: cart.* interaction events (variant/qty; value only if the storefront emits it) ──────
    cart = f"""
      SELECT brand_id, event_id,
             {prop('pj','brain_anon_id')} AS brain_anon_id,
             {prop('pj','session_id')} AS session_id,
             {_CART_ACTION} AS cart_action,
             {prop('pj','product_handle')} AS product_handle,
             {prop('pj','variant_id')} AS variant_id,
             CAST({prop('pj','quantity')} AS BIGINT) AS quantity,
             CAST({prop('pj','value_minor')} AS BIGINT) AS value_minor,
             {prop('pj','currency_code')} AS currency_code,
             CAST(NULL AS VARCHAR) AS coupon_code,
             {prop('pj','landing_path')} AS path,
             {prop('pj','referrer')} AS referrer,
             {prop('pj','device.ua_class')} AS device_class,
             occurred_at, ingested_at
      FROM ({read_gated_events_sql(CART_EVENTS, lo=lo, hi=hi)})
    """

    # ── Lane 2: coupon.applied folded in as a cart action (carries the discount `code`, NOT PII) ─────
    coupon = f"""
      SELECT brand_id, event_id,
             {prop('pj','brain_anon_id')} AS brain_anon_id,
             {prop('pj','session_id')} AS session_id,
             'coupon_applied' AS cart_action,
             CAST(NULL AS VARCHAR) AS product_handle,
             CAST(NULL AS VARCHAR) AS variant_id,
             CAST(NULL AS BIGINT) AS quantity,
             CAST({prop('pj','value_minor')} AS BIGINT) AS value_minor,
             {prop('pj','currency_code')} AS currency_code,
             coalesce({prop('pj','code')}, {prop('pj','coupon_code')}) AS coupon_code,
             {prop('pj','landing_path')} AS path,
             {prop('pj','referrer')} AS referrer,
             {prop('pj','device.ua_class')} AS device_class,
             occurred_at, ingested_at
      FROM ({read_gated_events_sql([COUPON_EVENT], lo=lo, hi=hi)})
    """

    unioned = f"({cart}) UNION ALL BY NAME ({coupon})"

    # Structural PK guard + Stage-1 empty_identifier:brain_anon_id drop (anon-keyed grain).
    keyed = f"""
      SELECT {', '.join(COLUMNS)} FROM ({unioned})
      WHERE event_id IS NOT NULL AND brand_id IS NOT NULL
        AND brain_anon_id IS NOT NULL AND brain_anon_id <> ''
    """

    # ── Stage-1 DQ gate (dq_violations_udf translated to SQL; NULL column ⇒ rule omitted). Admit only
    # rows where NO rule fires. ──
    good = f"""
      SELECT {', '.join(COLUMNS)} FROM ({keyed})
      WHERE NOT (value_minor IS NOT NULL AND value_minor < 0)                                       -- negative_amount
        AND NOT (currency_code IS NOT NULL AND NOT regexp_full_match(currency_code, '^[A-Z]{{3}}$'))-- invalid_currency
        AND NOT (value_minor IS NOT NULL AND (currency_code IS NULL OR trim(currency_code) = ''))   -- missing_currency
        AND occurred_at IS NOT NULL                                                                 -- unparseable_timestamp
        AND occurred_at <= now() + INTERVAL {SKEW_MINUTES} MINUTE                                   -- future_occurred_at
        AND NOT (quantity IS NOT NULL AND (quantity < 0 OR quantity > {ABSURD_QTY}))                -- impossible_quantity
    """

    return merge_on_pk(con, TARGET, good, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-cart-event", build, target_table="silver_cart_event")
