"""
gold_journey_events.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_journey_events.py.

The ADDITIVE **versioned event-sourced journey ledger** brain_gold.journey_events (Brain V4 spec gap G4 /
SPEC B.1 canonical journey generation). ONE row per (brand_id, touchpoint_id, data_version) — every
touchpoint of every journey re-keyed onto the RESOLVED identity (brain_id) and versioned so an identity
MERGE never rewrites history. Reads the sibling Silver Iceberg tables DIRECTLY (silver_touchpoint +
silver_identity_map + silver_order_state), NOT the gated collector keystone — exactly as the Spark job's
spark.table() reads. Writes {CATALOG}.brain_gold.journey_events (Spark TARGET_TABLE = "journey_events",
NOT "gold_journey_events") honoring MIGRATION_TABLE_SUFFIX.

PK / GRAIN (unchanged from Spark): (brand_id, touchpoint_id, data_version). touchpoint_id =
  sha256(brand_id||brain_anon_id||touch_seq) — stable across reruns (idempotent on identity). THIS job
  always stages data_version=1 (the as-constructed v1 mirror of Silver truth); is_current is DEMOTED to
  false only when a higher version already exists for the touchpoint (the companion reversion job's
  output — NOT ported here, so on a DuckDB-only catalog max_ver is always 1 → is_current always true).

IDENTITY-RESOLUTION INPUT SWITCH (SPEC B.1 / AMD-13 R1, per-brand `journey.engine` flag, DEFAULT OFF +
  FAIL-CLOSED): this port implements the LEGACY (flag-OFF) path ONLY — the byte-identical pre-wave
  resolution the Spark oracle was produced with (the flag is default-OFF and a Redis miss falls closed to
  OFF, so the 56854-row oracle is the flag-OFF construction). Concretely:
    - resolved stitch  = silver_touchpoint.stitched_brain_id (NOT the Wave-A v2 silver_session_identity);
    - brain_id         = COALESCE(stitched_brain_id, 'anonymous_' || brain_anon_id) — the anonymous_
                         placeholder for pre-stitch visitors (merges never target anonymous_);
    - sequence_number  = row_number() over (brand_id, brain_id) ORDER BY (occurred_at, touch_seq) — the
                         flag-OFF tie-break (session_id never participates);
    - matched_via      = DERIVED from the resolved brain_id's silver_identity_map identifier_type set
                         (identity_current), array_sort'd — empty array (never NULL) for anonymous_/unmapped.
  NO Redis / silver_session_identity read is performed (no flag-ON view registration) — see CAVEAT.

THE TRANSFORM (full corpus, no incremental watermark — the DuckDB parity discipline: one full pass ==
  the Spark FULL_REFRESH branch, byte-identical end-state; a per-brand gold_partition_filter is only a
  perf optimisation whose result set is identical):
  - source = brain_silver.silver_touchpoint (grain brand_id, brain_anon_id, touch_seq);
  - identity_confidence = max(confidence) of the valid-now+known-now silver_identity_map rows for
    (brand_id, brain_id), via the identity_current predicate (is_current AND system_to IS NULL); LEFT JOIN
    → NULL when unmapped/anonymous;
  - AS-OF identity (DG-2): brain_id_asof / identity_confidence_asof = the POINT-IN-TIME resolution AT
    occurred_at from the bi-temporal map intervals — the canonical interval-covering predicate
    (effective_from <= occurred_at AND (effective_to IS NULL OR occurred_at < effective_to)), v1 scope
    matched on the touchpoint's CURRENT resolved brain_id. NULL when no interval covers occurred_at;
  - event_category = brain_event_category(event_type) — the VENDORED pure _silver_technical.event_category
    (SoT mapping) as a DuckDB scalar UDF (analogue of Spark's spark.udf.register);
  - REVENUE TRUTH IS THE CONNECTOR ORDER: revenue_minor/currency_code stamped ONLY on composite
    transaction rows via LEFT JOIN silver_order_state on (brand_id, composite_order_key = order_id) —
    bigint MINOR units + sibling currency_code (never a float / blended); every other row NULL;
  - product_handles = single-element list of product_handle when set, else empty list;
    attribution_signals = MAP of the non-empty utm_* / click-id columns (map_filter equivalent);
  - campaign = utm_campaign; is_composite / composite_order_key pass through;
  - identity_basis = the constant 'deterministic' (SPEC 1.4 — the canonical ledger is deterministic-only).

SPARK→DUCKDB SQL TRANSLATIONS (parity-critical):
  - sha2(x, 256)                → sha256(x)              (both lowercase hex; verified byte-identical).
  - concat_ws('||', a, b, c)    → concat_ws('||', a, b, c).
  - array(x) / cast(array() ...) → [x] / CAST([] AS VARCHAR[]).
  - array_sort(...)             → list_sort(...).
  - map_filter(map(k1,v1,...), (k,v)->v IS NOT NULL AND v<>'')
        → map_from_entries(list_filter([{k,v},...], e -> e.v IS NOT NULL AND e.v <> '')).
  - current_timestamp()         → now() AT TIME ZONE 'UTC' (UTC session; the framework SETs TimeZone=UTC).
  - identity_current            → WHERE is_current = TRUE AND system_to IS NULL.

WRITE: idempotent MERGE via _base.merge_on_pk on PK (brand_id, touchpoint_id, data_version) — the Spark
  merge_on_pk (WHEN MATCHED UPDATE * / NOT MATCHED INSERT *) over a staged set that is already 1 row per
  PK, so the in-batch dedup order_by (updated_at, occurred_at) is a stable no-op tie-break. ingested_at is
  PRESERVED from the existing v1 row across reruns (first-materialized timestamp) via the first_ingest CTE.

QUARANTINE: none — this Gold ledger has no Stage-1/quarantine side-write (reads already-gated Silver); the
  DuckDB framework never writes a quarantine table either. Nothing to skip.

CAVEATS vs the Spark job (all parity-preserving on the flag-OFF oracle):
  - FLAG-OFF ONLY: the per-brand journey.engine Redis gate + the Wave-A v2 silver_session_identity input
    are NOT ported. The oracle is default-OFF, so this is byte-identical; a brand flipped ON in a live
    environment would diverge (different identity input) — that is an intentional scope boundary, not a bug.
  - FULL recompute (no gold_partition_filter watermark) — byte-identical end-state to the Spark
    FULL_REFRESH branch; the MERGE on the PK is idempotent.
  - composite_order_key: the Spark job synthesizes it from stitched_order_id when silver_touchpoint lacks
    the column (transitional seam). We reproduce that same fallback so the LEFT-JOIN revenue stamp matches.

Parity target: brain_gold.journey_events (56854 rows). PK (brand_id, touchpoint_id, data_version).
"""
from __future__ import annotations

