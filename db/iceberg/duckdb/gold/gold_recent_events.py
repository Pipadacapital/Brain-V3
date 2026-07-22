"""
gold_recent_events.py (DuckDB) — ADR-0018 F4/D4: the pre-baked top-N recent-events RING that the
Tracking-Center Event Explorer reads instead of full-scanning + global-top-N-sorting the growing
Silver keystone on every cache-miss (the last single-query-ceiling violation on the operational
reads — get-recent-events.ts).

WHY (ADR-0018 F4): get-recent-events runs `... ORDER BY occurred_at DESC LIMIT 50` + per-row
json_extract over brain_serving.mv_silver_collector_event, a thin passthrough over the large,
growing, MERGE-churned keystone silver_collector_event. occurred_at has no sort order in the mart
and the table is month(kafka_timestamp)-partitioned, so DuckDB full-scans + global top-N sorts the
ENTIRE keystone per miss → 504s. This job does that expensive ROW_NUMBER() top-N ONCE per tick in
the TRANSFORM tier and overwrites a tiny result (a few thousand rows total across all brands); the
endpoint then reads a bounded ≤200-rows/brand table. Heavy compute in transform, serving reads a
pre-baked mart — the cheap-metadata doctrine get-medallion-journey established.

SOURCE : {CATALOG}.brain_silver.silver_collector_event read DIRECTLY (the admitted, deduped
  (brand_id, event_id) keystone; `payload` is the full Bronze envelope JSON). This is the SAME
  source + SAME lifted JSON paths get-recent-events.ts uses today, so the wire shape is unchanged.

GRAIN : (brand_id, event_id) — the newest 200 events per brand by occurred_at. PK = (brand_id,
  event_id). 200 not 50: the endpoint caps at 50 but filters pixel-only AFTER the read, so 200/brand
  guarantees ≥50 pixel rows survive the filter while staying trivially small. is_pixel is
  precomputed (event_type IN the pixel taxonomy) so the endpoint filters on a boolean column, not a
  string IN-list scan.

PII POSTURE (ADR-2 / I-S02): only type/time + ANONYMIZED ids are lifted (anon_id = a client-minted
  uuid, session_id = an opaque hash — never a customer identifier). `details_json` carries the raw
  `properties` object VERBATIM; the read side (get-recent-events.safeDetails) drops PII-KEYED and
  empty values before it ever leaves core — the battle-tested scrub stays where it is. The pixel
  never sends raw PII, and this mart never reconstructs any.

REPLAY-SAFE : full recompute of a bounded top-N window each run, idempotent MERGE on the
  (brand_id, event_id) PK with delete_orphans=True so a row that falls out of the newest-200 window
  is shed — the mart converges to EXACTLY the current top-200/brand (an OVERWRITE-of-tiny-result in
  merge_on_pk terms). Rides the existing */5 Gold tick (no new schedule); writes its own
  silver_job_watermark row so medallion-journey observability sees it.

NO money, NO currency_code (this surface carries none). NOT incremental (the top-N is inherently a
  full recompute of a bounded window — GOLD_INCREMENTAL is not consulted; delete_orphans is always
  safe here because the staged batch is the WHOLE truth, not a window subset).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_recent_events{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"

# Newest N events per brand. 200 (not the endpoint's 50 cap) so ≥50 PIXEL rows survive the endpoint's
# post-read pixel-only filter — still trivially small (few thousand rows across all brands, one file).
TOP_N = int(os.environ.get("RECENT_EVENTS_TOP_N", "200"))

# The PIXEL event taxonomy — MUST mirror packages ... _pixel-events.ts (PIXEL_EVENT_TYPES). Kept as a
# SQL IN-list literal so is_pixel is precomputed in the mart and the endpoint filters on a boolean.
PIXEL_EVENT_TYPES = [
    "page.viewed", "product.viewed", "collection.viewed", "search.submitted",
    "cart.item_added", "cart.item_removed", "cart.updated", "cart.viewed",
    "checkout.started", "checkout.step_viewed", "checkout.shipping_selected",
    "payment.initiated", "payment.succeeded", "payment.failed",
    "coupon.applied", "form.submitted", "order.placed",
    "rage.click", "dead.click", "element.clicked", "scroll.depth",
    "user.logged_in", "user.signed_up", "identify",
]
PIXEL_EVENT_IN = ", ".join(f"'{t}'" for t in PIXEL_EVENT_TYPES)

COLUMNS_SQL = """
  brand_id       string    NOT NULL,
  event_id       string    NOT NULL,
  event_type     string    NOT NULL,
  occurred_at    timestamp NOT NULL,
  ingested_at    timestamp,
  anon_id        string,
  session_id     string,
  has_consent    boolean   NOT NULL,
  details_json   string,
  is_pixel       boolean   NOT NULL,
  updated_at     timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "event_id", "event_type", "occurred_at", "ingested_at",
    "anon_id", "session_id", "has_consent", "details_json", "is_pixel", "updated_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    # The expensive top-N sort — done ONCE here in the transform tier (the whole point). Same JSON
    # paths get-recent-events.ts lifts today; details_json carries the raw properties object (the
    # read side scrubs PII keys). ROW_NUMBER over occurred_at DESC, event_id ASC as a deterministic
    # tiebreaker so ties don't churn the window between runs.
    staged = f"""
        WITH ranked AS (
            SELECT
                brand_id,
                event_id,
                event_type,
                occurred_at,
                ingested_at,
                json_extract_string(payload, '$.properties.brain_anon_id') AS anon_id,
                json_extract_string(payload, '$.hashed_session_id')        AS session_id,
                CASE WHEN json_extract_string(payload, '$.consent_flags.analytics') = 'true'
                     THEN true ELSE false END                               AS has_consent,
                json_extract(payload, '$.properties')                      AS details_json,
                (event_type IN ({PIXEL_EVENT_IN}))                          AS is_pixel,
                ROW_NUMBER() OVER (
                    PARTITION BY brand_id
                    ORDER BY occurred_at DESC, event_id ASC
                ) AS rn
            FROM {SOURCE}
            WHERE brand_id IS NOT NULL
              AND event_id IS NOT NULL
              AND event_type IS NOT NULL
              AND occurred_at IS NOT NULL
        )
        SELECT
            brand_id,
            event_id,
            event_type,
            occurred_at,
            ingested_at,
            anon_id,
            session_id,
            has_consent,
            CAST(details_json AS VARCHAR)      AS details_json,
            is_pixel,
            now() AT TIME ZONE 'UTC'           AS updated_at
        FROM ranked
        WHERE rn <= {TOP_N}
    """

    # delete_orphans=True: full recompute of the bounded top-N window ⇒ the staged batch is the WHOLE
    # truth (not an incremental subset), so shedding every PK no longer in the newest-200 is correct
    # and keeps the ring bounded (an OVERWRITE-of-tiny-result). occurred_at DESC is the dedup
    # tie-break (staged is already 1 row/PK — event_id is unique — so it is a stable no-op).
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["occurred_at"], delete_orphans=True)


if __name__ == "__main__":
    # Watermark tracks the keystone's arrival clock so medallion-journey observability sees this job.
    run_job("gold-recent-events", build, target_table="gold_recent_events",
            source_table=SOURCE, ts_col="ingested_at")
