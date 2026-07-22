"""
gold_customer_360.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_customer_360.py.

The flagship denormalized Customer-360 serving Gold mart (Brain V4 Phase 2, GROUP customer). Reads the
sibling Silver/Gold Iceberg tables DIRECTLY (NOT the gated collector-event keystone) and emits ONE row per
(brand_id, brain_id): lifetime value + order counts carried straight from the silver_customer spine, a
lifecycle breakdown (delivered / rto / cancelled / refunded) rolled up from silver_order_state, and the B2
enrichment fields folded on top (aov / preferred_channel / preferred_device / top_category /
acquisition_source / last_activity_at / journey_summary / health_band / churn_score / lifecycle_stage).

THE TRANSFORM (reproduced from the Spark materialize(), which itself folds dbt gold_customer_360.sql):
  customers  = silver_customer (the spine — brand_id, brain_id, lifetime_orders, lifetime_value_minor,
               currency_code, first_seen_at, first_identified_at, last_seen_at, customer_watermark).
  lifecycle  = silver_order_state WHERE brain_id IS NOT NULL, GROUP BY (brand_id, brain_id):
        delivered_orders = Σ CASE WHEN lifecycle_state='delivered' THEN 1 ELSE 0 END  (bigint)
        rto_orders       = Σ CASE WHEN lifecycle_state='rto'       THEN 1 ELSE 0 END  (bigint)
        cancelled_orders = Σ CASE WHEN lifecycle_state='cancelled' THEN 1 ELSE 0 END  (bigint)
        refunded_orders  = Σ CASE WHEN lifecycle_state='refunded'  THEN 1 ELSE 0 END  (bigint)
  result     = customers LEFT JOIN lifecycle → coalesce(<count>,0). updated_at = now() UTC.

B2 ENRICHMENT (all LEFT JOINs, NULL when the optional source is absent — honest-empty, never fabricated):
  - customer_ref       = brain_ref(brain_id) — the deterministic public BRN- surrogate. Registered as a
                         DuckDB scalar UDF wrapping the VENDORED pure _identity_ref.brain_ref, so the
                         EXECUTED encoding IS the unit-tested one (byte-identical to Spark's UDF).
  - aov_minor          = lifetime_value_minor // lifetime_orders via the VENDORED pure aov_minor UDF
                         (truncate toward zero = Spark `div`/IntegralDivide; NULL when orders<=0). EXACT
                         integer minor-unit division per the SAME currency_code — never blended, never float.
  - preferred_channel  = deterministic MODE of silver_touchpoint.channel per resolved customer
                         (stitched_brain_id); tie-break value ASC.
  - preferred_device   = MODE of silver_page_view.device_class mapped via the touchpoint anon→brain bridge.
  - top_category       = MODE of silver_order_line.title per customer (joined via silver_order_state).
  - acquisition_source = FIRST-touch channel: is_first_touch DESC, occurred_at ASC, channel ASC per customer.
  - last_activity_at   = max(silver_touchpoint.occurred_at) COALESCEd to silver_customer.last_seen_at.
  - journey_summary    = last 200 touchpoints as a JSON array [{seq,ts,event_type,channel,page_type,
                         product_handle,order_id,is_first_touch}], seq=1 most recent.
  - health_band        = deterministic recency band, INLINED from the retired gold_customer_health.py (DR-005).
  - churn_score        = INTEGER 0-100 via the VENDORED churn_score_from_risk UDF over the INLINED churn_risk (DR-005).
  - lifecycle_stage    = VENDORED lifecycle_stage UDF over (health_band, lifetime_orders).

MONEY (I-S07): lifetime_value_minor AND aov_minor are bigint MINOR units paired with currency_code (carried
  verbatim / exact integer division of it — no float). brand_id is the first column / tenant key.
  churn_score is a non-money INTEGER 0-100. PII: brain_id is the surrogate; no raw PII on this grain
  (customer_ref is a deterministic re-encoding of brain_id, not PII).

PK / GRAIN: exactly one row per (brand_id, brain_id) — matches the Spark mart PK EXACTLY.

MERGE RE-VERSIONING (aggregate grain): after the upsert, DELETE any (brand_id, brain_id) that appears in the
  silver_identity_map interval history but has NO live current interval (is_current=true AND system_to IS
  NULL) — a brain_id Neo4j has merged away, whose value re-folded onto the survivor. Reproduces
  _reconcile_merged_away over the SANCTIONED bi-temporal accessors (identity_raw / identity_current).
  Absent map → no-op.

CAVEATS vs the Spark job (all parity-preserving):
  - NO quarantine side-write to reproduce — this Gold rollup has none (reads already-gated Silver).
  - FULL recompute over the spine every run (the Spark gold_partition_filter incremental path is a perf
    optimisation whose end-state is byte-identical to a full recompute; the MERGE on the PK is idempotent).
  - DR-005: health/RFM/churn are INLINED (no gold_customer_health / gold_customer_scores marts — this
    mart is their sole successor; mv_gold_customer_health / mv_gold_customer_scores project it).

Parity target: brain_gold.gold_customer_360 (3202 rows). PK (brand_id, brain_id); money col
  lifetime_value_minor (+ aov_minor).
"""
from __future__ import annotations