import os
import sys

# The pure event_category helper is VENDORED into duckdb/gold/ (byte copy of the Spark-tree
# _silver_technical.event_category the Spark job imports) so the DuckDB tree is self-contained.
_HERE = os.path.dirname(os.path.abspath(__file__))
_DUCKDB_ROOT = os.path.dirname(_HERE)              # db/iceberg/duckdb
sys.path.insert(0, _DUCKDB_ROOT)
sys.path.insert(0, _HERE)                          # duckdb/gold — for the vendored pure module

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402
from _journey_events_pure import event_category  # noqa: E402 — vendored pure module (byte copy)

TABLE_NAME = "journey_events"  # Spark TARGET_TABLE — NOT "gold_journey_events".

_SUFFIX = os.environ.get("MIGRATION_TABLE_SUFFIX", "")
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE_NAME}{_SUFFIX}"

SILVER_TOUCHPOINT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
SILVER_IDENTITY_MAP = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_map"
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"

# MERGE key — brand_id FIRST (tenant), then the deterministic touchpoint identity + the version.
PK = ["brand_id", "touchpoint_id", "data_version"]

# Column contract — byte-for-byte the Spark _COLUMNS order/types. brand_id first (tenant key). Money =
# revenue_minor bigint MINOR units + sibling currency_code (never a float / DECIMAL).
COLUMNS_SQL = """
  brand_id            string NOT NULL,
  brain_id            string NOT NULL,
  touchpoint_id       string NOT NULL,
  source_event_ref    string,
  data_version        int NOT NULL,
  is_current          boolean NOT NULL,
  sequence_number     bigint,
  occurred_at         timestamp,
  session_key         int,
  event_category      string,
  event_type          string,
  channel             string,
  campaign            string,
  revenue_minor       bigint,
  currency_code       string,
  product_handles     string[],
  attribution_signals map(string, string),
  identity_confidence double,
  brain_id_asof       string,
  identity_confidence_asof double,
  is_composite        boolean,
  composite_order_key string,
  ingested_at         timestamp,
  updated_at          timestamp NOT NULL,
  matched_via         string[],
  identity_basis      string
""".strip("\n")

