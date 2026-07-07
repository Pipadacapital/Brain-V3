"""
gold_journey_events.py — Brain V4 spec gap G4 (re-ratified): the ADDITIVE **versioned event-sourced
journey ledger** brain_gold.journey_events.

WHAT IT IS: one row per (brand_id, touchpoint_id, data_version) — every touchpoint of every journey,
re-keyed onto the RESOLVED identity (brain_id) and versioned so an identity MERGE never rewrites
history: a merge produces a NEW data_version owned by the canonical brain_id while the superseded
version survives with is_current=false (flipped by the companion job gold_journey_events_reversion.py).
The Trino serving view db/trino/views/mv_journey_events_current.sql projects WHERE is_current = true.

ADDITIVE / non-breaking: gold_journey_paths (path aggregate) and gold_journey (visitor rollup) are
DIFFERENT grains and stay untouched; this job repoints NO reader and writes ONLY
brain_gold.journey_events.

GRAIN + VERSIONING CONTRACT (event-sourced):
  - touchpoint_id = deterministic sha2-256 of brand_id||brain_anon_id||touch_seq — stable across
    reruns, so replays are idempotent on identity.
  - THIS job always stages data_version=1 (the as-constructed row, mirroring Silver truth). If the
    reversion job has already produced a higher version for a touchpoint (identity merge), the staged
    v1 row is DEMOTED to is_current=false so a construction re-run can never resurrect a superseded
    version. Rows are never deleted; is_current is the only mutable flag.
  - brain_id = COALESCE(<resolved_stitch>, CONCAT('anonymous_', brain_anon_id)) — the spec's
    anonymous placeholder for pre-stitch visitors (merges never target the anonymous_ namespace).

SPEC: B.1 — CANONICAL JOURNEY GENERATION (Wave B, per-brand flag `journey.engine`, DEFAULT OFF; AMD-13
R1 / AMD-11 R1). This construction job IS the canonical journey generator: it groups touchpoints by
(brand_id, brain_id) and assigns the per-brain journey position (sequence_number) — the versioned
event-sourced journey ledger. Two ADDITIVE, nullable columns extend the contract (create_iceberg_table
additive reconcile ALTERs them onto the live table): `matched_via array<string>` (the identity-link
provenance for the row's resolved brain_id) and `identity_basis` (always 'deterministic' — the canonical
table is deterministic-only per §1.4; the probabilistic overlay is a SEPARATE view, never this table).
IDENTITY-RESOLUTION INPUT SWITCH (AMD-13 R1, per-brand, default OFF):
  - flag OFF (legacy / pre-wave): resolved stitch = silver_touchpoint.stitched_brain_id; matched_via is
    DERIVED from the resolved brain_id's silver_identity_map identifier_type set (via identity_current);
    sequence tie-break = (occurred_at, touch_seq). Byte-identical to pre-wave on every pre-existing
    column (§1.9 invariant 8) — the two new columns are absent from the golden baseline snapshot.
  - flag ON: resolved stitch = the Wave-A v2 stitch `silver_session_identity` (joined on the session key
    concat(brain_anon_id,':',session_id_raw)); matched_via = that session's stitch `matched_via[]`; an
    unstitched session resolves to NO row → brain_id falls to the anonymous_ placeholder (journey-eligible
    only after re-stitch lifts it); sequence tie-break = (occurred_at, session_id, touch_seq).
The MERGE key is UNCHANGED — PK (brand_id, touchpoint_id, data_version); the journey-level version is a
DERIVED max(data_version) served as X-Journey-Version (AMD-11 R1), never a new PK column.

THE TRANSFORM (incremental via gold_partition_filter on silver_touchpoint.updated_at — brand-level
semi-join, so a changed brand's FULL timeline is restaged and sequence_number stays complete):
  - source = brain_silver.silver_touchpoint (grain brand_id, brain_anon_id, touch_seq);
  - sequence_number = row_number() over (partition by brand_id, brain_id order by occurred_at,
    touch_seq) — the resolved-identity timeline position;
  - identity_confidence = max(confidence) of the valid-now+known-now silver_identity_map rows for
    (brand_id, brain_id), read via the sanctioned identity_current accessor; LEFT JOIN — NULL when
    unmapped/anonymous;
  - AS-OF identity (DG-2, ADDITIVE v1): brain_id_asof / identity_confidence_asof = the
    POINT-IN-TIME resolution of the touchpoint AT occurred_at, from the bi-temporal
    silver_identity_map effective intervals. The canonical interval-covering predicate is the SAME
    one _snap_as_of/snap_identity_link prove: effective_from <= occurred_at AND (effective_to IS
    NULL OR occurred_at < effective_to). v1 SCOPE (deliberate, tractable): map rows are matched on
    (brand_id, brain_id = the row's CURRENT resolved brain_id) — i.e. "did the identity this
    touchpoint resolves to TODAY already own a covering interval when the event occurred?". If yes,
    brain_id_asof = that interval's brain_id and identity_confidence_asof = max(confidence) across
    the covering rows (multiple identifier types → deterministic max tiebreak). If NO interval
    covers occurred_at, BOTH stay NULL — honest: the event predates the identity (or the row is
    anonymous_/unmapped, which never appears in the map). v2 EXTENSION (not built here): walk the
    replaced_by_brain_id chain BACKWARDS so an event that occurred while a since-merged DEAD id
    owned the identifier resolves to that historical dead id instead of NULL;
  - event_category derives from event_type via the SAME categorization Silver uses —
    _silver_technical.event_category (the SoT mapping), registered as a Spark UDF;
  - REVENUE TRUTH IS THE CONNECTOR ORDER: touchpoints carry NO revenue. revenue_minor/currency_code
    are stamped ONLY on composite transaction rows via a LEFT JOIN to
    brain_silver.silver_order_state on (brand_id, composite_order_key = order_id) — bigint MINOR
    units + sibling currency_code (never a float, never blended); all other rows carry NULL;
  - product_handles = single-element array of product_handle when set (else empty array);
    attribution_signals = map of the non-empty utm_* / click-id columns (map_filter);
  - campaign = utm_campaign; is_composite / composite_order_key pass through.

WRITE: MERGE via _gold_base.merge_on_pk on PK (brand_id, touchpoint_id, data_version) — reruns are
idempotent (WHEN MATCHED refreshes the v1 mirror of Silver, WHEN NOT MATCHED inserts). ingested_at
is preserved from the existing v1 row so it stays the FIRST-materialized timestamp.

Run via run-gold-journey-events.sh (auto-discovered by tools/dev/v4-refresh-loop.sh, BI tier —
after identity/stitch). The reversion companion runs AFTER this job (run-gold-journey-reversion.sh
sorts after this script in the loop glob).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

_GOLD_DIR = os.path.dirname(os.path.abspath(__file__))
_SPARK_DIR = os.path.dirname(_GOLD_DIR)
sys.path.insert(0, _SPARK_DIR)                              # iceberg_base
sys.path.insert(0, _GOLD_DIR)                               # _gold_base
sys.path.insert(0, os.path.join(_SPARK_DIR, "silver"))      # _silver_technical (event_category SoT)

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.functions import expr  # noqa: E402
from pyspark.sql.types import StringType  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG  # noqa: E402
from _gold_base import (  # noqa: E402
    SILVER_NS,
    ensure_gold_table,
    gold_partition_filter,
    merge_on_pk,
    run_job,
    silver_exists,
)
# SPEC: A.2.2 — the ONLY sanctioned Spark reads of silver_identity_map (identity-view-guard allowlist).
from _identity_views import identity_asof, identity_current  # noqa: E402
# SPEC: B.1 / 0.5 / AMD-13 — per-brand journey.engine flag gate (Python twin of @brain/platform-flags).
from _platform_flags import is_flag_enabled, FLAG_JOURNEY_ENGINE  # noqa: E402
# The SAME event_type → event_category mapping Silver uses (silver_collector_event.event_category).
# Pure python (no Spark at import); shipped to workers by build_spark's addPyFile of every _*.py
# helper under silver/ + gold/, and by this job's run script --py-files.
from _silver_technical import event_category  # noqa: E402

TABLE_NAME = "journey_events"

# MERGE key — brand_id FIRST (tenant), then the deterministic touchpoint identity + the version.
PK = ["brand_id", "touchpoint_id", "data_version"]

# Column contract. brand_id first (tenant key). Money = revenue_minor bigint MINOR units + sibling
# currency_code (never a float / DECIMAL). Keep each column on ONE line — iceberg_base.
# _parse_column_defs splits on NEWLINES (so the commas inside map<…> are safe) and strips NOT NULL.
_COLUMNS = """
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
          product_handles     array<string>,
          attribution_signals map<string,string>,
          identity_confidence double,
          brain_id_asof       string,
          identity_confidence_asof double,
          is_composite        boolean,
          composite_order_key string,
          ingested_at         timestamp,
          updated_at          timestamp NOT NULL,
          matched_via         array<string>,
          identity_basis      string
