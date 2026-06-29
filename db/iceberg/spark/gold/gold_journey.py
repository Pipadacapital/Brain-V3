"""
gold_journey.py — NET-NEW gap Gold `journey` INTELLIGENCE mart (Brain V4 Phase 2, GROUP "NEW gap Gold products").

NO dbt predecessor (parity status=NEW; matrix §3/4). The materialized JOURNEY-INTELLIGENCE rollup — one
row per (brand_id, brain_anon_id) summarizing each reconstructed visitor journey: how many touches, across
how many channels and sessions, when it started/ended, whether it converted, and how long conversion took.
This is the AGGREGATE serving mart the journey dashboard reads.

CRITICAL BOUNDARY: this is the INTELLIGENCE-SIDE rollup — DISTINCT from the identity-side journey
reconstruction (apps/core get-customer-360 graph stitch). It is a pure aggregate over the Silver journey
spine: NO money column (the journey entity carries no revenue — revenue truth stays in the order/settlement
marts), and NO raw or hashed PII — brain_anon_id is the opaque pseudonymous pixel id (the only identity key),
never an email/phone hash.

GRAIN   : 1 row per (brand_id, brain_anon_id). brain_anon_id is the journey/visitor key — the SAME key
          silver_journey / silver_touchpoint / silver_sessions are anchored on (brain_id/stitched_brain_id is
          sparse/mostly-NULL pre-stitch, so the honest journey grain is the anon visitor, never invented).
SOURCES : silver_journey      (the journey ENTITY: first/last touch, first/last channel, touch+session count,
                               converted flag — the deterministic spine),
          silver_touchpoint   (per-touch grain → distinct_channels + the conversion-touch timestamp),
          silver_sessions     (per-session grain → authoritative distinct_sessions via COUNT DISTINCT session_key).
COLUMNS :
  touchpoint_count   — total touches in the journey (silver_journey.touch_count).
  distinct_channels  — INT count of distinct deterministic channels the visitor arrived through.
  distinct_sessions  — distinct sessions (silver_sessions.session_key; falls back to silver_journey.session_count).
  first_channel /    — the deterministic first/last arrival channel (NEVER a model).
  last_channel
  first_touch_at /   — journey start/end (UTC).
  last_touch_at
  converted          — boolean: the visitor emitted a conversion event (payment.succeeded/order.placed/purchase.completed).
  converted_at       — timestamp of the FIRST conversion touch (NULL if not converted).
  days_to_convert    — INT whole days from first touch to first conversion (integer math; NULL if not converted).
REPLAY-SAFE: full recompute from Silver each run, MERGE-UPDATE'd on the (brand_id, brain_anon_id) PK.
NO MONEY (registered money_columns=[]). brand_id first column + bucket() partition anchor.
"""
from __future__ import annotations

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_journey"

# Conversion event set — byte-identical to silver_journey.CONVERSION_EVENTS (the spine's `converted` def).
CONVERSION_EVENTS_SQL = "'payment.succeeded', 'order.placed', 'purchase.completed'"

COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          brain_anon_id     string    NOT NULL,
          first_touch_at    timestamp NOT NULL,
          last_touch_at     timestamp NOT NULL,
          first_channel     string,
          last_channel      string,
          touchpoint_count  bigint    NOT NULL,
          distinct_channels int       NOT NULL,
          distinct_sessions bigint    NOT NULL,
          converted         boolean   NOT NULL,
          converted_at      timestamp,
          days_to_convert   int,
          updated_at        timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(64, brand_id), days(first_touch_at)"
    )

    staged = spark.sql(
        f"""
        WITH tp AS (
            -- Per-touch grain → distinct deterministic channels + the FIRST conversion-touch timestamp.
            SELECT
                brand_id,
                brain_anon_id,
                COUNT(DISTINCT channel)                                       AS distinct_channels,
                MIN(CASE WHEN event_type IN ({CONVERSION_EVENTS_SQL})
                         THEN occurred_at END)                                AS converted_at
            FROM {silver('silver_touchpoint')}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
            GROUP BY brand_id, brain_anon_id
        ),
        ss AS (
            -- Per-session grain → authoritative distinct session count (COUNT DISTINCT session_key).
            SELECT
                brand_id,
                brain_anon_id,
                COUNT(DISTINCT session_key)                                   AS distinct_sessions
            FROM {silver('silver_sessions')}
            WHERE brand_id IS NOT NULL AND brain_anon_id IS NOT NULL
            GROUP BY brand_id, brain_anon_id
        )
        SELECT
            j.brand_id,
            j.brain_anon_id,
            j.first_touch_at,
            j.last_touch_at,
            j.first_channel,
            j.last_channel,
            j.touch_count                                                     AS touchpoint_count,
            CAST(COALESCE(tp.distinct_channels, 0) AS INT)                    AS distinct_channels,
            COALESCE(ss.distinct_sessions, j.session_count)                   AS distinct_sessions,
            j.converted,
            -- conversion timestamp only when the spine flagged the journey converted (consistent basis).
            CASE WHEN j.converted THEN tp.converted_at ELSE NULL END          AS converted_at,
            -- whole days first-touch → first-conversion (integer math, NULL if not converted).
            CASE WHEN j.converted AND tp.converted_at IS NOT NULL
                 THEN CAST(DATEDIFF(CAST(tp.converted_at AS DATE),
                                    CAST(j.first_touch_at AS DATE)) AS INT)
                 ELSE NULL END                                               AS days_to_convert,
            current_timestamp()                                              AS updated_at
        FROM {silver('silver_journey')} j
        LEFT JOIN tp ON j.brand_id = tp.brand_id AND j.brain_anon_id = tp.brain_anon_id
        LEFT JOIN ss ON j.brand_id = ss.brand_id AND j.brain_anon_id = ss.brain_anon_id
        WHERE j.brand_id IS NOT NULL AND j.brain_anon_id IS NOT NULL
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "brain_anon_id"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-journey", build, entity_incremental={
        "table_name": "gold_journey", "source_tables": ["silver_journey", "silver_touchpoint", "silver_sessions"],
    })