# Projected column order — MUST line up with COLUMNS_SQL and the Spark _COLUMNS order.
COLUMNS = [
    "brand_id", "brain_id", "touchpoint_id", "source_event_ref", "data_version", "is_current",
    "sequence_number", "occurred_at", "session_key", "event_category", "event_type", "channel",
    "campaign", "revenue_minor", "currency_code", "product_handles", "attribution_signals",
    "identity_confidence", "brain_id_asof", "identity_confidence_asof", "is_composite",
    "composite_order_key", "ingested_at", "updated_at", "matched_via", "identity_basis",
]


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent optional source degrades to NULL (honest-empty)
        return False


def _register_event_category_udf(con) -> None:
    """The SoT event_type → event_category mapping as a DuckDB scalar UDF — the analogue of the Spark
    job's spark.udf.register("brain_event_category", event_category, StringType()). null_handling='special'
    so the pure function sees Python None for a NULL event_type and returns 'other' (matching Spark)."""
    con.create_function(
        "brain_event_category", event_category, ["VARCHAR"], "VARCHAR", null_handling="special"
    )


def build(con):
    # brand-first tenant bucketing + day() partition (mirrors Spark bucket(8, brand_id), days(occurred_at)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(8, brand_id), day(occurred_at)")
    _register_event_category_udf(con)

    # composite_order_key transitional seam: if silver_touchpoint lacks the column, synthesize it from
    # stitched_order_id on composite rows (same semantics — the connector order the composite touch names).
    tp_cols = [r[0] for r in con.execute(f"DESCRIBE {SILVER_TOUCHPOINT}").fetchall()]
    if "composite_order_key" in tp_cols:
        composite_key_expr = "tp.composite_order_key"
    else:
        composite_key_expr = "CASE WHEN tp.is_composite THEN tp.stitched_order_id END"

    # identity_current confidence + matched_via_derived (flag-OFF provenance): max valid-now+known-now
    # confidence and the SORTED distinct identifier_type set backing the resolved brain_id. Absent map →
    # empty (LEFT JOIN degrades to NULL confidence / empty matched_via).
    if _table_exists(con, SILVER_IDENTITY_MAP):
        id_conf = f"""
          SELECT brand_id, brain_id,
                 max(confidence) AS identity_confidence,
                 list_sort(list(DISTINCT identifier_type)) AS matched_via_derived
          FROM {SILVER_IDENTITY_MAP}
          WHERE is_current = TRUE AND system_to IS NULL
          GROUP BY brand_id, brain_id
        """
        # AS-OF interval set (identity_asof full set: current + superseded) for the DG-2 covering join.
        id_asof_src = (
            f"SELECT brand_id, brain_id, confidence, effective_from, effective_to "
            f"FROM {SILVER_IDENTITY_MAP}"
        )
    else:
        id_conf = (
            "SELECT NULL::VARCHAR AS brand_id, NULL::VARCHAR AS brain_id, "
            "NULL::DOUBLE AS identity_confidence, CAST([] AS VARCHAR[]) AS matched_via_derived WHERE FALSE"
        )
        id_asof_src = (
            "SELECT NULL::VARCHAR AS brand_id, NULL::VARCHAR AS brain_id, NULL::DOUBLE AS confidence, "
            "NULL::TIMESTAMP AS effective_from, NULL::TIMESTAMP AS effective_to WHERE FALSE"
        )

    # revenue truth = the connector order. Empty view when absent → non-order envs degrade to NULL revenue.
    if _table_exists(con, SILVER_ORDER_STATE):
        order_src = (
            f"SELECT brand_id, order_id, order_value_minor, currency_code "
            f"FROM {SILVER_ORDER_STATE} WHERE order_id IS NOT NULL"
        )
    else:
        order_src = (
            "SELECT NULL::VARCHAR AS brand_id, NULL::VARCHAR AS order_id, "
            "NULL::BIGINT AS order_value_minor, NULL::VARCHAR AS currency_code WHERE FALSE"
        )

    staged = f"""
      WITH e AS (
        SELECT
          tp.brand_id,
          tp.brain_anon_id,
          tp.touch_seq,
          -- flag-OFF resolution: legacy silver_touchpoint.stitched_brain_id, then the anonymous_ placeholder.
          coalesce(tp.stitched_brain_id, concat('anonymous_', tp.brain_anon_id)) AS brain_id,
          -- deterministic, rerun-stable touchpoint identity (sha256 == Spark sha2(...,256)).
          sha256(concat_ws('||', tp.brand_id, tp.brain_anon_id, cast(tp.touch_seq AS VARCHAR))) AS touchpoint_id,
          concat_ws('||', tp.brand_id, tp.brain_anon_id, cast(tp.touch_seq AS VARCHAR)) AS source_event_ref,
          tp.occurred_at,
          tp.session_key,
          tp.event_type,
          tp.channel,
          tp.utm_source, tp.utm_medium, tp.utm_campaign, tp.utm_term, tp.utm_content,
          tp.fbclid, tp.gclid, tp.ttclid, tp.msclkid, tp.gbraid, tp.wbraid, tp.dclid,
          tp.product_handle,
          coalesce(tp.is_composite, false) AS is_composite,
          {composite_key_expr} AS composite_order_key
        FROM {SILVER_TOUCHPOINT} tp
        WHERE tp.brand_id IS NOT NULL AND tp.brain_anon_id IS NOT NULL AND tp.touch_seq IS NOT NULL
      ),
      existing AS (  -- highest version already materialized per touchpoint (reversion output; DuckDB → 1)
        SELECT brand_id, touchpoint_id, max(data_version) AS max_ver
        FROM {TARGET}
        GROUP BY brand_id, touchpoint_id
      ),
      first_ingest AS (  -- preserve the v1 first-materialized ingested_at across reruns
        SELECT brand_id, touchpoint_id, ingested_at
        FROM {TARGET}
        WHERE data_version = 1
      ),
      asof_cte AS (  -- DG-2 POINT-IN-TIME identity: the map interval that covered occurred_at (v1 scope:
                 -- intervals of the CURRENT resolved brain_id only). Canonical AS-OF covering predicate.
        SELECT
          e2.brand_id,
          e2.touchpoint_id,
          max(m.brain_id)   AS brain_id_asof,             -- all covering rows share e2.brain_id (v1 join key)
          max(m.confidence) AS identity_confidence_asof   -- multiple identifier types → deterministic max
        FROM e e2
        JOIN ({id_asof_src}) m
          ON m.brand_id = e2.brand_id
         AND m.brain_id = e2.brain_id
         AND m.effective_from <= e2.occurred_at
         AND (m.effective_to IS NULL OR e2.occurred_at < m.effective_to)
        GROUP BY e2.brand_id, e2.touchpoint_id
      )
      SELECT
        e.brand_id,
        e.brain_id,
        e.touchpoint_id,
        e.source_event_ref,
        CAST(1 AS INTEGER) AS data_version,
        -- demote when a merge re-versioning already superseded v1 (never resurrect old identity).
        (x.max_ver IS NULL OR x.max_ver = 1) AS is_current,
        -- SPEC B.1 — per-brain journey position, flag-OFF tie-break (occurred_at, touch_seq).
        CAST(row_number() OVER (
          PARTITION BY e.brand_id, e.brain_id
          ORDER BY e.occurred_at ASC, e.touch_seq ASC
        ) AS BIGINT) AS sequence_number,
        e.occurred_at,
        e.session_key,
        brain_event_category(e.event_type) AS event_category,
        e.event_type,
        e.channel,
        e.utm_campaign AS campaign,
        -- revenue truth is the CONNECTOR ORDER: stamped ONLY on composite transaction rows via the order
        -- join; every other touchpoint carries NULL money (bigint minor + sibling code).
        o.order_value_minor AS revenue_minor,
        o.currency_code AS currency_code,
        CASE WHEN e.product_handle IS NOT NULL AND trim(e.product_handle) <> ''
             THEN [e.product_handle]
             ELSE CAST([] AS VARCHAR[])
        END AS product_handles,
        -- map_filter(map(...), (k,v)->v IS NOT NULL AND v<>'') → filtered entry-list → map.
        map_from_entries(list_filter([
            {{'k': 'utm_source',   'v': e.utm_source}},
            {{'k': 'utm_medium',   'v': e.utm_medium}},
            {{'k': 'utm_campaign', 'v': e.utm_campaign}},
            {{'k': 'utm_term',     'v': e.utm_term}},
            {{'k': 'utm_content',  'v': e.utm_content}},
            {{'k': 'fbclid',       'v': e.fbclid}},
            {{'k': 'gclid',        'v': e.gclid}},
            {{'k': 'ttclid',       'v': e.ttclid}},
            {{'k': 'msclkid',      'v': e.msclkid}},
            {{'k': 'gbraid',       'v': e.gbraid}},
            {{'k': 'wbraid',       'v': e.wbraid}},
            {{'k': 'dclid',        'v': e.dclid}}
        ], entry -> entry.v IS NOT NULL AND entry.v <> '')) AS attribution_signals,
        c.identity_confidence,
        -- DG-2 AS-OF columns: NULL when no map interval covered occurred_at (event predates the identity,
        -- or the row is anonymous_/unmapped) — honest point-in-time resolution.
        af.brain_id_asof,
        af.identity_confidence_asof,
        e.is_composite,
        e.composite_order_key,
        coalesce(p.ingested_at, now() AT TIME ZONE 'UTC') AS ingested_at,
        now() AT TIME ZONE 'UTC' AS updated_at,
        -- flag-OFF matched_via: DERIVED from the map's identifier_type set (c). Empty array (never NULL)
        -- for anonymous_/unmapped rows. list_sort → deterministic reruns.
        coalesce(c.matched_via_derived, CAST([] AS VARCHAR[])) AS matched_via,
        -- SPEC 1.4 — the canonical journey ledger is DETERMINISTIC-ONLY.
        CAST('deterministic' AS VARCHAR) AS identity_basis
      FROM e
      LEFT JOIN ({id_conf}) c
        ON c.brand_id = e.brand_id AND c.brain_id = e.brain_id
      LEFT JOIN ({order_src}) o
        ON o.brand_id = e.brand_id AND e.is_composite = true
       AND o.order_id = e.composite_order_key
      LEFT JOIN asof_cte af
        ON af.brand_id = e.brand_id AND af.touchpoint_id = e.touchpoint_id
      LEFT JOIN existing x
        ON x.brand_id = e.brand_id AND x.touchpoint_id = e.touchpoint_id
      LEFT JOIN first_ingest p
        ON p.brand_id = e.brand_id AND p.touchpoint_id = e.touchpoint_id
    """

    # Idempotent MERGE on (brand_id, touchpoint_id, data_version). staged is already 1 row per PK, so the
    # in-batch dedup order_by is a stable no-op tie-break — the Spark merge_on_pk (UPDATE */INSERT *) shape.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at", "occurred_at"])


if __name__ == "__main__":
    run_job("gold-journey-events", build, target_table=TABLE_NAME)
