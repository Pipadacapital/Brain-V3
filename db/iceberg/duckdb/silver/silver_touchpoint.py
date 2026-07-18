"""
silver_touchpoint.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_touchpoint.py.

The touchpoint SPINE read by silver_sessions / silver_journey / the UTM/channel surfaces: exactly ONE row
per (brand_id, brain_anon_id, touch_seq) — every engagement/pageview/marketing touch in journey order,
carrying the derived channel (utm→channel ladder), 30-min sessionization keys, first/last flags, referrer
host, the deterministic cart-stitch back-join, and the G5 cross-source composite flag.

THE FOLDED TRANSFORM CHAIN (dbt → Spark → DuckDB, inlined so this one job reproduces the whole pipeline):
  stg_touchpoint_events  — read the journey/behavioral event set from the gated keystone, type
                           payload.properties.* (brain_anon_id / session_id / utm / click_ids / page_type /
                           …), DROP rows with no brain_anon_id (cannot sessionize), dedup the Bronze
                           idempotency key (brand_id, event_id) keeping earliest occurred_at (ASC).
  int_touchpoint_sessionized — 30-min-inactivity sessionization (server-re-derived, replay-stable):
                           session_seq = running sum of the boundary flag; session_key =
                           sr_murmur_hash3_32(brand_id|brain_anon_id|session_seq); touch_seq = row_number
                           over the anon journey by (occurred_at ASC, event_id ASC); is_first/is_last;
                           the deterministic channel CASE ladder; the same-source composite lag() flag;
                           referrer_host extraction.
  silver_touchpoint      — LEFT JOIN the deterministic cart-stitch map (read-back, never inferred — D-5) +
                           the 400-day TTL/partition-window guard.
  G5 cross-source composite — additive flag-only LEFT JOIN to silver_order_state: a pixel purchase-class
                           touchpoint that names the SAME connector order ($.properties.order_id) within
                           60s is flagged is_composite + composite_order_key (no row removal, no fan-out —
                           silver_order_state grain is exactly 1 row/(brand_id, order_id)).

GRAIN : exactly 1 row per (brand_id, brain_anon_id, touch_seq). PK = those three columns.
NO MONEY: touchpoints are not monetary — there is NO money column (dbt asserts the same). Only
  hashed/anon identifiers ride through (brain_anon_id is an opaque pixel anon id, never raw PII).
ISOLATION: brand_id first + bucket() partition anchor.
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, brain_anon_id, touch_seq) — re-run yields identical rows.

ENTITY-INCREMENTAL → ONE FULL PASS (parity note): the Spark job is entity-incremental (re-fold only the
  visitors with new events, hash-bucketed for memory), but a single build pass with no watermark == the
  Spark FULL_REFRESH branch (re-fold ALL visitors). This DuckDB port is that single full pass: it reads the
  ENTIRE gated event set once and sessionizes every visitor's full history in one shot — the window
  functions run over the whole corpus, so session_seq / touch_seq / first-last are complete and never
  mis-split. The result set is identical to the Spark FULL_REFRESH output; there is no bucketing to
  reproduce because DuckDB folds the corpus in one process.

session_key PARITY (verbatim): dbt's chain computes session_key = murmur_hash3_32(concat_ws('|', brand_id,
  brain_anon_id, cast(session_seq as string))) on StarRocks — MurmurHash3 x86 32-bit over the UTF-8 bytes,
  SEED 104729, returned signed (StarRocks INT). Neither DuckDB nor Spark has a byte-matching builtin, so
  both register the exact reference algorithm as a UDF (sr_murmur_hash3_32) — here the SAME _murmur3_x86_32
  vendored verbatim from the Spark job, exposed via con.create_function → byte-identical session_key.

CART-STITCH (silver_journey_stitch): the Spark job LEFT JOINs the stitch map read from PG
  ops.silver_journey_stitch (no Iceberg sibling exists — it is a PG-operational table), with a try/except →
  None fallback (stitch → NULL) when the export is absent. This port mirrors that exactly via the DuckDB
  postgres extension: attach ops.silver_journey_stitch when reachable → 198-row stitch join (dbt parity);
  on failure (PG down) → stitch NULL, dbt parity when the stitch map has 0 rows. See the module-level
  CAVEAT: when PG is unreachable the stitched_order_id / stitched_brain_id columns diverge from a Spark
  oracle that WAS produced with PG up — that is an environmental (source-availability) divergence, NOT a
  code bug; every Bronze-deterministic column stays byte-identical.

STAGE-1 GATE / QUARANTINE (SKIPPED — same as every other ported job): the Spark job routes the no-anon
  drop and the future/unparseable-timestamp dq rejects to brain_silver.silver_quarantine (stage='dq'). This
  DuckDB framework has NO quarantine side-write — the rejects become plain WHERE filters, so the ADMITTED
  set (and dbt parity) is unchanged; only the observable quarantine ledger is not written. Bronze keeps
  every original (replay-safe).

Parity target: brain_silver.silver_touchpoint (56854 rows on the current corpus).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import (  # noqa: E402
    GATED_SOURCE,
    ensure_table,
    incremental_window,
    merge_on_pk,
    read_gated_events_sql,
    run_job,
)
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write to silver_touchpoint_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"  # ADR-0006 P3 gated keystone
ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"  # G5 cross-source composite spine

# The journey/behavioral event set stg_touchpoint_events.sql admits from Bronze (verbatim).
TOUCHPOINT_EVENT_TYPES = [
    "page.viewed", "product.viewed", "collection.viewed", "cart.viewed", "cart.item_added",
    "cart.item_removed", "cart.updated", "search.submitted", "checkout.started",
    "checkout.step_viewed", "checkout.shipping_selected", "payment.initiated", "payment.succeeded",
    "payment.failed", "order.placed", "purchase.completed", "coupon.applied", "form.submitted",
    "user.logged_in", "user.signed_up", "identify", "scroll.depth", "element.clicked",
    "rage.click", "dead.click",
]

# StarRocks murmur_hash3_32 seed (verified in the Spark module docstring). x86 32-bit over UTF-8 bytes.
MURMUR_SEED = int(os.environ.get("MURMUR_HASH3_SEED", "104729"))

# Same-source composite class rlike (transaction-type events) — the DuckDB `regexp_matches` equivalent of
# Spark's `rlike`, ONE definition shared by the same-source lag() rule AND the G5 cross-source join so the
# two classes can never drift. NOTE: '.' matches any char (Spark rlike semantics — 'order_placed' matches
# via 'order[._]', 'checkout.completed' etc. — literal-dot vs any-dot is behaviorally identical here).
TRANSACTION_EVENT_RLIKE = r"(^order[._]|order_placed|purchase|checkout.completed|payment.(succeeded|captured))"
COMPOSITE_ORDER_WINDOW_SECONDS = 60

# Mirrors silver_touchpoint.sql column order/types (StarRocks: varchar/bigint/int/boolean/datetime).
COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  brain_anon_id       string    NOT NULL,
  touch_seq           bigint    NOT NULL,
  session_key         int,
  session_seq         bigint,
  is_first_touch      boolean,
  is_last_touch       boolean,
  occurred_at         timestamp,
  event_type          string,
  channel             string,
  utm_source          string,
  utm_medium          string,
  utm_campaign        string,
  utm_term            string,
  utm_content         string,
  fbclid              string,
  gclid               string,
  ttclid              string,
  msclkid             string,
  gbraid              string,
  wbraid              string,
  dclid               string,
  referrer_host       string,
  landing_path        string,
  page_type           string,
  product_handle      string,
  collection_handle   string,
  search_query        string,
  stitched_order_id   string,
  stitched_brain_id   string,
  is_synthetic        boolean,
  is_composite        boolean,
  composite_order_key string,
  session_id_raw      string,
  updated_at          timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_anon_id", "touch_seq", "session_key", "session_seq", "is_first_touch",
    "is_last_touch", "occurred_at", "event_type", "channel", "utm_source", "utm_medium",
    "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "ttclid", "msclkid", "gbraid",
    "wbraid", "dclid", "referrer_host", "landing_path", "page_type", "product_handle",
    "collection_handle", "search_query", "stitched_order_id", "stitched_brain_id", "is_synthetic",
    "is_composite", "composite_order_key", "session_id_raw", "updated_at",
]

# PG stitch source (ops.silver_journey_stitch) — attached via the DuckDB postgres extension when reachable.
PG_HOST = os.environ.get("SILVER_PG_HOST", "localhost")
PG_PORT = os.environ.get("SILVER_PG_PORT", "5432")
PG_DB = os.environ.get("SILVER_PG_DB", "brain")
PG_USER = os.environ.get("SILVER_PG_USER", "brain")
PG_PASSWORD = os.environ.get("SILVER_PG_PASSWORD", "brain")


# ── MurmurHash3 x86 32-bit — vendored VERBATIM from the Spark job (PURE helper, no pyspark deps) ──────────
def _murmur3_x86_32(data: bytes, seed: int) -> int:
    """MurmurHash3 x86 32-bit over the raw bytes (reference impl) — matches StarRocks murmur_hash3_32."""
    c1 = 0xCC9E2D51
    c2 = 0x1B873593
    length = len(data)
    h1 = seed & 0xFFFFFFFF
    rounded_end = length & ~0x3
    for i in range(0, rounded_end, 4):
        k1 = (
            (data[i] & 0xFF)
            | ((data[i + 1] & 0xFF) << 8)
            | ((data[i + 2] & 0xFF) << 16)
            | ((data[i + 3] & 0xFF) << 24)
        )
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = ((k1 << 15) | (k1 >> 17)) & 0xFFFFFFFF
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1
        h1 = ((h1 << 13) | (h1 >> 19)) & 0xFFFFFFFF
        h1 = (h1 * 5 + 0xE6546B64) & 0xFFFFFFFF
    k1 = 0
    tail = length & 0x3
    if tail == 3:
        k1 ^= (data[rounded_end + 2] & 0xFF) << 16
    if tail >= 2:
        k1 ^= (data[rounded_end + 1] & 0xFF) << 8
    if tail >= 1:
        k1 ^= data[rounded_end] & 0xFF
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = ((k1 << 15) | (k1 >> 17)) & 0xFFFFFFFF
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1
    h1 ^= length
    h1 ^= h1 >> 16
    h1 = (h1 * 0x85EBCA6B) & 0xFFFFFFFF
    h1 ^= h1 >> 13
    h1 = (h1 * 0xC2B2AE35) & 0xFFFFFFFF
    h1 ^= h1 >> 16
    return h1


def _sr_murmur_hash3_32(s):
    """sr_murmur_hash3_32(str) → signed 32-bit int, byte-identical to StarRocks murmur_hash3_32."""
    if s is None:
        return None
    u = _murmur3_x86_32(s.encode("utf-8"), MURMUR_SEED)
    return u - 0x100000000 if u >= 0x80000000 else u  # to signed 32-bit (StarRocks INT)


def _register_murmur_udf(con) -> None:
    con.create_function(
        "sr_murmur_hash3_32", _sr_murmur_hash3_32, ["VARCHAR"], "INTEGER", null_handling="special"
    )


def prop(path: str) -> str:
    """payload.properties.<path> as a string (get_json_object(pj,'$.properties.…') equivalent)."""
    return f"json_extract_string(pj, '$.properties.{path}')"


def _attach_stitch(con):
    """Attach ops.silver_journey_stitch via the DuckDB postgres extension when reachable.

    Mirrors the Spark _read_stitch try/except → None: returns True (stitch view registered) when PG is up,
    False (stitch → NULL, dbt parity when 0 stitch rows) when the export is absent/unreachable."""
    try:
        con.execute("INSTALL postgres; LOAD postgres;")
        # On the shared warm connection (run_all single-process / resident tick) a sibling silver job may
        # already have ATTACHed _pg to the SAME operational Postgres. A second ATTACH raises "database _pg
        # already exists" — which the except below would misread as "PG unreachable" and wrongly degrade
        # stitch to NULL (dropping the journey-stitch join every single-process run). Attach only when the
        # alias is absent; otherwise reuse the live handle (same host/db, READ_ONLY read either way).
        attached = con.execute(
            "SELECT count(*) FROM duckdb_databases() WHERE database_name = '_pg'"
        ).fetchone()[0]
        if not attached:
            con.execute(
                f"ATTACH 'host={PG_HOST} port={PG_PORT} dbname={PG_DB} user={PG_USER} "
                f"password={PG_PASSWORD}' AS _pg (TYPE postgres, READ_ONLY);"
            )
        # Deterministic 1-row-per-(brand_id, stitched_anon_id) pick (created_at ASC, order_id ASC) —
        # the exact stitch_one dedup the Spark build() registers once.
        con.execute(
            """
            CREATE OR REPLACE TEMP VIEW stitch_one AS
            SELECT brand_id, stitched_anon_id, order_id, stitched_brain_id FROM (
              SELECT brand_id, stitched_anon_id, order_id, brain_id AS stitched_brain_id,
                     row_number() OVER (
                       PARTITION BY brand_id, stitched_anon_id ORDER BY created_at ASC, order_id ASC
                     ) AS _rn
              FROM _pg.ops.silver_journey_stitch
            ) WHERE _rn = 1;
            """
        )
        n = con.execute("SELECT count(*) FROM stitch_one").fetchone()[0]
        print(f"[silver_touchpoint] stitch attached: ops.silver_journey_stitch → {n} row(s)", flush=True)
        return True
    except Exception as exc:  # noqa: BLE001 — PG absent → stitch NULL (dbt parity when 0 stitch rows)
        print(f"[silver_touchpoint] silver_journey_stitch unavailable ({str(exc)[:120]}); stitch → null", flush=True)
        return False


def _order_state_available(con) -> bool:
    try:
        con.execute(
            f"""
            CREATE OR REPLACE TEMP VIEW order_state_one AS
            SELECT brand_id, order_id, state_effective_at, first_event_at FROM {ORDER_STATE};
            """
        )
        return True
    except Exception as exc:  # noqa: BLE001 — mart absent (cold-start ordering) → same-source flag only
        print(f"[silver_touchpoint] silver_order_state unavailable ({str(exc)[:120]}); same-source composite only", flush=True)
        return False


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")
    _register_murmur_udf(con)
    has_stitch = _attach_stitch(con)
    has_order = _order_state_available(con)

    in_list = ", ".join(f"'{e}'" for e in TOUCHPOINT_EVENT_TYPES)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) — GRAIN = entity_fold (CHANGED-ENTITY REFOLD) ──
    #   silver_touchpoint sessionizes MANY source rows into ONE row per (brand_id, brain_anon_id, touch_seq)
    #   via lag()/row_number() windows OVER the whole anon journey. session_seq / touch_seq / first-last of a
    #   visitor depend on events that may sit BELOW the watermark, so we must NEVER window the fold input
    #   directly (that would silently drop history → mis-split sessions / wrong touch_seq). Instead: use the
    #   [lo, hi) window ONLY to discover which VISITORS have new touchpoint events, then re-fold each such
    #   visitor's FULL history via a semi-join on the entity key. Default OFF (lo=None) → NO changed-set / NO
    #   semi-join → byte-identical full recompute. Source IS the gated keystone → ts_col=ingested_at.
    lo, hi = incremental_window(con, "silver-touchpoint", GATED_SOURCE, ts_col="ingested_at")

    # Changed-visitor set: the SAME entity-key derivation (brain_anon_id from payload) + the SAME
    # not-null/'' guard the fold's Stage-1 gate applies, over a WINDOWED read of the gated keystone. Empty
    # string ("" when lo is None) → no changed-set materialized, no semi-join emitted below.
    changed_cte = ""
    changed_semijoin = ""
    if lo is not None:
        windowed_src = read_gated_events_sql(
            TOUCHPOINT_EVENT_TYPES, lo=lo, hi=hi, source=SOURCE
        )
        changed_cte = f"""
          changed AS (
            SELECT DISTINCT brand_id, {prop('brain_anon_id')} AS brain_anon_id
            FROM ({windowed_src})
            WHERE {prop('brain_anon_id')} IS NOT NULL AND {prop('brain_anon_id')} <> ''
          ),
        """
        # Re-fold ONLY changed visitors over their FULL (unwindowed) history. `raw` already has a WHERE, so
        # this is an "AND (...)". Carries its OWN leading newline+indent so the EMPTY case (lo is None) adds
        # ZERO bytes → the stg SQL is byte-identical to the pre-incremental full scan.
        changed_semijoin = (
            "\n        AND (brand_id, json_extract_string(payload, '$.properties.brain_anon_id')) "
            "IN (SELECT brand_id, brain_anon_id FROM changed)"
        )

    # ── stg_touchpoint_events: type payload.properties.*, structural PK guard, Stage-1 anon drop, dedup ──
    # The Stage-1 empty_identifier drop + dq drop are plain filters here (quarantine side-write SKIPPED —
    # admitted set unchanged). Dedup keeps EARLIEST occurred_at (ASC) — the exact dbt/Spark stg dedup.
    stg = f"""
      WITH {changed_cte}raw AS (
        SELECT brand_id, event_id, event_type, occurred_at, payload AS pj
        FROM {SOURCE}
        WHERE event_type IN ({in_list}){changed_semijoin}
      ),
      typed AS (
        SELECT
          brand_id, event_id, event_type, occurred_at,
          {prop('brain_anon_id')}       AS brain_anon_id,
          {prop('session_id')}          AS session_id_raw,
          {prop('utm.source')}          AS utm_source,
          {prop('utm.medium')}          AS utm_medium,
          {prop('utm.campaign')}        AS utm_campaign,
          {prop('utm.term')}            AS utm_term,
          {prop('utm.content')}         AS utm_content,
          {prop('click_ids.fbclid')}    AS fbclid,
          {prop('click_ids.gclid')}     AS gclid,
          {prop('click_ids.ttclid')}    AS ttclid,
          {prop('click_ids.msclkid')}   AS msclkid,
          {prop('click_ids.gbraid')}    AS gbraid,
          {prop('click_ids.wbraid')}    AS wbraid,
          {prop('click_ids.dclid')}     AS dclid,
          {prop('referrer')}            AS referrer,
          {prop('landing_path')}        AS landing_path,
          {prop('page_type')}           AS page_type,
          {prop('product_handle')}      AS product_handle,
          {prop('collection_handle')}   AS collection_handle,
          {prop('query')}               AS search_query,
          {prop('order_id')}            AS tp_order_id,
          CASE WHEN {prop('_synthetic')} = 'true' THEN true ELSE false END AS is_synthetic
        FROM raw
        WHERE brand_id IS NOT NULL AND event_id IS NOT NULL            -- structural PK guard
      ),
      gated AS (
        SELECT * FROM typed
        WHERE brain_anon_id IS NOT NULL AND brain_anon_id <> ''        -- Stage-1 empty_identifier drop
          AND occurred_at IS NOT NULL                                  -- Stage-1 dq: unparseable_timestamp
          AND occurred_at <= now() + INTERVAL 5 MINUTE                 -- Stage-1 dq: future_occurred_at (5-min skew)
      )
      SELECT
        brand_id, event_id, event_type, occurred_at, brain_anon_id, session_id_raw,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        fbclid, gclid, ttclid, msclkid, gbraid, wbraid, dclid,
        referrer, landing_path, page_type, product_handle, collection_handle,
        search_query, tp_order_id, is_synthetic
      FROM (
        SELECT *, row_number() OVER (
          PARTITION BY brand_id, event_id ORDER BY occurred_at ASC
        ) AS _dedup_rn
        FROM gated
      ) WHERE _dedup_rn = 1
    """

    # ── int_touchpoint_sessionized: 30-min sessionization + channel ladder + first/last + composite flag ──
    sessionized = f"""
      WITH stg AS ({stg}),
      boundaries AS (
        SELECT *, lag(occurred_at) OVER (
          PARTITION BY brand_id, brain_anon_id ORDER BY occurred_at ASC
        ) AS prev_occurred_at
        FROM stg
      ),
      flagged AS (
        SELECT *,
          CASE
            WHEN prev_occurred_at IS NULL THEN 1
            WHEN (CAST(epoch(occurred_at) AS BIGINT) - CAST(epoch(prev_occurred_at) AS BIGINT)) > 1800 THEN 1
            ELSE 0
          END AS is_session_start
        FROM boundaries
      ),
      sessionized AS (
        SELECT *,
          sum(is_session_start) OVER (
            PARTITION BY brand_id, brain_anon_id ORDER BY occurred_at ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS session_seq
        FROM flagged
      ),
      ordered AS (
        SELECT
          brand_id, brain_anon_id, event_id, event_type, occurred_at, session_id_raw, session_seq,
          sr_murmur_hash3_32(
            concat_ws('|', brand_id, brain_anon_id, CAST(session_seq AS VARCHAR))
          ) AS session_key,
          row_number() OVER (
            PARTITION BY brand_id, brain_anon_id ORDER BY occurred_at ASC, event_id ASC
          ) AS touch_seq,
          row_number() OVER (
            PARTITION BY brand_id, brain_anon_id ORDER BY occurred_at DESC, event_id DESC
          ) AS touch_seq_desc,
          CASE
            WHEN fbclid IS NOT NULL AND fbclid <> '' THEN 'paid_meta'
            WHEN (gclid  IS NOT NULL AND gclid  <> '')
              OR (gbraid IS NOT NULL AND gbraid <> '')
              OR (wbraid IS NOT NULL AND wbraid <> '')
              OR (dclid  IS NOT NULL AND dclid  <> '')            THEN 'paid_google'
            WHEN ttclid  IS NOT NULL AND ttclid  <> '' THEN 'paid_tiktok'
            WHEN msclkid IS NOT NULL AND msclkid <> '' THEN 'paid_bing'
            WHEN lower(coalesce(utm_medium, '')) IN ('cpc', 'ppc', 'paid')      THEN 'paid'
            WHEN lower(coalesce(utm_medium, '')) = 'email'                      THEN 'email'
            WHEN lower(coalesce(utm_medium, '')) IN ('social', 'paid_social')   THEN 'organic_social'
            WHEN lower(coalesce(utm_medium, '')) = 'referral'                   THEN 'referral'
            WHEN referrer IS NOT NULL AND referrer <> ''                        THEN 'referral'
            ELSE 'direct'
          END AS channel,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          fbclid, gclid, ttclid, msclkid, gbraid, wbraid, dclid,
          referrer, landing_path, page_type, product_handle, collection_handle,
          search_query, tp_order_id, is_synthetic,
          -- same-source composite (additive flag, no row removal / no touch_seq change): a transaction-type
          -- touchpoint firing within 60s AFTER an earlier SAME-type touch for the same visitor is a
          -- near-duplicate (SPA re-render / retry / pixel double-fire). Shared TRANSACTION_EVENT_RLIKE.
          CASE
            WHEN regexp_matches(lower(coalesce(event_type, '')), '{TRANSACTION_EVENT_RLIKE}')
             AND lag(occurred_at) OVER (
                   PARTITION BY brand_id, brain_anon_id, event_type ORDER BY occurred_at ASC, event_id ASC
                 ) IS NOT NULL
             AND (CAST(epoch(occurred_at) AS BIGINT) - CAST(epoch(lag(occurred_at) OVER (
                   PARTITION BY brand_id, brain_anon_id, event_type ORDER BY occurred_at ASC, event_id ASC
                 )) AS BIGINT)) <= 60
            THEN true ELSE false
          END AS is_composite
        FROM sessionized
      )
      SELECT
        brand_id, brain_anon_id, event_id, event_type, occurred_at, session_id_raw,
        session_seq, session_key, touch_seq,
        (touch_seq = 1)      AS is_first_touch,
        (touch_seq_desc = 1) AS is_last_touch,
        channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        fbclid, gclid, ttclid, msclkid, gbraid, wbraid, dclid, referrer,
        CASE
          WHEN referrer IS NULL OR referrer = '' THEN CAST(NULL AS VARCHAR)
          ELSE regexp_replace(referrer, '^[a-zA-Z]+://([^/]+).*$', '\\1')
        END AS referrer_host,
        landing_path, page_type, product_handle, collection_handle, search_query, is_synthetic,
        is_composite, tp_order_id
      FROM ordered
    """

    # ── silver_touchpoint: stitch join + G5 cross-source composite join + 400-day TTL guard ──
    stitch_join = (
        "LEFT JOIN stitch_one s ON t.brand_id = s.brand_id AND t.brain_anon_id = s.stitched_anon_id"
        if has_stitch else ""
    )
    stitched_order = "s.order_id" if has_stitch else "CAST(NULL AS VARCHAR)"
    stitched_brain = "s.stitched_brain_id" if has_stitch else "CAST(NULL AS VARCHAR)"

    # Cross-source composite (G5): a pixel purchase-class touch matched to the SAME connector order within
    # 60s → is_composite widened + composite_order_key = connector order_id. LEFT JOIN = flag-only (no row
    # removal, no fan-out; grain 1 row/(brand_id, order_id)). NO amount-only fallback (see Spark job).
    if has_order:
        order_join = f"""
          LEFT JOIN order_state_one o
            ON t.brand_id = o.brand_id
           AND t.tp_order_id = o.order_id
           AND regexp_matches(lower(coalesce(t.event_type, '')), '{TRANSACTION_EVENT_RLIKE}')
           AND abs(CAST(epoch(t.occurred_at) AS BIGINT)
                   - CAST(epoch(coalesce(o.state_effective_at, o.first_event_at)) AS BIGINT))
               <= {COMPOSITE_ORDER_WINDOW_SECONDS}
        """
        composite_flag = "(t.is_composite OR o.order_id IS NOT NULL)"
        composite_key = "o.order_id"
    else:
        order_join = ""
        composite_flag = "t.is_composite"
        composite_key = "CAST(NULL AS VARCHAR)"

    staged = f"""
      SELECT
        t.brand_id, t.brain_anon_id, t.touch_seq, t.session_key, t.session_seq,
        t.is_first_touch, t.is_last_touch, t.occurred_at, t.event_type, t.channel,
        t.utm_source, t.utm_medium, t.utm_campaign, t.utm_term, t.utm_content,
        t.fbclid, t.gclid, t.ttclid, t.msclkid, t.gbraid, t.wbraid, t.dclid,
        t.referrer_host, t.landing_path, t.page_type, t.product_handle, t.collection_handle,
        t.search_query,
        {stitched_order} AS stitched_order_id,
        {stitched_brain} AS stitched_brain_id,
        t.is_synthetic,
        {composite_flag} AS is_composite,
        {composite_key}  AS composite_order_key,
        t.session_id_raw,
        now() AT TIME ZONE 'UTC' AS updated_at
      FROM ({sessionized}) t
      {stitch_join}
      {order_join}
      WHERE t.occurred_at IS NOT NULL
        AND (t.occurred_at AT TIME ZONE 'UTC') >= (now() AT TIME ZONE 'UTC') - INTERVAL 400 DAY
    """

    # Idempotent MERGE on the (brand_id, brain_anon_id, touch_seq) PK — replay-safe upsert. The
    # sessionization already yields exactly one row per PK, so the in-batch dedup (order_by_desc =
    # occurred_at then session_key) is a stable no-op tie-break, matching the sessions/journey pattern.
    return merge_on_pk(con, TARGET, staged, COLUMNS,
                       ["brand_id", "brain_anon_id", "touch_seq"],
                       order_by_desc=["occurred_at", "session_key"])


if __name__ == "__main__":
    run_job("silver-touchpoint", build, target_table="silver_touchpoint")
