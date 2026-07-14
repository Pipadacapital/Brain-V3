"""
gold_customer_segments.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_customer_segments.py.

The deterministic customer-segments Gold mart (Brain V4 Phase 2, GROUP customer). Reads the
silver_customer spine DIRECTLY (like the DuckDB silver_customer port — NOT the gated collector-event
keystone) and emits, per brand, TWO orthogonal segment dimensions rolled up keyed
(brand_id, segment_type, segment):

  • segment_type='value_tier' — the value-tier ladder (high_value / mid_value / low_value /
    no_realized_value), UNCHANGED, byte-for-byte with existing readers.
  • segment_type='lifecycle'  — the named lifecycle ladder (VIP / high_value / loyal / first_time_buyer /
    at_risk / churned / cart_abandoner / window_shopper) assigned by the deterministic first-match
    precedence over the RFM / recency / order-count signals.

THE RULE LOGIC IS SINGLE-SOURCED. Both CASE ladders + the lifecycle precedence + every threshold live in
the pure, no-Spark module db/iceberg/spark/gold/_segment_rules.py — the SAME module the Spark job imports.
We import the SAME value_tier_case_sql / lifecycle_segment_case_sql builders here (they emit plain-integer
CASE strings that are identical in Spark SQL and DuckDB), so the thresholds can NEVER drift between the two
engines. (Faithful port rule: reproduce thresholds EXACTLY → done by re-using the source of truth.)

THE THREE BASE SIGNALS (per silver_customer row, all integer — folded at runtime, V4 rule: features are
RUNTIME):
  recency_days         = datediff('day', last_seen_at::date, current_date)  — NULL last_seen_at → a large
                         sentinel (10^6) so the customer falls into 'churned' (never mis-bucketed recent).
  lifetime_orders      = COALESCE(silver_customer.lifetime_orders, 0)       — frequency signal.
  lifetime_value_minor = COALESCE(silver_customer.lifetime_value_minor, 0)  — monetary signal (bigint MINOR).

MONEY (I-S07): segment_value_minor is a bigint MINOR-unit Σ of lifetime_value_minor — a pure additive sum,
no rounding. The segment grain carries NO currency_code (it sums across all of a brand's currencies into
one per-(brand, segment_type, segment) bucket — the documented, unchanged deviation).

PII-safe: no brain_id / hashes on this rollup grain — counts + Σ only.

PK (brand_id, segment_type, segment). brand_id is the first column / tenant key (V4 rule 5).

CAVEATS vs the Spark job (all parity-preserving):
  - NO quarantine side-write to reproduce — this mart has none (the segment rules never quarantine; every
    customer maps to exactly one value tier AND one lifecycle segment). Nothing to note beyond that.
  - NO gold_partition_filter / PARTITION-INCREMENTAL: this port does a FULL recompute over silver_customer
    every run (the Spark incremental path is a performance optimisation whose end-state is byte-identical to
    the full recompute — the rollup is authoritative, MERGE-restated on the PK). The Spark `_evolve_schema`
    ALTER-ADD-COLUMN dance is unneeded here: ensure_table creates the full schema (segment_type included).
  - MERGE is full-recompute → the framework merge_on_pk is the idempotent equivalent of the Spark
    full-overwrite/MERGE (WHEN MATCHED UPDATE the rollup, WHEN NOT MATCHED INSERT). Run twice — idempotent.

Parity target: brain_gold.gold_customer_segments (29 rows).
"""
from __future__ import annotations

import os
import sys