import os
import sys

# The pure enrichment/ref modules are VENDORED into duckdb/gold/ (byte copies of the Spark-tree pure
# modules the Spark job imports) so the DuckDB tree is self-contained and survives Spark-tree deletion.
_HERE = os.path.dirname(os.path.abspath(__file__))
_DUCKDB_ROOT = os.path.dirname(_HERE)              # db/iceberg/duckdb
sys.path.insert(0, _DUCKDB_ROOT)
sys.path.insert(0, _HERE)                          # duckdb/gold — for the vendored pure modules

from _base import GOLD_INCREMENTAL, incremental_window, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402
from _customer_360_enrich import (  # noqa: E402 — vendored pure module (byte copy)
    aov_minor,
    churn_score_from_risk,
    lifecycle_stage,
)
from _identity_ref import brain_ref  # noqa: E402 — vendored pure module (byte copy)

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_customer_360_duckdb_test
# instead of the live mart (parallel run → compare → cut over). Empty in production.
_SUFFIX = os.environ.get("MIGRATION_TABLE_SUFFIX", "")
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_customer_360{_SUFFIX}"

SILVER_CUSTOMER = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
SILVER_TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
SILVER_PAGE_VIEW = f"{CATALOG}.{SILVER_NAMESPACE}.silver_page_view"
SILVER_ORDER_LINE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line"
SILVER_IDENTITY_MAP = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_map"

