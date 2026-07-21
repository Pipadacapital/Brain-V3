"""
gold_ai_features.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_ai_features.py.

NET-NEW gap Gold `ai_features` SERVING mart (Brain V4 Phase 2, GROUP "NEW gap Gold products"). A Gold
SERVING product (served via mv_gold_ai_features), NOT the BANNED feature-precompute table — there is NO
permanent feature_customer_daily / brain_feature here. This is a RUNTIME Silver fold: a FULL recompute of
a compact, deterministic ML-input feature vector from the Silver spine on every refresh, MERGE-UPDATE'd
onto the PK. Downstream models read the served vector; NO model inference happens here.

NO dbt predecessor (parity status=NEW; matrix §3/4 GAP product). Reads the canonical Iceberg Silver marts:
  - silver_customer      — the (brand_id, brain_id) customer entity universe (the mart spine).
  - silver_order_state   — the order spine; the authoritative order rollup per (brand_id, brain_id):
                           order_count, lifetime_value_minor (Σ signed recognized money), currency_code,
                           last order recency.
  - silver_touchpoint    — journey touches; distinct marketing channels reached, mapped to brain_id via the
                           deterministic cart-stitch (stitched_brain_id). Optional (absent → 0 channels).
  - silver_journey       — the journey ENTITY conversion signal, mapped to brain_id through the same stitch.
                           Optional (absent → journey_converted false).

GRAIN / PK: exactly 1 row per (brand_id, brain_id) — matches the Spark mart PK EXACTLY. brand_id first
  column + bucket() partition anchor.
COLUMNS :
  order_count            — bigint  : lifetime resolved order count.
  lifetime_value_minor   — bigint  : Σ recognized order value, MINOR units, paired with currency_code.
  currency_code          — string  : the sibling ISO-4217 currency for BOTH money columns (single per
                                     customer; never blended across currencies).
  avg_order_value_minor  — bigint  : lifetime_value_minor INTEGER-divided by order_count (per-currency,
                                     NEVER float; 0 when the customer has no orders). Sibling currency_code.
  recency_days           — int     : whole days since the last order/state effective date (nullable).
  distinct_channels      — bigint  : distinct deterministic channels this customer's stitched journey hit.
  converted_flag         — boolean : has the customer converted (≥1 order) OR did the stitched journey reach
                                     a conversion event — a deterministic OR fold over the order + journey
                                     signals. NEVER a model output.

MONEY (I-S07): bigint MINOR units + sibling currency_code; per-currency, integer division for AOV.
  Spark `DIV` (IntegralDivide, truncate toward zero) → DuckDB `//` (floor-div). Operands here are
  non-negative (COALESCE(...,0) counts + Σ recognized value guarded > 0), so `//` == truncate == `DIV`.
  The divide is guarded by the order-count CASE (0 when no orders) — never a divide-by-zero.
DATE MATH (Spark → DuckDB): Spark DATEDIFF(CURRENT_DATE(), CAST(x AS DATE)) = whole-day (end − start) →
  DuckDB date_diff('day', CAST(x AS DATE), current_date) — note the ARGUMENT ORDER flips (start first,
  end second) so the sign matches. NULL last-order/last-seen → NULL recency_days.
PII      : aggregate mart — brain_id is the ONLY identity key; NO raw/hashed email/phone rides through.
REPLAY-SAFE: full recompute from Silver each run, MERGE-UPDATE'd on the (brand_id, brain_id) PK.

FULL RECOMPUTE vs Spark's entity_incremental wrapper: the Spark job wraps the identical fold in
  run_job(entity_incremental=...) (a SCALING optimization — recompute only brands whose source Silver
  changed since the watermark, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is
  parity-equivalent: the MERGE on the mart PK is idempotent and restates every (brand_id, brain_id).

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver).
VENDORED: nothing — the Spark job uses only built-in functions (no pure helper module), so the DuckDB
  port is pure SQL; no module is copied into duckdb/gold/.

Parity target: brain_gold.gold_ai_features (NEW — no Spark-produced oracle). PK (brand_id, brain_id);
  money col lifetime_value_minor (+ avg_order_value_minor).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_ai_features_duckdb_test
# instead of the live mart (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_ai_features{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_CUSTOMER = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
SILVER_TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
SILVER_JOURNEY = f"{CATALOG}.{SILVER_NAMESPACE}.silver_journey"

# Column contract — byte-for-byte the Spark mart's COLUMNS_SQL. brand_id tenant key first; money =
# bigint minor + currency. Uses Iceberg/Spark type names (ensure_table maps them).
COLUMNS_SQL = """
  brand_id              string    NOT NULL,
  brain_id              string    NOT NULL,
  order_count           bigint    NOT NULL,
  lifetime_value_minor  bigint    NOT NULL,
  currency_code         string,
  avg_order_value_minor bigint    NOT NULL,
  recency_days          int,
  distinct_channels     bigint    NOT NULL,
  converted_flag        boolean   NOT NULL,
  updated_at            timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_id", "order_count", "lifetime_value_minor", "currency_code",
    "avg_order_value_minor", "recency_days", "distinct_channels", "converted_flag", "updated_at",
]

PK = ["brand_id", "brain_id"]


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent optional source degrades to the empty fold
        return False


