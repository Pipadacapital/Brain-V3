"""
silver_customer.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_customer.py
(itself the Spark reimplementation of the dbt silver_customer mart).

The canonical CUSTOMER entity — exactly one row per resolved customer (brand_id, brain_id) — as an
additive roll-up of the order spine (silver_order_state) LEFT JOINed to the identity projection
(silver_customer_identity). This is the FIRST DuckDB port that reads sibling Silver marts DIRECTLY
(NOT the gated collector-event keystone): it consumes {CATALOG}.brain_silver.silver_order_state and
{CATALOG}.brain_silver.silver_customer_identity — the same Iceberg tables the Spark job reads.

GRAIN: exactly one row per (brand_id, brain_id) — the model PK. Unlinked orders (brain_id NULL) are
  EXCLUDED (`where brain_id is not null`).

THE TRANSFORM (folded from the dbt FULL-build branch, verbatim to the Spark job):
  order_rollup  = from silver_order_state where brain_id is not null, GROUP BY (brand_id, brain_id):
        lifetime_orders        = count(order_id)                      -> bigint
        lifetime_value_minor   = cast(sum(order_value_minor) as bigint)  -- MONEY: bigint minor units
        currency_code          = max(currency_code)
        first_seen_at          = min(first_event_at)
        last_seen_at           = max(state_effective_at)
        customer_watermark     = max(max_ingested_at)
  identity_node = from silver_customer_identity where lifecycle_state <> 'merged':
        (brand_id, brain_id) -> first_identified_at   (H6 acquisition time)
  result        = order_rollup LEFT JOIN identity_node on (brand_id, brain_id).

MONEY (I-S07): lifetime_value_minor is BIGINT minor units + a sibling currency_code (never a float).
  A customer's lifetime_value_minor can be legitimately net-NEGATIVE (refunds > orders), so — exactly
  like the Spark job — the amount-sign DQ rule is NOT applied at this aggregate grain.

PII-SAFETY: this is a PII-FREE aggregate. The canonical customer entity is keyed by the brain_id
  surrogate only; it carries NO raw name/email/phone. Hashed PII lives upstream on silver_identity_link
  edges — never re-derived here. Both source reads project only the surrogate keys + numeric/temporal
  aggregates.

STAGE-1 DQ GATE (parity-preserving, NOT a quarantine side-write): the Spark job diverts rolled-up
  customers whose aggregate currency_code is not ISO-4217 alpha-3 (UPPERCASE) to silver_quarantine and
  excludes them from silver_customer. This framework has NO quarantine table (documented invariant), so
  we reproduce ONLY the row-set effect: the SAME `good` predicate is applied as a WHERE filter so the
  written row-set is byte-identical to the Spark `good` set. (Faithful to dq_violations_udf called with
  amount=NULL, occurred_at=NULL → the ONLY applicable rule is invalid_currency: currency present &
  non-empty & NOT ^[A-Z]{3}$. NULL/empty currency → admitted.)

Idempotency: a full GROUP-BY recompute over the current Silver spine is deterministic; MERGE on the PK
  (brand_id, brain_id) is the authoritative latest roll-up (never double-counts / regresses on re-run).
Parity target: brain_silver.silver_customer (3202 rows). Run twice — idempotent.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to silver_customer_duckdb_test
# instead of the live table (parallel run -> compare -> cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
CUSTOMER_IDENTITY = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer_identity"

COLUMNS_SQL = """
  brand_id             string    NOT NULL,
  brain_id             string    NOT NULL,
  lifetime_orders      bigint,
  lifetime_value_minor bigint,
  currency_code        string,
  first_seen_at        timestamp,
  first_identified_at  timestamp,
  last_seen_at         timestamp,
  customer_watermark   timestamp,
  updated_at           timestamp
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_id", "lifetime_orders", "lifetime_value_minor", "currency_code",
    "first_seen_at", "first_identified_at", "last_seen_at", "customer_watermark", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(8, brand_id)")

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ──────────────────────
    #   GRAIN = entity_fold: MANY silver_order_state rows aggregate into ONE (brand_id, brain_id) customer
    #   row whose lifetime totals depend on the entity's FULL order history — including rows BELOW the
    #   watermark. Windowing the fold input directly would silently drop history → wrong lifetime money.
    #   So we window ONLY to DISCOVER which entities changed (a new order landed since the last run), then
    #   re-fold each changed entity over its FULL, UNWINDOWED order history. The MERGE on the PK
    #   (brand_id, brain_id) upserts exactly those restated rollups. The fold-driving source is the order
    #   spine silver_order_state (ts_col=ingested_at); its max_ingested_at feeds customer_watermark.
    #   Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below is
    #   byte-identical to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "silver-customer", ORDER_STATE, ts_col="ingested_at")

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range
    # over the order spine's arrival clock otherwise. Same entity-key guard as the fold (brain_id NOT NULL).
    win = []
    if lo is not None:
        win.append(f"ingested_at >= '{lo}'")
    if hi is not None:
        win.append(f"ingested_at <= '{hi}'")
    order_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: entities whose order spine changed within [lo, hi], using the SAME (brand_id,
    # brain_id) key + brain_id-NOT-NULL guard the fold uses. Built ONLY when incremental (lo not None).
    changed = f"""
      SELECT DISTINCT brand_id, brain_id
      FROM {ORDER_STATE}
      WHERE brain_id IS NOT NULL{order_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed entities so
    # each re-folds over its ENTIRE order history. EMPTY when lo is None → unwindowed full recompute.
    refold_filter = (
        f"        AND (brand_id, brain_id) IN (SELECT brand_id, brain_id FROM ({changed}))\n"
        if lo is not None else ""
    )

    # ── order_rollup — dbt FULL-build aggregation over the order spine (brain_id NOT NULL). ──
    # The source timestamp columns are TIMESTAMP WITH TIME ZONE; our Silver columns are naive
    # `timestamp` (Iceberg parity with the Spark UTC instants). `AT TIME ZONE 'UTC'` pins the
    # wall-clock to UTC regardless of the DuckDB session TZ (byte-parity with the Spark instants).
    order_rollup = f"""
      SELECT brand_id, brain_id,
             CAST(count(order_id) AS BIGINT)          AS lifetime_orders,
             CAST(sum(order_value_minor) AS BIGINT)   AS lifetime_value_minor,
             max(currency_code)                       AS currency_code,
             min(first_event_at)     AT TIME ZONE 'UTC' AS first_seen_at,
             max(state_effective_at) AT TIME ZONE 'UTC' AS last_seen_at,
             max(max_ingested_at)    AT TIME ZONE 'UTC' AS customer_watermark
      FROM {ORDER_STATE}
      WHERE brain_id IS NOT NULL
{refold_filter}      GROUP BY brand_id, brain_id
    """

    # ── identity_node — silver_customer_identity where lifecycle_state <> 'merged'. ──
    # Absent-table safety mirrors the Spark createDataFrame([]) fallback: the LEFT JOIN then leaves
    # first_identified_at NULL. (In this deployment the table exists; the try/except keeps parity.)
    try:
        con.execute(f"SELECT 1 FROM {CUSTOMER_IDENTITY} LIMIT 0")
        identity_node = f"""
          SELECT brand_id, brain_id,
                 first_identified_at AT TIME ZONE 'UTC' AS first_identified_at
          FROM {CUSTOMER_IDENTITY}
          WHERE lifecycle_state <> 'merged'
        """
    except Exception:  # noqa: BLE001 — identity mart absent -> first_identified_at NULL (LEFT JOIN)
        identity_node = (
            "SELECT CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS brain_id, "
            "CAST(NULL AS TIMESTAMP) AS first_identified_at WHERE FALSE"
        )

    result = f"""
      SELECT o.brand_id, o.brain_id, o.lifetime_orders, o.lifetime_value_minor, o.currency_code,
             o.first_seen_at, i.first_identified_at, o.last_seen_at, o.customer_watermark,
             now() AT TIME ZONE 'UTC' AS updated_at
      FROM ({order_rollup}) o
      LEFT JOIN ({identity_node}) i
        ON o.brand_id = i.brand_id AND o.brain_id = i.brain_id
    """

    # ── Stage-1 DQ gate (currency only; parity-preserving WHERE, no quarantine side-write). ──
    # Excludes rolled-up customers whose currency_code is present, non-empty, and NOT ISO-4217
    # alpha-3 UPPERCASE — the exact `good` set of the Spark job. NULL/empty currency is admitted.
    good = f"""
      SELECT {', '.join(COLUMNS)} FROM ({result})
      WHERE currency_code IS NULL OR trim(currency_code) = ''
         OR regexp_matches(trim(currency_code), '^[A-Z]{{3}}$')
    """

    # Idempotent MERGE on the PK. WHEN MATCHED UPDATE restates a customer's lifetime totals when a new
    # order lands (dbt incremental re-fold); WHEN NOT MATCHED INSERT for new customers.
    return merge_on_pk(con, TARGET, good, COLUMNS, ["brand_id", "brain_id"],
                       order_by_desc=["customer_watermark", "last_seen_at"])


if __name__ == "__main__":
    # The watermark tracks the order spine's arrival clock (silver_order_state.ingested_at), NOT the gated
    # keystone default — this job reads sibling Silver marts, not silver_collector_event.
    run_job("silver-customer", build, target_table="silver_customer",
            source_table=ORDER_STATE, ts_col="ingested_at")