""".strip("\n")


def _read_silver_touchpoint(spark: SparkSession):
    fqtn = f"{CATALOG}.{SILVER_NS}.silver_touchpoint"
    try:
        df = spark.table(fqtn)
        df.schema  # force resolution
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            raise SystemExit(
                f"[gold_journey_events] REQUIRED Iceberg table {fqtn} is absent — build the Phase-1 "
                f"silver_touchpoint Spark mart first (run-silver-touchpoint-sessions.sh)."
            )
        raise


def _register_identity_confidence_view(spark: SparkSession) -> None:
    """_je_identity_conf = per (brand_id, brain_id) from the bi-temporal identity map, read via the
    SANCTIONED accessor identity_current (is_current=true AND system_to IS NULL, A.2.2/AMD-07):
      - identity_confidence = max VALID-NOW+KNOWN-NOW confidence, and
      - matched_via_derived  = the SORTED distinct identifier_type set backing that brain_id — the B.1
        flag-OFF `matched_via` provenance (derived from silver_identity_map identifier_type per AMD-13 R1;
        flag-ON rows override this with the stitch's own matched_via[]).
    identity_current returns a correctly-shaped EMPTY frame when the map is absent, so the groupBy yields
    no rows and the downstream LEFT JOIN degrades to NULL confidence / empty matched_via — no explicit guard."""
    identity_current(spark).groupBy("brand_id", "brain_id").agg(
        F.max("confidence").alias("identity_confidence"),
        F.array_sort(F.collect_set("identifier_type")).alias("matched_via_derived"),
    ).createOrReplaceTempView("_je_identity_conf")


def _enabled_brands(spark: SparkSession, tp) -> "list[str]":
    """SPEC: B.1 / 0.5 / AMD-13 — the DISTINCT brands in the (already partition-filtered) touchpoint
    universe whose `journey.engine` flag is ON. Default-OFF + FAIL-CLOSED (a Redis miss → OFF → the brand
    keeps the legacy silver_touchpoint identity input). Driver-side only (no addPyFile needed)."""
    try:
        brands = [r["brand_id"] for r in tp.select("brand_id").distinct().collect() if r["brand_id"]]
    except Exception as exc:  # noqa: BLE001 — degrade to all-OFF (legacy path) on any read error
        print(f"[gold_journey_events] brand enumeration failed ({exc}); journey.engine treated OFF", flush=True)
        return []
    on = [b for b in brands if is_flag_enabled(b, FLAG_JOURNEY_ENGINE)]
    print(f"[gold_journey_events] journey.engine gate: {len(on)}/{len(brands)} brand(s) ON", flush=True)
    return on


def _register_flag_and_session_identity_views(spark: SparkSession, on_brands: "list[str]") -> None:
    """SPEC: B.1 / AMD-13 R1 — register the two flag-ON-only views the construction SQL LEFT JOINs:
      - _je_flag_on_brands(brand_id): the ON set; a NON-NULL match flips a row to the v2 stitch input.
      - _je_session_identity(brand_id, session_id, v2_brain_id, v2_matched_via): the Wave-A stitch v2
        table `silver_session_identity` restricted to ON brands (1 row per (brand_id, session_id) — its
        MERGE key — so the LEFT JOIN never fans a touchpoint out). Both are EMPTY when no brand is ON /
        the stitch table is absent → the SQL degrades to the byte-identical legacy path."""
    spark.createDataFrame(
        [(b,) for b in on_brands], "brand_id string"
    ).createOrReplaceTempView("_je_flag_on_brands")

    empty = (
        "SELECT cast(null AS string) AS brand_id, cast(null AS string) AS session_id, "
        "cast(null AS string) AS v2_brain_id, cast(array() AS array<string>) AS v2_matched_via WHERE 1 = 0"
    )
    if on_brands and silver_exists(spark, "silver_session_identity"):
        si = (
            spark.table(f"{CATALOG}.{SILVER_NS}.silver_session_identity")
            .where(F.col("brand_id").isin(on_brands))
            .select(
                F.col("brand_id"),
                F.col("session_id"),
                F.col("brain_id").alias("v2_brain_id"),
                F.coalesce(F.col("matched_via"), F.array().cast("array<string>")).alias("v2_matched_via"),
            )
        )
        si.createOrReplaceTempView("_je_session_identity")
    else:
        spark.sql(empty).createOrReplaceTempView("_je_session_identity")


def _register_identity_asof_view(spark: SparkSession) -> None:
    """_je_identity_asof = the FULL bi-temporal interval rows (current AND superseded) for the DG-2
    point-in-time (AS-OF) resolution — the interval-covering join against occurred_at happens in _build_sql.
    Read via the SANCTIONED accessor identity_asof(spark) (both bounds None = the full interval set,
    A.2.2/AMD-07). Empty-shaped frame when the map is absent so the AS-OF columns degrade to NULL."""
    identity_asof(spark).select(
        "brand_id", "brain_id", "confidence", "effective_from", "effective_to"
    ).createOrReplaceTempView("_je_identity_asof")


def _register_order_view(spark: SparkSession) -> None:
    """_je_order = the (brand_id, order_id) money truth from silver_order_state — bigint minor units
    + sibling currency_code. REVENUE TRUTH IS THE CONNECTOR ORDER (never the pixel), so this is the
    ONLY revenue source; empty view when absent so non-order environments degrade to NULL revenue."""
    if silver_exists(spark, "silver_order_state"):
        spark.sql(
            f"""
            SELECT brand_id, order_id, order_value_minor, currency_code
            FROM {CATALOG}.{SILVER_NS}.silver_order_state
            WHERE order_id IS NOT NULL
            """
        ).createOrReplaceTempView("_je_order")
    else:
        spark.sql(
            "SELECT cast(null AS string) AS brand_id, cast(null AS string) AS order_id, "
            "cast(null AS bigint) AS order_value_minor, cast(null AS string) AS currency_code "
            "WHERE 1 = 0"
        ).createOrReplaceTempView("_je_order")


def _build_sql(fqtn: str) -> str:
    """The full construction transform as one Spark SQL string (over the temp views registered in
    build). Always stages data_version=1; is_current is DEMOTED when the reversion job has already
    produced a higher version (x.max_ver > 1) so a construction re-run never resurrects a superseded
    version. ingested_at is preserved from the existing v1 row (first-materialized timestamp)."""
    return f"""
        WITH e AS (
            SELECT
                tp.brand_id,
                tp.brain_anon_id,
                tp.touch_seq,
                -- SPEC: B.1 / AMD-13 R1 — identity-resolution INPUT switch (per-brand flag, default OFF):
                --   flag ON  (fob matched) → the Wave-A v2 stitch silver_session_identity.brain_id;
                --   flag OFF (fob NULL)    → the legacy silver_touchpoint.stitched_brain_id.
                -- Both then COALESCE to the anonymous_ placeholder (unstitched → journey-eligible only
                -- after re-stitch). fob NULL for every OFF brand → byte-identical legacy resolution.
                coalesce(
                    CASE WHEN fob.brand_id IS NOT NULL THEN ssi.v2_brain_id ELSE tp.stitched_brain_id END,
                    concat('anonymous_', tp.brain_anon_id)
                ) AS brain_id,
                (fob.brand_id IS NOT NULL) AS journey_engine_on,
                -- the stable, brand-unique session key that maps a touch to its stitched session (B.1)
                concat_ws(':', tp.brain_anon_id, tp.session_id_raw) AS session_id,
                ssi.v2_matched_via AS v2_matched_via,
                -- deterministic, rerun-stable touchpoint identity
                sha2(concat_ws('||', tp.brand_id, tp.brain_anon_id, cast(tp.touch_seq AS string)), 256) AS touchpoint_id,
                concat_ws('||', tp.brand_id, tp.brain_anon_id, cast(tp.touch_seq AS string)) AS source_event_ref,
                tp.occurred_at,
                tp.session_key,
                tp.event_type,
                tp.channel,
                tp.utm_source, tp.utm_medium, tp.utm_campaign, tp.utm_term, tp.utm_content,
                tp.fbclid, tp.gclid, tp.ttclid, tp.msclkid, tp.gbraid, tp.wbraid, tp.dclid,
                tp.product_handle,
                coalesce(tp.is_composite, false) AS is_composite,
                tp.composite_order_key
            FROM _je_touchpoint tp
            -- flag-ON-only views (both EMPTY when no brand is ON / stitch absent → legacy path unchanged)
            LEFT JOIN _je_flag_on_brands fob
                ON fob.brand_id = tp.brand_id
            LEFT JOIN _je_session_identity ssi
                ON ssi.brand_id = tp.brand_id
               AND ssi.session_id = concat_ws(':', tp.brain_anon_id, tp.session_id_raw)
            WHERE tp.brand_id IS NOT NULL AND tp.brain_anon_id IS NOT NULL AND tp.touch_seq IS NOT NULL
        ),
        existing AS (  -- highest version already materialized per touchpoint (reversion output)
            SELECT brand_id, touchpoint_id, max(data_version) AS max_ver
            FROM {fqtn}
            GROUP BY brand_id, touchpoint_id
        ),
        first_ingest AS (  -- preserve the v1 first-materialized timestamp across reruns
            SELECT brand_id, touchpoint_id, ingested_at
            FROM {fqtn}
            WHERE data_version = 1
        ),
        asof AS (  -- DG-2 POINT-IN-TIME identity: the map interval that covered occurred_at.
            -- v1 scope (see module docstring): intervals of the CURRENT resolved brain_id only —
            -- no backwards replaced_by_brain_id chain walk (that is the v2 extension). The
            -- interval-covering predicate is the canonical AS-OF shape (_snap_as_of semantics).
            SELECT
                e2.brand_id,
                e2.touchpoint_id,
                max(m.brain_id) AS brain_id_asof,               -- all covering rows share e2.brain_id (v1 join key)
                max(m.confidence) AS identity_confidence_asof   -- multiple identifier types → deterministic max tiebreak
            FROM e e2
            JOIN _je_identity_asof m
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
            cast(1 AS int) AS data_version,
            -- demote when a merge re-versioning already superseded v1 (never resurrect old identity)
            (x.max_ver IS NULL OR x.max_ver = 1) AS is_current,
            -- SPEC: B.1 — per-brain journey position (journey_seq). Tie-break switches with the flag:
            --   flag OFF → (occurred_at, touch_seq)  [legacy — byte-identical];
            --   flag ON  → (occurred_at, session_id, touch_seq)  [spec tie-break (session_id, event_seq)].
            -- flag OFF makes the session_id key a constant NULL, which never reorders the legacy result.
            cast(row_number() OVER (
                PARTITION BY e.brand_id, e.brain_id
                ORDER BY e.occurred_at ASC,
                         CASE WHEN e.journey_engine_on THEN e.session_id END ASC,
                         e.touch_seq ASC
            ) AS bigint) AS sequence_number,
            e.occurred_at,
            e.session_key,
            brain_event_category(e.event_type) AS event_category,
            e.event_type,
            e.channel,
            e.utm_campaign AS campaign,
            -- revenue truth is the CONNECTOR ORDER: stamped ONLY on composite transaction rows via
            -- the order join below; every other touchpoint carries NULL money (bigint minor + code).
            o.order_value_minor AS revenue_minor,
            o.currency_code AS currency_code,
            CASE WHEN e.product_handle IS NOT NULL AND trim(e.product_handle) <> ''
                 THEN array(e.product_handle)
                 ELSE cast(array() AS array<string>)
            END AS product_handles,
            map_filter(
                map(
                    'utm_source', e.utm_source, 'utm_medium', e.utm_medium,
                    'utm_campaign', e.utm_campaign, 'utm_term', e.utm_term,
                    'utm_content', e.utm_content,
                    'fbclid', e.fbclid, 'gclid', e.gclid, 'ttclid', e.ttclid,
                    'msclkid', e.msclkid, 'gbraid', e.gbraid, 'wbraid', e.wbraid, 'dclid', e.dclid
                ),
                (k, v) -> v IS NOT NULL AND v <> ''
            ) AS attribution_signals,
            c.identity_confidence,
            -- DG-2 AS-OF columns: NULL when no map interval covered occurred_at (the event predates
            -- the identity, or the row is anonymous_/unmapped) — honest point-in-time resolution.
            af.brain_id_asof,
            af.identity_confidence_asof,
            e.is_composite,
            e.composite_order_key,
            coalesce(p.ingested_at, current_timestamp()) AS ingested_at,
            current_timestamp() AS updated_at,
            -- SPEC: B.1 / AMD-13 R1 — identity-link provenance for the resolved brain_id. flag ON → the
            -- stitch's own matched_via[]; flag OFF → DERIVED from the map's identifier_type set (c). Empty
            -- array (never NULL) for anonymous_/unmapped rows. array_sort → deterministic reruns.
            CASE WHEN e.journey_engine_on
                 THEN array_sort(coalesce(e.v2_matched_via, cast(array() AS array<string>)))
                 ELSE coalesce(c.matched_via_derived, cast(array() AS array<string>))
            END AS matched_via,
            -- SPEC: 1.4 — the canonical journey ledger is DETERMINISTIC-ONLY (probabilistic overlay is a
            -- separate view). identity_basis is the constant 'deterministic' on every canonical row.
            cast('deterministic' AS string) AS identity_basis
        FROM e
        LEFT JOIN _je_identity_conf c
            ON c.brand_id = e.brand_id AND c.brain_id = e.brain_id
        LEFT JOIN _je_order o
            ON o.brand_id = e.brand_id AND e.is_composite = true
           AND o.order_id = e.composite_order_key
        LEFT JOIN asof af
            ON af.brand_id = e.brand_id AND af.touchpoint_id = e.touchpoint_id
        LEFT JOIN existing x
            ON x.brand_id = e.brand_id AND x.touchpoint_id = e.touchpoint_id
        LEFT JOIN first_ingest p
            ON p.brand_id = e.brand_id AND p.touchpoint_id = e.touchpoint_id
    """


def build(spark: SparkSession):
    fqtn = ensure_gold_table(
        spark, TABLE_NAME, _COLUMNS, partitioned_by="bucket(8, brand_id), days(occurred_at)"
    )

    tp = _read_silver_touchpoint(spark)
    tp, _commit_wm = gold_partition_filter(
        spark, tp, table_name=TABLE_NAME, source_tables=["silver_touchpoint"],
    )
    if "composite_order_key" not in tp.columns:
        # Transitional seam: the sibling silver-canonicalization program adds composite_order_key to
        # silver_touchpoint. Until that column lands, the composite transaction row's order key is the
        # stitched order id (same semantics: the connector order the composite touch represents).
        tp = tp.withColumn(
            "composite_order_key",
            expr("CASE WHEN is_composite THEN stitched_order_id END"),
        )
    tp.createOrReplaceTempView("_je_touchpoint")

    # The SoT categorization (silver_collector_event.event_category via _silver_technical) as a UDF.
    spark.udf.register("brain_event_category", event_category, StringType())

    # SPEC: B.1 / 0.5 / AMD-13 — per-brand journey.engine gate (default OFF). The flag-ON brands switch
    # their identity-resolution input to the Wave-A v2 stitch (silver_session_identity); everyone else
    # keeps the legacy silver_touchpoint.stitched_brain_id input, byte-identical to pre-wave.
    on_brands = _enabled_brands(spark, tp)
    _register_flag_and_session_identity_views(spark, on_brands)

    _register_identity_confidence_view(spark)
    _register_identity_asof_view(spark)
    _register_order_view(spark)

    staged = spark.sql(_build_sql(fqtn))
    merge_on_pk(spark, fqtn, staged, PK)

    _commit_wm()  # advance the watermark only after the MERGE succeeded
    total = spark.table(fqtn).count()
    return fqtn, total


def main() -> None:
    run_job("gold-journey-events", build)


if __name__ == "__main__":
    main()