# _segment_rules.py (the single source of truth for the segment CASE strings + thresholds) is vendored
# into duckdb/gold/ so the DuckDB tree is self-contained (survives Spark-tree deletion). It is a byte
# copy of the pure module the Spark job imports — thresholds are imported, never re-typed.
_HERE = os.path.dirname(os.path.abspath(__file__))
_DUCKDB_ROOT = os.path.dirname(_HERE)              # db/iceberg/duckdb
sys.path.insert(0, _DUCKDB_ROOT)
sys.path.insert(0, _HERE)  # duckdb/gold — for the vendored _segment_rules

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402
from _segment_rules import (  # noqa: E402  — vendored pure module (duckdb/gold/_segment_rules.py)
    SEGMENT_TYPE_LIFECYCLE,
    SEGMENT_TYPE_VALUE_TIER,
    lifecycle_segment_case_sql,
    value_tier_case_sql,
)

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_customer_segments_duckdb_test
# instead of the live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_customer_segments{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SILVER_CUSTOMER = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"

# The large recency sentinel for a NULL last_seen_at — verbatim with the Spark job's {int(10 ** 6)}.
_RECENCY_SENTINEL = 10 ** 6

COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  segment_type        string    NOT NULL,
  segment             string    NOT NULL,
  customer_count      bigint,
  segment_value_minor bigint,
  updated_at          timestamp
""".strip("\n")

COLUMNS = [
    "brand_id", "segment_type", "segment", "customer_count", "segment_value_minor", "updated_at",
]

PK = ["brand_id", "segment_type", "segment"]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(4, brand_id)")

    # The value-tier + lifecycle CASE strings — the EXACT expression strings the Spark job executes
    # (imported from the shared source of truth, so thresholds are byte-identical).
    value_tier_case = value_tier_case_sql("lifetime_value_minor")
    lifecycle_case = lifecycle_segment_case_sql("recency_days", "lifetime_orders", "lifetime_value_minor")

    # ── The three base signals per customer (V4 runtime feature fold). ──
    # recency_days = datediff('day', last_seen_at::date, current_date); DuckDB datediff('day', a, b) =
    # b − a in days, matching Spark datediff(current_date, last_seen_at::date). NULL last_seen_at → the
    # 10^6 sentinel (→ 'churned'). last_seen_at is TIMESTAMP WITH TIME ZONE upstream; AT TIME ZONE 'UTC'
    # pins the wall-clock before the ::DATE cast so the day bucket matches the Spark UTC instant.
    signals = f"""
      SELECT
        brand_id,
        COALESCE(lifetime_orders, 0)                                   AS lifetime_orders,
        COALESCE(lifetime_value_minor, 0)                              AS lifetime_value_minor,
        COALESCE(
          CAST(datediff('day', CAST(last_seen_at AT TIME ZONE 'UTC' AS DATE), current_date) AS INTEGER),
          {_RECENCY_SENTINEL}
        )                                                              AS recency_days
      FROM {SILVER_CUSTOMER}
      WHERE brand_id IS NOT NULL
    """

    labelled = f"""
      SELECT brand_id, lifetime_value_minor,
             '{SEGMENT_TYPE_VALUE_TIER}' AS segment_type,
             {value_tier_case}           AS segment
      FROM ({signals})
      UNION ALL
      SELECT brand_id, lifetime_value_minor,
             '{SEGMENT_TYPE_LIFECYCLE}'  AS segment_type,
             {lifecycle_case}            AS segment
      FROM ({signals})
    """

    staged = f"""
      SELECT
        brand_id,
        segment_type,
        segment,
        CAST(COUNT(*) AS BIGINT)                  AS customer_count,
        CAST(SUM(lifetime_value_minor) AS BIGINT) AS segment_value_minor,
        now() AT TIME ZONE 'UTC'                  AS updated_at
      FROM ({labelled})
      GROUP BY brand_id, segment_type, segment
    """

    # Full-recompute MERGE on the PK (brand_id, segment_type, segment): the GROUP BY already yields exactly
    # one row per PK, so the in-batch dedup is a no-op; order_by is nominal. WHEN MATCHED UPDATE restates the
    # aggregate, WHEN NOT MATCHED INSERT new tiers/segments — replay-safe (the rollup is authoritative).
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    run_job("gold-customer-segments", build, target_table="gold_customer_segments")