# Column contract — the dbt/Spark gold_customer_360 select list. brand_id first (tenant key). Money =
# bigint minor + currency. Uses Iceberg/Spark type names (ensure_table maps them).
COLUMNS_SQL = """
  brand_id             string    NOT NULL,
  brain_id             string    NOT NULL,
  customer_ref         string,
  lifetime_orders      bigint,
  lifetime_value_minor bigint,
  aov_minor            bigint,
  currency_code        string,
  first_seen_at        timestamp,
  first_identified_at  timestamp,
  last_seen_at         timestamp,
  last_activity_at     timestamp,
  delivered_orders     bigint,
  rto_orders           bigint,
  cancelled_orders     bigint,
  refunded_orders      bigint,
  preferred_channel    string,
  preferred_device     string,
  top_category         string,
  acquisition_source   string,
  health_band          string,
  churn_score          int,
  lifecycle_stage      string,
  journey_summary      string,
  recency_days         int,
  frequency            bigint,
  health_score         int,
  last_order_at        timestamp,
  days_since_last_order int,
  recency_score        int,
  frequency_score      int,
  monetary_score       int,
  churn_risk           string,
  segment              string,
  customer_watermark   timestamp,
  updated_at           timestamp
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_id", "customer_ref", "lifetime_orders", "lifetime_value_minor", "aov_minor",
    "currency_code", "first_seen_at", "first_identified_at", "last_seen_at", "last_activity_at",
    "delivered_orders", "rto_orders", "cancelled_orders", "refunded_orders",
    "preferred_channel", "preferred_device", "top_category", "acquisition_source",
    "health_band", "churn_score", "lifecycle_stage", "journey_summary",
    "recency_days", "frequency", "health_score", "last_order_at", "days_since_last_order",
    "recency_score", "frequency_score", "monetary_score", "churn_risk", "segment",
    "customer_watermark", "updated_at",
]

PK = ["brand_id", "brain_id"]

_JOURNEY_LIMIT = 200

# ── Lifecycle-segment ladder (ADR-0019 WS-3 D6) — the SINGLE source of truth. ────────────────────────
# Thresholds MIRRORED verbatim from the TS reader's named constants (deriveLifecycleSegment in
# packages/metric-engine/src/customer-scores-batch.ts, itself the mirror of the retired _segment_rules.py).
# Pre-baking the segment here (a column on the 360 → mv_gold_customer_scores) kills the TS re-derivation
# (a full brand scan) AND the ladder-drift hazard: the ladder now lives in exactly one place, the Gold pass.
_SEG_RECENCY_AT_RISK_MAX_DAYS = 180
_SEG_RECENCY_ACTIVE_MAX_DAYS = 90
_SEG_RECENCY_VIP_MAX_DAYS = 60
_SEG_FREQUENCY_LOYAL_MIN_ORDERS = 5
_SEG_MONETARY_VIP_MIN_MINOR = 10_000_000
_SEG_MONETARY_HIGH_MIN_MINOR = 5_000_000


def segment_case_sql(dslo_expr: str, orders_expr: str, value_expr: str) -> str:
    """The lifecycle-segment first-match ladder as a DuckDB CASE, reproducing deriveLifecycleSegment EXACTLY.

    Args are SQL expressions for the three base signals:
      dslo_expr   = days_since_last_order (recency). NULL when last_seen_at is unknown — SQL three-valued
                    logic makes every recency comparison NULL→false, matching the TS `recent` guard, so a
                    null-recency customer falls through to the value/frequency ladder (never churned/VIP).
      orders_expr = lifetime_orders (frequency). COALESCE'd to 0 to mirror the TS toBigIntFloor(null)=0n.
      value_expr  = lifetime_value_minor (MINOR units, never blended/float). COALESCE'd to 0 likewise.
    First-match precedence is byte-identical to the TS ladder; thresholds are the mirrored constants above.
    """
    orders = f"COALESCE({orders_expr}, 0)"
    value = f"COALESCE({value_expr}, 0)"
    return (
        f"CASE "
        f"WHEN {dslo_expr} > {_SEG_RECENCY_AT_RISK_MAX_DAYS} THEN 'churned' "
        f"WHEN {dslo_expr} > {_SEG_RECENCY_ACTIVE_MAX_DAYS} THEN 'at_risk' "
        f"WHEN {value} >= {_SEG_MONETARY_VIP_MIN_MINOR} AND {orders} >= {_SEG_FREQUENCY_LOYAL_MIN_ORDERS} "
        f"     AND {dslo_expr} <= {_SEG_RECENCY_VIP_MAX_DAYS} THEN 'VIP' "
        f"WHEN {orders} >= {_SEG_FREQUENCY_LOYAL_MIN_ORDERS} AND {dslo_expr} <= {_SEG_RECENCY_ACTIVE_MAX_DAYS} THEN 'loyal' "
        f"WHEN {value} >= {_SEG_MONETARY_HIGH_MIN_MINOR} THEN 'high_value' "
        f"WHEN {orders} = 1 AND {value} > 0 THEN 'first_time_buyer' "
        f"WHEN {value} = 0 THEN 'cart_abandoner' "
        f"ELSE 'window_shopper' END"
    )


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent table → optional source degrades to NULL
        return False


def _register_udfs(con) -> None:
    """Register the VENDORED pure scalars as DuckDB UDFs so the EXECUTED logic IS the unit-tested logic —
    the DuckDB analogue of the Spark job's F.udf(...) wrappers (customer_ref/aov/churn/lifecycle)."""
    # SQL type strings (this duckdb build has no duckdb.typing module). null_handling='special' so the
    # pure functions see Python None for NULL inputs and can return None (honest-empty), matching Spark.
    # null_handling='special' so each pure function sees Python None for a NULL input and can return None
    # (honest-empty) — matching Spark's UDF null semantics. These per-row scalar UDFs use numpy (a pinned
    # requirement of this tier, requirements.txt), which is how the golden-locked brain_ref encoding + the
    # unit-tested aov/churn/lifecycle scalars run byte-identically to the Spark UDFs (executed = tested).
    con.create_function("brain_ref_udf", brain_ref, ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("aov_minor_udf", aov_minor, ["BIGINT", "BIGINT"], "BIGINT", null_handling="special")
    con.create_function("churn_score_udf", churn_score_from_risk, ["VARCHAR"], "INTEGER", null_handling="special")
    con.create_function("lifecycle_stage_udf", lifecycle_stage, ["VARCHAR", "BIGINT"], "VARCHAR", null_handling="special")


def build(con):
    # brand-first tenant bucketing (mirrors the Spark bucket(8, brand_id) hidden partitioning).
    from _base import ensure_table  # noqa: E402 — imported here so the module imports without duckdb
    ensure_table(con, TARGET, COLUMNS_SQL)
    con.execute("INSTALL json; LOAD json;")  # to_json() for the journey_summary array assembly
    _register_udfs(con)

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ─────────────────────────
    #   GRAIN = entity_fold: the 360 emits exactly ONE row per (brand_id, brain_id), FROM the silver_customer
    #   spine, with the lifecycle rollup + all B2 enrichments folded on top via LEFT JOINs over each entity's
    #   FULL history (order_state / touchpoint / page_view / order_line — rows that may sit BELOW any
    #   watermark). Windowing those fold inputs directly would drop history → wrong lifetime/lifecycle money.
    #   So we window ONLY to DISCOVER which entities changed since the last run, using the SPINE's NOW-stamped
    #   write clock silver_customer.updated_at (bumped every time silver_customer re-folds a customer — i.e.
    #   exactly the customers whose 360 needs restating), then re-fold each changed entity over its FULL,
    #   UNWINDOWED history by semi-joining ONLY the spine driver `c` to the changed-key set. Because the output
    #   row set IS the spine row set, restricting the spine to changed customers restricts the output to
    #   changed entities while every enrichment LEFT JOIN still reads unwindowed. The MERGE on the PK
    #   (brand_id, brain_id) upserts exactly those restated rows. Gold flips INDEPENDENTLY of Silver via
    #   enabled=GOLD_INCREMENTAL. Default OFF / first run / FULL_REFRESH → lo=None → NO changed-set, NO
    #   semi-join → the SQL below is byte-identical to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-customer-360", SILVER_CUSTOMER, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over the
    # spine's write clock otherwise.
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    spine_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: spine customers whose updated_at moved within [lo, hi] — the entities whose 360 must be
    # restated. Same (brand_id, brain_id) key the fold/PK uses. Built ONLY when incremental (lo not None).
    changed = f"""
      SELECT DISTINCT brand_id, brain_id
      FROM {SILVER_CUSTOMER}
      WHERE 1=1{spine_window}
    """

    # Semi-join clause on the spine driver `c`: when incremental, restrict the spine to only the changed
    # entities so each 360 row re-folds its ENTIRE enrichment/lifecycle history. EMPTY string when lo is None
    # → unwindowed full recompute (byte-identical to before).
    spine_filter = (
        f"\n      WHERE (c.brand_id, c.brain_id) IN (SELECT brand_id, brain_id FROM ({changed}))"
        if lo is not None else ""
    )

    # ── lifecycle rollup: silver_order_state lifecycle_state CASE buckets (verbatim dbt/Spark). Absent
    #    order-state → empty → all counts coalesce to 0 (the LEFT-JOIN-on-missing behavior). ──
    if _table_exists(con, SILVER_ORDER_STATE):
        lifecycle = f"""
          SELECT
            brand_id, brain_id,
            CAST(sum(CASE WHEN lifecycle_state='delivered' THEN 1 ELSE 0 END) AS BIGINT) AS delivered_orders,
            CAST(sum(CASE WHEN lifecycle_state='rto'       THEN 1 ELSE 0 END) AS BIGINT) AS rto_orders,
            CAST(sum(CASE WHEN lifecycle_state='cancelled' THEN 1 ELSE 0 END) AS BIGINT) AS cancelled_orders,
            CAST(sum(CASE WHEN lifecycle_state='refunded'  THEN 1 ELSE 0 END) AS BIGINT) AS refunded_orders
          FROM {SILVER_ORDER_STATE}
          WHERE brain_id IS NOT NULL
          GROUP BY brand_id, brain_id
        """
    else:
        lifecycle = (
            "SELECT NULL::VARCHAR AS brand_id, NULL::VARCHAR AS brain_id, "
            "NULL::BIGINT AS delivered_orders, NULL::BIGINT AS rto_orders, "
            "NULL::BIGINT AS cancelled_orders, NULL::BIGINT AS refunded_orders WHERE FALSE"
        )

    # ── touchpoint-derived enrichment (resolved = stitched_brain_id NOT NULL). Absent → all NULL. ──
    has_tp = _table_exists(con, SILVER_TOUCHPOINT)
    if has_tp:
        # preferred_channel = deterministic MODE of channel: COUNT per value, ORDER BY count DESC, value ASC.
        preferred_channel = f"""
          SELECT brand_id, brain_id, channel AS preferred_channel FROM (
            SELECT brand_id, stitched_brain_id AS brain_id, channel,
                   row_number() OVER (PARTITION BY brand_id, stitched_brain_id
                                      ORDER BY count(*) DESC, channel ASC) AS _rk
            FROM {SILVER_TOUCHPOINT}
            WHERE stitched_brain_id IS NOT NULL AND channel IS NOT NULL AND channel <> ''
            GROUP BY brand_id, stitched_brain_id, channel
          ) WHERE _rk = 1
        """
        # acquisition_source = first-touch channel: is_first_touch DESC, occurred_at ASC, channel ASC.
        # NULLS ordering mirrors Spark's desc_nulls_last / asc_nulls_last.
        acquisition = f"""
          SELECT brand_id, brain_id, channel AS acquisition_source FROM (
            SELECT brand_id, stitched_brain_id AS brain_id, channel,
                   row_number() OVER (PARTITION BY brand_id, stitched_brain_id
                                      ORDER BY is_first_touch DESC NULLS LAST,
                                               occurred_at ASC NULLS LAST,
                                               channel ASC NULLS LAST) AS _rk
            FROM {SILVER_TOUCHPOINT}
            WHERE stitched_brain_id IS NOT NULL AND channel IS NOT NULL AND channel <> ''
          ) WHERE _rk = 1
        """
        last_activity = f"""
          SELECT brand_id, stitched_brain_id AS brain_id, max(occurred_at) AS last_activity_at
          FROM {SILVER_TOUCHPOINT}
          WHERE stitched_brain_id IS NOT NULL
          GROUP BY brand_id, stitched_brain_id
        """
        # bridge: (brand_id, brain_anon_id) → resolved brain_id, for the page_view device join.
        bridge = f"""
          SELECT DISTINCT brand_id, brain_anon_id, stitched_brain_id AS brain_id
          FROM {SILVER_TOUCHPOINT}
          WHERE stitched_brain_id IS NOT NULL AND brain_anon_id IS NOT NULL
        """
        # journey_summary = last 200 touchpoints as a JSON array; seq=1 most recent, array ordered by seq ASC.
        # Each entry mirrors the Spark struct field ORDER exactly (seq,ts,event_type,channel,page_type,
        # product_handle,order_id,is_first_touch) AND Spark's to_json(struct) null-field OMISSION: a nullable
        # member is DROPPED when null (not emitted as `null`). We reproduce that by conditionally
        # concatenating each nullable member, so the string is BYTE-identical to Spark. seq/ts/is_first_touch
        # are always present; ts = ISO-8601 UTC 'Z' (Spark date_format 'yyyy-MM-dd''T''HH:mm:ss''Z''). to_json
        # on each value handles JSON escaping + int/bool rendering identically. Array = '['||string_agg(...)||']'.
        journey_summary = f"""
          WITH ranked AS (
            SELECT brand_id, stitched_brain_id AS brain_id,
                   row_number() OVER (PARTITION BY brand_id, stitched_brain_id
                                      ORDER BY occurred_at DESC NULLS LAST, touch_seq DESC NULLS LAST) AS _seq,
                   occurred_at, event_type, channel, page_type, product_handle,
                   stitched_order_id AS order_id, is_first_touch
            FROM {SILVER_TOUCHPOINT}
            WHERE stitched_brain_id IS NOT NULL
          ),
          entries AS (
            SELECT brand_id, brain_id, _seq,
              '{{'
              || '"seq":'      || to_json(_seq)
              || ',"ts":'      || to_json(strftime(occurred_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ'))
              || CASE WHEN event_type     IS NOT NULL THEN ',"event_type":'     || to_json(event_type)     ELSE '' END
              || CASE WHEN channel        IS NOT NULL THEN ',"channel":'        || to_json(channel)        ELSE '' END
              || CASE WHEN page_type      IS NOT NULL THEN ',"page_type":'      || to_json(page_type)      ELSE '' END
              || CASE WHEN product_handle IS NOT NULL THEN ',"product_handle":' || to_json(product_handle) ELSE '' END
              || CASE WHEN order_id       IS NOT NULL THEN ',"order_id":'       || to_json(order_id)       ELSE '' END
              || ',"is_first_touch":' || to_json(is_first_touch)
              || '}}' AS _entry
            FROM ranked
            WHERE _seq <= {_JOURNEY_LIMIT}
          )
          SELECT brand_id, brain_id,
                 '[' || string_agg(_entry, ',' ORDER BY _seq ASC) || ']' AS journey_summary
          FROM entries
          GROUP BY brand_id, brain_id
        """
    else:
        preferred_channel = acquisition = last_activity = bridge = journey_summary = None

    # preferred_device = MODE of silver_page_view.device_class mapped via the touchpoint bridge.
    if has_tp and _table_exists(con, SILVER_PAGE_VIEW):
        preferred_device = f"""
          SELECT brand_id, brain_id, device_class AS preferred_device FROM (
            SELECT j.brand_id, j.brain_id, pv.device_class,
                   row_number() OVER (PARTITION BY j.brand_id, j.brain_id
                                      ORDER BY count(*) DESC, pv.device_class ASC) AS _rk
            FROM {SILVER_PAGE_VIEW} pv
            JOIN ({bridge}) j ON pv.brand_id = j.brand_id AND pv.brain_anon_id = j.brain_anon_id
            WHERE pv.device_class IS NOT NULL AND pv.device_class <> ''
            GROUP BY j.brand_id, j.brain_id, pv.device_class
          ) WHERE _rk = 1
        """
    else:
        preferred_device = None

    # top_category = MODE of silver_order_line.title per customer (bridged via silver_order_state order_id).
    if _table_exists(con, SILVER_ORDER_LINE) and _table_exists(con, SILVER_ORDER_STATE):
        top_category = f"""
          SELECT brand_id, brain_id, title AS top_category FROM (
            SELECT ob.brand_id, ob.brain_id, ol.title,
                   row_number() OVER (PARTITION BY ob.brand_id, ob.brain_id
                                      ORDER BY count(*) DESC, ol.title ASC) AS _rk
            FROM {SILVER_ORDER_LINE} ol
            JOIN (SELECT DISTINCT brand_id, order_id, brain_id FROM {SILVER_ORDER_STATE}
                  WHERE brain_id IS NOT NULL) ob
              ON ol.brand_id = ob.brand_id AND ol.order_id = ob.order_id
            WHERE ol.title IS NOT NULL AND ol.title <> ''
            GROUP BY ob.brand_id, ob.brain_id, ol.title
          ) WHERE _rk = 1
        """
    else:
        top_category = None

    # health derivation (DR-005): INLINED verbatim from the retired gold_customer_health.py — recency/
    # frequency facts from the order spine + the deterministic score/band, computed FRESH this tick.
    # (The old mart-fold read last tick's gold_customer_health — 360 sorts before it in the gold glob —
    # so health_band/churn_score were one tick stale; inlining kills both the staleness and two marts.
    # mv_gold_customer_health / mv_gold_customer_scores now project THIS mart.)
    if _table_exists(con, SILVER_ORDER_STATE):
        health = f"""
          SELECT brand_id, brain_id, frequency, last_order_at, recency_days,
                 CAST(
                   (CASE WHEN recency_days <= 30  THEN 60
                         WHEN recency_days <= 60  THEN 45
                         WHEN recency_days <= 90  THEN 30
                         WHEN recency_days <= 180 THEN 15
                         ELSE 0 END)
                   +
                   (CASE WHEN frequency >= 10 THEN 40
                         WHEN frequency >= 5  THEN 30
                         WHEN frequency >= 3  THEN 20
                         WHEN frequency >= 2  THEN 10
                         ELSE 5 END)
                 AS INTEGER)                                        AS health_score,
                 CASE WHEN recency_days <= 90  THEN 'healthy'
                      WHEN recency_days <= 180 THEN 'at_risk'
                      ELSE 'churned' END                            AS health_band
          FROM (
            SELECT brand_id, brain_id,
                   COUNT(DISTINCT order_id) AS frequency,
                   MAX(first_event_at)      AS last_order_at,
                   CAST(date_diff('day', CAST(MAX(first_event_at) AS DATE), current_date) AS INT) AS recency_days
            FROM {SILVER_ORDER_STATE}
            WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL
            GROUP BY brand_id, brain_id
          )
        """
    else:
        health = None

    # ── Assemble: spine LEFT JOIN lifecycle LEFT JOIN each optional enrichment on (brand_id, brain_id). ──
    # Each optional frame joins only when its source existed; otherwise the projection emits a typed NULL
    # (mirrors the Spark _col_or_null schema-stability: the row set is identical regardless of which
    # optional sources were present).
    joins = [f"LEFT JOIN ({lifecycle}) l ON c.brand_id = l.brand_id AND c.brain_id = l.brain_id"]

    def _join(alias, sql):
        if sql is not None:
            joins.append(
                f"LEFT JOIN ({sql}) {alias} ON c.brand_id = {alias}.brand_id AND c.brain_id = {alias}.brain_id"
            )

    _join("pc", preferred_channel)
    _join("pd", preferred_device)
    _join("tc", top_category)
    _join("ac", acquisition)
    _join("la", last_activity)
    _join("js", journey_summary)
    _join("hb", health)

    # Resolve the enrichment columns folded through UDFs, matching the Spark projection semantics:
    #  - last_activity_at = coalesce(max touchpoint activity, spine last_seen_at)
    #  - health_band / churn_score / lifecycle_stage via the VENDORED UDFs.
    la_expr = "COALESCE(la.last_activity_at, c.last_seen_at)" if last_activity else "c.last_seen_at"
    hb_expr = "hb.health_band" if health else "CAST(NULL AS VARCHAR)"
    hb_recency = "hb.recency_days" if health else "CAST(NULL AS INTEGER)"
    hb_freq = "hb.frequency" if health else "CAST(NULL AS BIGINT)"
    hb_score = "hb.health_score" if health else "CAST(NULL AS INTEGER)"
    hb_last = "hb.last_order_at" if health else "CAST(NULL AS TIMESTAMP)"
    # RFM/churn scoring (DR-005): INLINED verbatim from the retired gold_customer_scores.py — a pure
    # per-row projection off the spine (same thresholds; days from last_seen_at, Spark-arg-order flip).
    dslo = "date_diff('day', CAST(c.last_seen_at AS DATE), current_date)"
    churn_expr = (
        f"CASE WHEN {dslo} > 180 THEN 'high' WHEN {dslo} > 90 THEN 'medium' ELSE 'low' END"
    )

    # ── segment (ADR-0019 WS-3 D6): the canonical lifecycle-segment ladder computed ONCE here in the Gold
    #    pass (segment_case_sql — module-level so it is the single, testable source of truth), so
    #    getCustomerSegmentMembers filters on this column instead of re-deriving the ladder in TS. ──
    segment_expr = segment_case_sql(dslo, "c.lifetime_orders", "c.lifetime_value_minor")
    pc_expr = "pc.preferred_channel" if preferred_channel else "CAST(NULL AS VARCHAR)"
    pd_expr = "pd.preferred_device" if preferred_device else "CAST(NULL AS VARCHAR)"
    tc_expr = "tc.top_category" if top_category else "CAST(NULL AS VARCHAR)"
    ac_expr = "ac.acquisition_source" if acquisition else "CAST(NULL AS VARCHAR)"
    js_expr = "js.journey_summary" if journey_summary else "CAST(NULL AS VARCHAR)"

    join_sql = "\n      ".join(joins)
    staged = f"""
      SELECT
        c.brand_id,
        c.brain_id,
        brain_ref_udf(c.brain_id)                                       AS customer_ref,
        c.lifetime_orders,
        c.lifetime_value_minor,
        aov_minor_udf(c.lifetime_value_minor, c.lifetime_orders)        AS aov_minor,
        c.currency_code,
        c.first_seen_at,
        c.first_identified_at,
        c.last_seen_at,
        {la_expr}                                                       AS last_activity_at,
        COALESCE(l.delivered_orders, CAST(0 AS BIGINT))                 AS delivered_orders,
        COALESCE(l.rto_orders,       CAST(0 AS BIGINT))                 AS rto_orders,
        COALESCE(l.cancelled_orders, CAST(0 AS BIGINT))                 AS cancelled_orders,
        COALESCE(l.refunded_orders,  CAST(0 AS BIGINT))                 AS refunded_orders,
        {pc_expr}                                                       AS preferred_channel,
        {pd_expr}                                                       AS preferred_device,
        {tc_expr}                                                       AS top_category,
        {ac_expr}                                                       AS acquisition_source,
        {hb_expr}                                                       AS health_band,
        churn_score_udf({churn_expr})                                   AS churn_score,
        lifecycle_stage_udf({hb_expr}, c.lifetime_orders)              AS lifecycle_stage,
        {js_expr}                                                       AS journey_summary,
        {hb_recency}                                                    AS recency_days,
        {hb_freq}                                                       AS frequency,
        {hb_score}                                                      AS health_score,
        {hb_last}                                                       AS last_order_at,
        CAST({dslo} AS INTEGER)                                         AS days_since_last_order,
        CAST(CASE WHEN {dslo} <= 30 THEN 5 WHEN {dslo} <= 60 THEN 4
                  WHEN {dslo} <= 90 THEN 3 WHEN {dslo} <= 180 THEN 2
                  ELSE 1 END AS INTEGER)                                AS recency_score,
        CAST(CASE WHEN c.lifetime_orders >= 10 THEN 5 WHEN c.lifetime_orders >= 5 THEN 4
                  WHEN c.lifetime_orders >= 3 THEN 3 WHEN c.lifetime_orders >= 2 THEN 2
                  ELSE 1 END AS INTEGER)                                AS frequency_score,
        CAST(CASE WHEN c.lifetime_value_minor >= 10000000 THEN 5
                  WHEN c.lifetime_value_minor >= 5000000  THEN 4
                  WHEN c.lifetime_value_minor >= 1000000  THEN 3
                  WHEN c.lifetime_value_minor >= 200000   THEN 2
                  ELSE 1 END AS INTEGER)                                AS monetary_score,
        {churn_expr}                                                    AS churn_risk,
        {segment_expr}                                                  AS segment,
        c.customer_watermark,
        now() AT TIME ZONE 'UTC'                                        AS updated_at
      FROM {SILVER_CUSTOMER} c
      {join_sql}{spine_filter}
    """

    # Idempotent MERGE on the (brand_id, brain_id) PK — the spine yields one row per PK, so the in-batch
    # dedup order_by is a stable tie-break no-op. WHEN MATCHED UPDATE (a customer's 360 RESTATES when a new
    # order lands — the dbt incremental upsert), WHEN NOT MATCHED INSERT for a new customer.
    from _base import merge_on_pk  # noqa: E402
    n = merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at", "lifetime_orders"])

    # ── MERGE RE-VERSIONING: collapse any brain_id Neo4j fully merged away onto its survivor. dead =
    #    (brand_id, brain_id) present in the map interval history but with NO live current interval
    #    (is_current=true AND system_to IS NULL). Absent map → no-op. ──
    _reconcile_merged_away(con)
    return n


def _reconcile_merged_away(con) -> None:
    if not _table_exists(con, SILVER_IDENTITY_MAP):
        return
    # identity_raw = all interval rows; identity_current = is_current AND system_to IS NULL. dead = raw-only.
    con.execute(
        f"""
        DELETE FROM {TARGET} t
        WHERE (t.brand_id, t.brain_id) IN (
          SELECT DISTINCT brand_id, brain_id FROM {SILVER_IDENTITY_MAP}
          EXCEPT
          SELECT DISTINCT brand_id, brain_id FROM {SILVER_IDENTITY_MAP}
          WHERE is_current = TRUE AND system_to IS NULL
        )
        """
    )


if __name__ == "__main__":
    # The watermark tracks the spine's write clock (silver_customer.updated_at, NOW-stamped on each customer
    # re-fold), NOT the gated keystone default — this Gold job reads sibling Silver/Gold marts. Gold flips
    # independently of Silver (GOLD_INCREMENTAL).
    run_job("gold-customer-360", build, target_table="gold_customer_360",
            source_table=SILVER_CUSTOMER, ts_col="updated_at")
