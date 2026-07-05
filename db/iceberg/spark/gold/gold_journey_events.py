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
  - brain_id = COALESCE(stitched_brain_id, CONCAT('anonymous_', brain_anon_id)) — the spec's
    anonymous placeholder for pre-stitch visitors (merges never target the anonymous_ namespace).

THE TRANSFORM (incremental via gold_partition_filter on silver_touchpoint.updated_at — brand-level
semi-join, so a changed brand's FULL timeline is restaged and sequence_number stays complete):
  - source = brain_silver.silver_touchpoint (grain brand_id, brain_anon_id, touch_seq);
  - sequence_number = row_number() over (partition by brand_id, brain_id order by occurred_at,
    touch_seq) — the resolved-identity timeline position;
  - identity_confidence = max(confidence) of the is_current=true brain_silver.silver_identity_map
    rows for (brand_id, brain_id); LEFT JOIN — NULL when unmapped/anonymous;
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
          is_composite        boolean,
          composite_order_key string,
          ingested_at         timestamp,
          updated_at          timestamp NOT NULL
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
    """_je_identity_conf = max is_current confidence per (brand_id, brain_id) from the bitemporal
    silver_identity_map (is_current=true ⇔ effective_to IS NULL). Empty view when the map is absent
    (pre-identity-export environments) so the LEFT JOIN degrades to NULL confidence."""
    if silver_exists(spark, "silver_identity_map"):
        spark.sql(
            f"""
            SELECT brand_id, brain_id, max(confidence) AS identity_confidence
            FROM {CATALOG}.{SILVER_NS}.silver_identity_map
            WHERE is_current = true
            GROUP BY brand_id, brain_id
            """
        ).createOrReplaceTempView("_je_identity_conf")
    else:
        spark.sql(
            "SELECT cast(null AS string) AS brand_id, cast(null AS string) AS brain_id, "
            "cast(null AS double) AS identity_confidence WHERE 1 = 0"
        ).createOrReplaceTempView("_je_identity_conf")


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
                brand_id,
                brain_anon_id,
                touch_seq,
                -- spec's anonymous placeholder: pre-stitch visitors get a stable anonymous_ brain_id
                coalesce(stitched_brain_id, concat('anonymous_', brain_anon_id)) AS brain_id,
                -- deterministic, rerun-stable touchpoint identity
                sha2(concat_ws('||', brand_id, brain_anon_id, cast(touch_seq AS string)), 256) AS touchpoint_id,
                concat_ws('||', brand_id, brain_anon_id, cast(touch_seq AS string)) AS source_event_ref,
                occurred_at,
                session_key,
                event_type,
                channel,
                utm_source, utm_medium, utm_campaign, utm_term, utm_content,
                fbclid, gclid, ttclid, msclkid, gbraid, wbraid, dclid,
                product_handle,
                coalesce(is_composite, false) AS is_composite,
                composite_order_key
            FROM _je_touchpoint
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL AND touch_seq IS NOT NULL
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
        )
        SELECT
            e.brand_id,
            e.brain_id,
            e.touchpoint_id,
            e.source_event_ref,
            cast(1 AS int) AS data_version,
            -- demote when a merge re-versioning already superseded v1 (never resurrect old identity)
            (x.max_ver IS NULL OR x.max_ver = 1) AS is_current,
            cast(row_number() OVER (
                PARTITION BY e.brand_id, e.brain_id
                ORDER BY e.occurred_at ASC, e.touch_seq ASC
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
            e.is_composite,
            e.composite_order_key,
            coalesce(p.ingested_at, current_timestamp()) AS ingested_at,
            current_timestamp() AS updated_at
        FROM e
        LEFT JOIN _je_identity_conf c
            ON c.brand_id = e.brand_id AND c.brain_id = e.brain_id
        LEFT JOIN _je_order o
            ON o.brand_id = e.brand_id AND e.is_composite = true
           AND o.order_id = e.composite_order_key
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

    _register_identity_confidence_view(spark)
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