def build(con):
    # brand-first tenant bucketing (mirrors the Spark bucket(64, brand_id) hidden partitioning).
    ensure_table(con, TARGET, COLUMNS_SQL)

    # ── order rollup from the order spine (silver_order_state), brain_id-resolved only. The
    #    authoritative per-customer order aggregate: count, Σ recognized money (per-currency), recency. ──
    orders = f"""
      SELECT
        brand_id,
        brain_id,
        COUNT(order_id)                        AS order_count,
        CAST(SUM(order_value_minor) AS BIGINT) AS lifetime_value_minor,
        MAX(currency_code)                     AS currency_code,
        MAX(state_effective_at)                AS last_order_at
      FROM {SILVER_ORDER_STATE}
      WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL
      GROUP BY brand_id, brain_id
    """

    # ── distinct channels + anon→brain stitch map from silver_touchpoint (optional source) ──
    has_tp = _table_exists(con, SILVER_TOUCHPOINT)
    if has_tp:
        channels = f"""
          SELECT
            brand_id,
            stitched_brain_id AS brain_id,
            CAST(COUNT(DISTINCT channel) AS BIGINT) AS distinct_channels
          FROM {SILVER_TOUCHPOINT}
          WHERE brand_id IS NOT NULL AND stitched_brain_id IS NOT NULL
          GROUP BY brand_id, stitched_brain_id
        """
        anon_map = f"""
          SELECT DISTINCT brand_id, brain_anon_id, stitched_brain_id
          FROM {SILVER_TOUCHPOINT}
          WHERE stitched_brain_id IS NOT NULL
        """
    else:
        channels = (
            "SELECT NULL::VARCHAR AS brand_id, NULL::VARCHAR AS brain_id, "
            "NULL::BIGINT AS distinct_channels WHERE FALSE"
        )
        anon_map = None

    # ── journey conversion signal, mapped to brain_id via the stitch (optional source) ──
    if has_tp and _table_exists(con, SILVER_JOURNEY):
        converted = f"""
          SELECT
            m.brand_id,
            m.stitched_brain_id AS brain_id,
            MAX(CASE WHEN j.converted THEN TRUE ELSE FALSE END) AS journey_converted
          FROM ({anon_map}) m
          JOIN {SILVER_JOURNEY} j
            ON j.brand_id = m.brand_id AND j.brain_anon_id = m.brain_anon_id
          GROUP BY m.brand_id, m.stitched_brain_id
        """
    else:
        converted = (
            "SELECT NULL::VARCHAR AS brand_id, NULL::VARCHAR AS brain_id, "
            "NULL::BOOLEAN AS journey_converted WHERE FALSE"
        )

    # ── the feature vector: silver_customer entity spine LEFT JOIN the order/channel/journey folds ──
    # DIV → // (floor-div == truncate here: operands non-negative). recency = date_diff('day', <date>,
    # current_date) — Spark DATEDIFF(CURRENT_DATE(), <date>) with the argument order flipped so the sign
    # matches. converted_flag = deterministic OR fold (orders>0 OR journey reached conversion).
    staged = f"""
      SELECT
        c.brand_id,
        c.brain_id,
        CAST(COALESCE(o.order_count, c.lifetime_orders, 0) AS BIGINT)               AS order_count,
        CAST(COALESCE(o.lifetime_value_minor, c.lifetime_value_minor, 0) AS BIGINT) AS lifetime_value_minor,
        COALESCE(o.currency_code, c.currency_code)                                  AS currency_code,
        CAST(
          CASE WHEN COALESCE(o.order_count, c.lifetime_orders, 0) > 0
               THEN COALESCE(o.lifetime_value_minor, c.lifetime_value_minor, 0)
                    // COALESCE(o.order_count, c.lifetime_orders)
               ELSE 0 END
        AS BIGINT)                                                                  AS avg_order_value_minor,
        CAST(date_diff('day',
                       CAST(COALESCE(o.last_order_at, c.last_seen_at) AS DATE),
                       current_date) AS INT)                                        AS recency_days,
        CAST(COALESCE(ch.distinct_channels, 0) AS BIGINT)                           AS distinct_channels,
        (COALESCE(o.order_count, c.lifetime_orders, 0) > 0
         OR COALESCE(cv.journey_converted, FALSE))                                  AS converted_flag,
        now() AT TIME ZONE 'UTC'                                                    AS updated_at
      FROM {SILVER_CUSTOMER} c
      LEFT JOIN ({orders})    o  ON o.brand_id  = c.brand_id AND o.brain_id  = c.brain_id
      LEFT JOIN ({channels})  ch ON ch.brand_id = c.brand_id AND ch.brain_id = c.brain_id
      LEFT JOIN ({converted}) cv ON cv.brand_id = c.brand_id AND cv.brain_id = c.brain_id
      WHERE c.brand_id IS NOT NULL AND c.brain_id IS NOT NULL
    """

    # Idempotent MERGE on the (brand_id, brain_id) PK — the spine yields one row per PK, so the in-batch
    # dedup order_by is a stable tie-break no-op.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK,
                       order_by_desc=["updated_at", "order_count"])


if __name__ == "__main__":
    run_job("gold-ai-features", build, target_table="gold_ai_features")
