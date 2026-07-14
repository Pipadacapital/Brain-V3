"""
silver_coupon.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_coupon.py.

Single lane → filter → fold-latest-per-code → idempotent MERGE on (brand_id, coupon_code):
  - coupon.upsert.v1 out of the gated collector lane (server-trusted, WOO-3 admit-list) → the
    canonical per-(brand,coupon_code) latest-state coupon mart (brain_silver.silver_coupon).

Fold: latest occurred_at wins, tie-break highest event_id; first_event_at = earliest occurred_at
per (brand,coupon_code) for cohorting. Rows with no coupon_code are dropped (a coupon with no code
cannot be applied). Money = BIGINT minor units (FIXED coupons) + sibling currency_code; amount_percent
is a verbatim percentage STRING (NEVER money, NEVER scaled — avoids the x100 corruption). PERCENT
coupons carry NULL amount_minor / NULL currency_code so the two discount kinds never blend.

NOTE: the Spark job's Stage-1 quarantine side-write (dq_violations_udf money+timestamp gate →
write_quarantine) is INTENTIONALLY SKIPPED in this port, per the migration plan (quarantine/consent
side-writes are out of scope). Parity target: brain_silver.silver_coupon.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to silver_coupon_duckdb_test
# instead of the live table (plan: parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_coupon{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

COUPON_EVENT_TYPE = "coupon.upsert.v1"

COLUMNS_SQL = """
  brand_id        string    NOT NULL,
  coupon_code     string    NOT NULL,
  coupon_id       string,
  source          string,
  discount_type   string,
  amount_minor    bigint,
  amount_percent  string,
  currency_code   string,
  usage_count     bigint,
  usage_limit     bigint,
  expires_at      timestamptz,
  first_event_at  timestamptz,
  last_state_at   timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "coupon_code", "coupon_id", "source", "discount_type", "amount_minor",
    "amount_percent", "currency_code", "usage_count", "usage_limit", "expires_at",
    "first_event_at", "last_state_at", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(first_event_at)")

    # Project the canonical coupon properties out of the gated collector lane (1 row per upsert state).
    events = f"""
      SELECT brand_id, event_id, occurred_at,
             {prop('pj','source')}         AS source,
             {prop('pj','code')}           AS coupon_code,
             coalesce({prop('pj','coupon_id')}, {prop('pj','woocommerce_coupon_id')}) AS coupon_id,
             {prop('pj','discount_type')}  AS discount_type,
             CAST({prop('pj','amount_minor')} AS BIGINT)  AS amount_minor,
             {prop('pj','amount_percent')} AS amount_percent,
             {prop('pj','currency_code')}  AS currency_code,
             CAST({prop('pj','usage_count')} AS BIGINT)   AS usage_count,
             CAST({prop('pj','usage_limit')} AS BIGINT)   AS usage_limit,
             -- expires_at is an ISO-8601 offset-aware string (…Z). The target Iceberg column is
             -- timestamptz (as Spark created it), so cast to TIMESTAMPTZ: it honors the Z offset and
             -- preserves the instant, rendering identically to Spark's cast(AS timestamp) fold.
             CAST({prop('pj','expires_at')} AS TIMESTAMPTZ) AS expires_at
      FROM ({read_gated_events_sql([COUPON_EVENT_TYPE])})
    """

    # Fold to LATEST state per (brand, coupon_code): latest occurred_at wins, tie-break highest event_id.
    # first_event_at = earliest occurred_at per key (coupon first-seen). Drop rows with no code.
    good = f"""
      SELECT brand_id, coupon_code, coupon_id, source, discount_type, amount_minor, amount_percent,
             currency_code, usage_count, usage_limit, expires_at, first_event_at,
             last_state_at, updated_at
      FROM (
        SELECT brand_id, coupon_code, coupon_id, source, discount_type, amount_minor, amount_percent,
               currency_code, usage_count, usage_limit, expires_at,
               min(occurred_at) OVER (PARTITION BY brand_id, coupon_code) AS first_event_at,
               occurred_at AS last_state_at,
               now() AS updated_at,
               row_number() OVER (
                 PARTITION BY brand_id, coupon_code ORDER BY occurred_at DESC, event_id DESC
               ) AS _win_rn
        FROM ({events})
        WHERE coupon_code IS NOT NULL AND coupon_code <> ''
      )
      WHERE _win_rn = 1
    """

    return merge_on_pk(con, TARGET, good, COLUMNS, ["brand_id", "coupon_code"],
                       order_by_desc=["last_state_at", "updated_at"])


if __name__ == "__main__":
    run_job("silver-coupon", build, target_table="silver_coupon")
