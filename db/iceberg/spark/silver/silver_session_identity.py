# SPEC: A.2.1 / A.2.3 / A.2.3.5 / A.2.5 (WA-16, WA-18, AMD-08, AMD-13) — Deterministic Multi-Key Session Stitch (Stitch v2).
"""
silver_session_identity.py — Stitch v2: the Spark, incremental, watermarked, per-brand-flagged
deterministic multi-key session stitch (A.2). REPLACES the single-key (`anonymous_id`) Node cron
(journey-stitch-from-identity.ts) with a multi-key deterministic stitch at the SESSION grain, resolving
every session's identifier set through the SANCTIONED identity view (identity_current, A.2.2 / AMD-07).

WHY (A.2.1): a session should link to a customer sharing ANY common identifier — email hash, phone hash,
platform customer id, anonymous_id, checkout_session_id — UNAMBIGUOUSLY. The old cron only ever matched a
single raw anon per order and skipped anything ambiguous, so cross-device journeys never stitched and past
journeys were never lifted. This job resolves the FULL identifier set and, critically, NEVER GUESSES: a
session whose identifiers resolve to >1 brain_id is written to silver_stitch_conflicts (audit + review),
not silently attributed to one.

────────────────────────────────────────────────────────────────────────────────────────────────────────
SESSION GRAIN (task step 1) — aligned to the repo's session reality:
  A "session" = (brand_id, brain_anon_id, session_id_raw), the raw per-session id silver_touchpoint carries.
  The output MERGE key `session_id` is the stable, brand-unique string  concat(brain_anon_id, ':',
  session_id_raw). NOTE: `session_key` (= murmur_hash3_32(...), silver_touchpoint.py) is a 32-BIT hash and
  therefore NOT injective — distinct session_id_raw values on one visitor collide onto the same session_key
  at golden volume (√(2³²)≈65k birthday bound), which produced two source rows per (brand_id, session_id)
  and a MERGE_CARDINALITY_VIOLATION when session_id was keyed on session_key. session_key is retained as a
  non-key informational column ONLY; the MERGE key is the collision-free session_id_raw. silver_touchpoint
  is the session UNIVERSE + the session_id_raw → session_key map; identifiers are folded in from
  silver_collector_event payloads.

IDENTIFIER SET S (task step 2) — collected per session from silver_collector_event payloads:
  - anonymous_id            = properties.brain_anon_id           → SALTED external_id hash (internal space)
  - email  (interop, A.1.4) = properties.hashed_customer_email   → PLAIN sha256 already (pre_hashed_email)
  - phone  (interop)        = properties.hashed_customer_phone   → PLAIN sha256 already (pre_hashed_phone)
  - platform_customer_id    = properties.storefront_customer_id  → SALTED external_id hash
  - checkout_session_id     = properties.checkout_session_id     → SALTED external_id hash (best-effort)
  The plain interop email/phone hashes are the AMD-01 interop space (byte-identical to the pixel identify
  client-side hash) → they resolve DIRECTLY against identity_current's `pre_hashed_email`/`pre_hashed_phone`
  rows. anon/platform/checkout are the per-brand SALTED external_id space (matches the graph's anon_id /
  storefront_customer_id rows). Resolution joins on (brand_id, identifier_hash) alone — a hash is globally
  unique per (brand, value), so the `identifier_type` is provenance only (drives `matched_via`).

RESOLUTION + BRANCHING (task step 3, A.2.3):
  Resolve S through identity_current(spark) → candidate brain_ids B (per session).
    |B| = 1  → LINK: MERGE {brand_id, session_id, brain_id, matched_via[], stitch_version=2, stitched_at}
               into silver_session_identity  (MERGE on brand_id+session_id → replay-safe).
    |B| = 0  → skip (unstitched; probabilistic-eligible, A.3 / WA-20).
    |B| > 1  → AMBIGUOUS, DO NOT GUESS: MERGE {brand_id, session_id, candidate_brain_ids[], identifiers[],
               detected_at} into silver_stitch_conflicts. The subset backed by ≥2 STRONG identifiers
               (email/phone/platform) is also bridged to the PG merge-review queue (see below, task step 3).

SHARED-DEVICE 90d RULE (task step 4, A.2.3.4):
  `anonymous_id` ALONE links only when its mapping is RECENT — within SHARED_DEVICE_RECENCY_DAYS (default
  90, per-brand-overridable) of the session. A stale anon match is DROPPED before |B| is computed, so an
  old shared-device anon can neither stitch on its own nor manufacture a conflict. A FRESH anon is kept —
  which is exactly how a shared family device surfaces as a CONFLICT (fresh anon → brainA, member-B's
  email → brainB) rather than a wrong stitch. last_seen source = identity_current.updated_at (the map's
  system-freshness axis; the richer Neo4j OBSERVED_WITH.last_seen is the eventual upgrade, documented).

DUAL-WRITE the legacy stitch (task step 5, A.2.3 / AMD-13):
  While `stitch.v2` is ON, ALSO mirror the deterministic, unambiguous stitch the journey builder reads
  TODAY (ops.silver_journey_stitch — silver_touchpoint._read_stitch's SoR) so legacy consumers stay
  coherent during rollout. For each NEWLY-stitched session (|B|=1) that CONTAINS an order event we upsert
  (brand_id, order_id, stitched_anon_id=brain_anon_id, brain_id) — the identical order-grain shape
  journey-stitch-from-identity.ts writes. Deterministic-only + unambiguous-only (|B|=1 by construction).

FLAG GATE (task step 6, §0.5): PER-BRAND `stitch.v2` (Python flag twin, _platform_flags). Only brands with
  the flag ON are processed; a brand with the flag OFF is never read/written. If NO brand has it on the job
  is a clean no-op (log line) — the refresh loop is unaffected (default-OFF, byte-identical pre-wave).

PERFORMANCE (task step 7, A.2.5): incremental (silver_job_watermark side-table; FULL_REFRESH=1 forces a
  full pass), partitioned brand_id + event_date, broadcast join of the (small, per-brand) identity view.
  Local 4GB executor profile (run script: local[2], --driver-memory 4g).

EVENT-DRIVEN RE-STITCH DRAIN (task step 3, A.2.3.5 / WA-18 / AMD-08): each run ALSO drains ops.restitch_pending
  (the dirty set the RestitchDirtyConsumer writes on every identity map mutation — link/merge/unmerge/mint).
  For every dirty (brand_id, identifier_hash | brain_id) key it folds the matching HISTORICAL sessions —
  bounded to RESTITCH_LOOKBACK_DAYS (the attribution lookback) — INTO the watermark-incremental universe,
  re-runs steps 1-3, then CLEARS exactly the drained keys AFTER the MERGE commits (crash-safe). This lifts
  PAST journeys: a day-7 identify dirties the anon hash → the visitor → their day-1..6 anonymous sessions
  re-resolve to the now-known brain within ONE incremental run (A.5.5). Empty set → byte-identical no-op.

HARD RULES: brand_id is the tenant key, FIRST column. Hash-only PII (every identifier is a 64-hex hash;
  no raw email/phone). No money. Additive (two NEW Iceberg tables + one additive PG queue). Idempotent
  MERGE everywhere → replay-safe.
"""
from __future__ import annotations  # Spark image is Python 3.8.

import os
import sys
import time
import uuid

# The shared Phase-0 base + the sanctioned identity accessor live one directory up; add spark/ to the path
# so a spark-submit of a file in silver/ (cwd=/opt/silver) can import them (mirrors _silver_base.py).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import DataFrame, SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table,
    read_job_watermark, write_job_watermark,
)
from job_log import emit_job_log  # noqa: E402
from _identity_views import identity_current  # noqa: E402
from _platform_flags import is_flag_enabled, FLAG_STITCH_V2  # noqa: E402

# ── Source / target table names ───────────────────────────────────────────────────────────────────────
COLLECTOR_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
TOUCHPOINT_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
SESSION_IDENTITY_TABLE = "silver_session_identity"
STITCH_CONFLICTS_TABLE = "silver_stitch_conflicts"
JOB_NAME = "silver_session_identity"

# ── Config knobs ────────────────────────────────────────────────────────────────────────────────────────
# A.2.3.4 shared-device recency (days). Per-brand override lands in a brand config column later; the env
# default is the spec default (90). Read once at driver start.
SHARED_DEVICE_RECENCY_DAYS = int(os.environ.get("SHARED_DEVICE_RECENCY_DAYS", "90"))
STITCH_VERSION = 2

# A.2.3.5 (WA-18) event-driven re-stitch: how far back (days, relative to now) the drain re-evaluates
# historical sessions dirtied by an identity map mutation — "within the attribution lookback" (§A.2.3(5),
# repo attribution default = 90d). Env-overridable (a historical golden dataset sits >90d behind wall
# clock, so the live A.5.5 proof sets a wider window). A dirty session OLDER than this is left alone.
RESTITCH_LOOKBACK_DAYS = int(os.environ.get("RESTITCH_LOOKBACK_DAYS", "90"))
# The PG dirty-set the RestitchDirtyConsumer writes (migration 0124). Drained each run AFTER the MERGE.
RESTITCH_PENDING_TABLE = "ops.restitch_pending"

# The order-carrying event types whose payload.properties.order_id feeds the legacy dual-write.
ORDER_EVENT_TYPES = ["order.placed", "order.live.v1", "order.backfill.v1",
                     "gokwik.order.v1", "gokwik.order_placed.v1"]

# ── silver_session_identity schema (brand_id first; matched_via = provenance array) ─────────────────────
_SESSION_IDENTITY_COLUMNS = """
          brand_id        string        NOT NULL,
          session_id      string        NOT NULL,
          brain_anon_id   string,
          session_key     int,
          brain_id        string        NOT NULL,
          matched_via     array<string>,
          stitch_version  int           NOT NULL,
          session_start   timestamp,
          event_date      date,
          stitched_at     timestamp     NOT NULL
""".strip("\n")

# ── silver_stitch_conflicts schema (never-guess audit + merge-review input queue) ───────────────────────
_STITCH_CONFLICTS_COLUMNS = """
          brand_id            string        NOT NULL,
          session_id          string        NOT NULL,
          brain_anon_id       string,
          session_key         int,
          candidate_brain_ids array<string>,
          identifiers         array<string>,
          strong_brain_ids    array<string>,
          session_start       timestamp,
          event_date          date,
          detected_at         timestamp     NOT NULL
""".strip("\n")


def _enabled_brands(spark: SparkSession) -> "list[str]":
    """Driver-side per-brand flag gate: the DISTINCT brands present in the session universe whose
    `stitch.v2` flag is ON. Default-OFF + fail-closed (a Redis miss → the brand is skipped)."""
    try:
        brands = [
            r["brand_id"]
            for r in spark.table(TOUCHPOINT_TABLE).select("brand_id").distinct().collect()
            if r["brand_id"]
        ]
    except Exception as exc:  # noqa: BLE001 — touchpoint absent (cold start) → nothing to stitch
        print(f"[{JOB_NAME}] silver_touchpoint unavailable ({exc}); no sessions to stitch", flush=True)
        return []
    on = [b for b in brands if is_flag_enabled(b, FLAG_STITCH_V2)]
    print(f"[{JOB_NAME}] flag gate: {len(on)}/{len(brands)} brand(s) have stitch.v2 ON", flush=True)
    return on


def _load_salts(spark: SparkSession) -> DataFrame:
    """(brand_id, salt_hex) for the SALTED external_id hash space — the SAME dev-derivable/prod-KMS SoR
    the connector + Silver normalize jobs use (silver_shopify_order_normalize._load_salts), so the anon /
    platform-id hashes byte-match the identity graph's anon_id / storefront_customer_id rows."""
    url = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
    query = os.environ.get("SALT_QUERY") or (
        "SELECT id::text AS brand_id, "
        "encode(sha256(('brain-dev-identity-salt-v1||'||lower(id::text))::bytea),'hex') AS salt_hex "
        "FROM tenancy.brand"
    )
    return (
        spark.read.format("jdbc").option("url", url)
        .option("user", os.environ.get("BRONZE_PG_USER", "brain"))
        .option("password", os.environ.get("BRONZE_PG_PASSWORD", "brain"))
        .option("driver", "org.postgresql.Driver").option("query", query).load()
    )


def _session_map(spark: SparkSession, brands: "list[str]", wm) -> DataFrame:
    """Session universe from silver_touchpoint: distinct (brand_id, brain_anon_id, session_id_raw) →
    session_key + per-session session_start + event_date. INCREMENTAL: only sessions with a touch
    FOLDED at/after the watermark (minus a 2h overlap; MERGE dedups). session_id_raw is the join key back
    to collector events. Rows with no session_id_raw cannot be matched to an event payload → excluded
    (honest skip).

    AUD-IMPL-014 — the incremental axis is `updated_at` (silver_touchpoint's INGEST/fold axis — the job
    stamps current_timestamp() on every re-folded touch), NOT `occurred_at` (event time). A late-arriving
    or BACKFILLED touch (order.backfill.v1, a delayed connector webhook) lands with an occurred_at that
    can predate the watermark by days-to-months but always carries a FRESH updated_at — the old
    event-time filter skipped those sessions FOREVER (the restitch drain fires only on identity-map
    mutations, not late arrival), so backfilled history was never stitched nor attributed. Selection is
    at the SESSION grain: any session with ≥1 newly-folded touch is re-folded over its FULL touch set
    (semi-join) so session_start = min(occurred_at) stays correct across the boundary."""
    tp = spark.table(TOUCHPOINT_TABLE).where(F.col("brand_id").isin(brands))
    tp = tp.where(F.col("session_id_raw").isNotNull() & (F.col("session_id_raw") != F.lit("")))
    if wm is not None:
        overlap_h = int(os.environ.get("SILVER_INCREMENTAL_OVERLAP_HOURS", "2"))
        new_keys = (
            tp.where(F.col("updated_at") >= (F.lit(wm) - F.expr(f"INTERVAL {overlap_h} HOURS")))
            .select("brand_id", "brain_anon_id", "session_id_raw")
            .distinct()
        )
        tp = tp.join(new_keys, ["brand_id", "brain_anon_id", "session_id_raw"], "left_semi")
    return (
        tp.groupBy("brand_id", "brain_anon_id", "session_id_raw", "session_key")
        .agg(F.min("occurred_at").alias("session_start"))
        .withColumn("event_date", F.to_date("session_start"))
        # MERGE key = collision-free (brain_anon_id, session_id_raw); session_key is a 32-bit hash and must
        # NOT key the target (see SESSION GRAIN note) — keeping it as a column only.
        .withColumn("session_id", F.concat_ws(":", F.col("brain_anon_id"), F.col("session_id_raw")))
    )


def _session_identifiers(spark: SparkSession, brands: "list[str]", salts: DataFrame, sessions: DataFrame) -> DataFrame:
    """Long-format matched identifiers per session. Reads silver_collector_event payloads, builds each
    session's identifier set S in the correct hash space, joins to identity_current on (brand_id, hash) →
    brain_id, applies the A.2.3.4 shared-device 90d rule, and returns one row per MATCHED (session,
    identifier). Columns: brand_id, session_id, brain_anon_id, session_key, session_start, event_date,
    src_type, identifier_hash, is_strong, brain_id."""
    ev = spark.table(COLLECTOR_TABLE).where(F.col("brand_id").isin(brands)).select(
        F.col("brand_id"),
        F.get_json_object("payload", "$.properties.brain_anon_id").alias("anon"),
        F.get_json_object("payload", "$.properties.session_id").alias("sid"),
        F.get_json_object("payload", "$.properties.hashed_customer_email").alias("email_hash"),
        F.get_json_object("payload", "$.properties.hashed_customer_phone").alias("phone_hash"),
        F.get_json_object("payload", "$.properties.storefront_customer_id").alias("platform_id"),
        F.get_json_object("payload", "$.properties.checkout_session_id").alias("checkout_sid"),
    ).where(F.col("anon").isNotNull() & (F.col("anon") != F.lit("")) & F.col("sid").isNotNull())

    # Attach each event to its session (via the touchpoint session_id_raw → session_key map) + salt.
    ev = (
        ev.join(
            sessions.select("brand_id", "brain_anon_id", "session_id_raw", "session_key",
                            "session_id", "session_start", "event_date"),
            (ev["brand_id"] == sessions["brand_id"])
            & (ev["anon"] == sessions["brain_anon_id"])
            & (ev["sid"] == sessions["session_id_raw"]),
            "inner",
        )
        .drop(sessions["brand_id"])
        .join(F.broadcast(salts), "brand_id", "left")
    )

    def _salted(value_col):
        # external_id space: sha256( salt_hex || '||' || trim(value) ) — _raw_normalize.hash_identifier.
        return F.sha2(F.concat(F.coalesce(F.col("salt_hex"), F.lit("")), F.lit("||"), F.trim(value_col)), 256)

    base_cols = ["brand_id", "session_id", "brain_anon_id", "session_key", "session_start", "event_date"]

    def _lane(cond, src_type: str, hash_col, is_strong: bool) -> DataFrame:
        return (
            ev.where(cond)
            .select(*base_cols, F.lit(src_type).alias("src_type"),
                    hash_col.alias("identifier_hash"), F.lit(is_strong).alias("is_strong"))
            .distinct()
        )

    anon_lane = _lane(F.col("anon").isNotNull(), "anonymous_id", _salted(F.col("anon")), False)
    email_lane = _lane(F.col("email_hash").isNotNull() & (F.col("email_hash") != F.lit("")),
                       "email", F.col("email_hash"), True)
    phone_lane = _lane(F.col("phone_hash").isNotNull() & (F.col("phone_hash") != F.lit("")),
                       "phone", F.col("phone_hash"), True)
    plat_lane = _lane(F.col("platform_id").isNotNull() & (F.col("platform_id") != F.lit("")),
                      "platform_customer_id", _salted(F.col("platform_id")), True)
    chk_lane = _lane(F.col("checkout_sid").isNotNull() & (F.col("checkout_sid") != F.lit("")),
                     "checkout_session_id", _salted(F.col("checkout_sid")), False)

    idents = anon_lane.unionByName(email_lane).unionByName(phone_lane).unionByName(plat_lane).unionByName(chk_lane)

    # Resolve through the SANCTIONED identity view (broadcast — per-brand it is small). Join on
    # (brand_id, identifier_hash): a hash is globally unique per (brand, value) so the type is provenance.
    cur = identity_current(spark).select(
        F.col("brand_id"), F.col("identifier_hash"), F.col("brain_id"), F.col("updated_at").alias("mapping_last_seen"),
    )
    matched = idents.join(F.broadcast(cur), ["brand_id", "identifier_hash"], "inner")

    # A.2.3.4 SHARED-DEVICE 90d rule: DROP a stale anon match (anon mapping older than N days before the
    # session). Strong identifiers are always kept; only anon (is_strong=false, src_type='anonymous_id')
    # is recency-gated. checkout_session_id is weak but never resolves in practice (no map row), so gating
    # it is a no-op — we gate only the anon lane to honor the spec's "anonymous_id ALONE" wording exactly.
    stale_anon = (
        (F.col("src_type") == F.lit("anonymous_id"))
        & F.col("mapping_last_seen").isNotNull()
        & (F.col("mapping_last_seen") < (F.col("session_start") - F.expr(f"INTERVAL {SHARED_DEVICE_RECENCY_DAYS} DAYS")))
    )
    return matched.where(~stale_anon)


def _write_iceberg(spark: SparkSession, matched: DataFrame) -> "dict":
    """Aggregate matched identifiers per session → resolve by IDENTITY PRIORITY (A.1.5) → branch → MERGE
    into the two Iceberg tables. Returns counts + leaves temp views for the dual-write / review bridge.

    RESOLUTION (A.1.5 priority + A.2.3 + A.5.3): a STRONG deterministic identifier (email / phone /
    platform_customer_id) that resolves to exactly ONE brain WINS over a lower-priority anonymous_id — even
    when the anon is AMBIGUOUS — because the strong id is higher-priority and the anon merely fails to
    disambiguate. But a CLEAN disagreement between a single strong id and a single, DIFFERENT anon brain is
    the A.5.3 conflict ("email→X, anon→Y → conflict, NO stitch"). Concretely, per session:
      strong_brains = distinct brains from strong ids ;  anon_brains = distinct brains from anon.
      • winner = the single strong brain W        IF |strong|=1 AND (|anon|=0 OR W ∈ anon_brains)   → STITCH
      • winner = the single anon brain            IF |strong|=0 AND |anon|=1 (90d-fresh, weak-alone)  → STITCH
      • else, if ≥2 distinct brains matched at all → AMBIGUOUS, never guess                          → CONFLICT
      • else (0/1 brain, no winner)               → unstitched (skip)
    This makes multi_device (same email across devices → 1 strong brain) STITCH even when one device's anon
    is graph-ambiguous, while shared_device_family (one shared anon, member emails → different brains, clean
    disagreement) CONFLICTS. Ambiguity that survives (≥2 strong brains, or strong vs a clean-different anon)
    is written to silver_stitch_conflicts, never guessed."""
    per_session = matched.groupBy(
        "brand_id", "session_id", "brain_anon_id", "session_key", "session_start", "event_date",
    ).agg(
        F.collect_set("brain_id").alias("brain_ids"),
        F.collect_set("src_type").alias("matched_via"),
        F.collect_set(F.when(F.col("is_strong"), F.col("brain_id"))).alias("strong_brain_ids_raw"),
        F.collect_set(F.when(F.col("src_type") == F.lit("anonymous_id"), F.col("brain_id"))).alias("anon_brain_ids_raw"),
        F.collect_set("identifier_hash").alias("identifiers"),
    )
    _no_null = F.array(F.lit(None).cast("string"))
    per_session = (
        per_session
        .withColumn("strong_brain_ids", F.array_except(F.col("strong_brain_ids_raw"), _no_null))
        .withColumn("anon_brain_ids", F.array_except(F.col("anon_brain_ids_raw"), _no_null))
        .drop("strong_brain_ids_raw", "anon_brain_ids_raw")
    )
    n_strong = F.size("strong_brain_ids")
    n_anon = F.size("anon_brain_ids")
    strong0 = F.col("strong_brain_ids").getItem(0)
    # Priority-resolved winner (null = no unambiguous winner). A.1.5 strong-wins-over-ambiguous-anon.
    per_session = per_session.withColumn(
        "winner_brain_id",
        F.when((n_strong == 1) & ((n_anon == 0) | F.array_contains(F.col("anon_brain_ids"), strong0)), strong0)
        .when((n_strong == 0) & (n_anon == 1), F.col("anon_brain_ids").getItem(0))
        .otherwise(F.lit(None).cast("string")),
    )
    per_session.persist()

    # WINNER present → deterministic link.
    stitched = per_session.where(F.col("winner_brain_id").isNotNull()).select(
        "brand_id", "session_id", "brain_anon_id", "session_key",
        F.col("winner_brain_id").alias("brain_id"),
        F.array_sort("matched_via").alias("matched_via"),
        F.lit(STITCH_VERSION).alias("stitch_version"),
        "session_start", "event_date",
        F.current_timestamp().alias("stitched_at"),
    ).dropDuplicates(["brand_id", "session_id"])  # MERGE-source guard: one row per target key (no cardinality violation)
    si_fqtn = create_iceberg_table(
        spark, SILVER_NAMESPACE, SESSION_IDENTITY_TABLE, _SESSION_IDENTITY_COLUMNS,
        partitioned_by="brand_id, event_date",
    )
    stitched.createOrReplaceTempView("_session_identity_new")
    spark.sql(
        f"""
        MERGE INTO {si_fqtn} t
        USING _session_identity_new s
        ON t.brand_id = s.brand_id AND t.session_id = s.session_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n_stitched = stitched.count()

    # No unambiguous winner AND ≥2 distinct brains matched → ambiguous, never guess → conflict row.
    conflicts = per_session.where(F.col("winner_brain_id").isNull() & (F.size("brain_ids") > 1)).select(
        "brand_id", "session_id", "brain_anon_id", "session_key",
        F.array_sort("brain_ids").alias("candidate_brain_ids"),
        F.array_sort("identifiers").alias("identifiers"),
        F.array_sort("strong_brain_ids").alias("strong_brain_ids"),
        "session_start", "event_date",
        F.current_timestamp().alias("detected_at"),
    ).dropDuplicates(["brand_id", "session_id"])  # MERGE-source guard: one row per target key (no cardinality violation)
    sc_fqtn = create_iceberg_table(
        spark, SILVER_NAMESPACE, STITCH_CONFLICTS_TABLE, _STITCH_CONFLICTS_COLUMNS,
        partitioned_by="brand_id, event_date",
    )
    conflicts.createOrReplaceTempView("_stitch_conflicts_new")
    spark.sql(
        f"""
        MERGE INTO {sc_fqtn} t
        USING _stitch_conflicts_new s
        ON t.brand_id = s.brand_id AND t.session_id = s.session_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n_conflicts = conflicts.count()

    # Keep the aggregated frames for the dual-write / review-bridge steps.
    stitched.createOrReplaceTempView("_stitched_sessions")
    conflicts.createOrReplaceTempView("_conflict_sessions")
    per_session.unpersist()
    return {"stitched": n_stitched, "conflicts": n_conflicts, "si_fqtn": si_fqtn, "sc_fqtn": sc_fqtn}


# ── PG dual-write / review-bridge over py4j JDBC (flag-on only; failure never breaks the job) ────────────
def _pg_batch(spark: SparkSession, brand_id: str, sql: str, rows: "list[tuple]") -> int:
    """Execute a per-brand batched, idempotent upsert over a single JDBC connection with the brand GUC set
    (SET LOCAL app.current_brand_id → satisfies FORCE-RLS on the connector/review tables). Best-effort:
    any JDBC error is logged + swallowed so the Iceberg SoR write (already committed) is never undone."""
    if not rows:
        return 0
    url = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
    user = os.environ.get("BRONZE_PG_USER", "brain")
    pw = os.environ.get("BRONZE_PG_PASSWORD", "brain")
    jvm = spark.sparkContext._jvm  # type: ignore[attr-defined]
    conn = None
    try:
        conn = jvm.java.sql.DriverManager.getConnection(url, user, pw)
        conn.setAutoCommit(False)
        st = conn.createStatement()
        st.execute("SET app.current_brand_id = '" + brand_id.replace("'", "") + "'")
        st.close()
        ps = conn.prepareStatement(sql)
        for row in rows:
            for i, v in enumerate(row):
                ps.setString(i + 1, None if v is None else str(v))
            ps.addBatch()
        ps.executeBatch()
        conn.commit()
        ps.close()
        return len(rows)
    except Exception as exc:  # noqa: BLE001 — legacy mirror is best-effort; SoR already landed
        print(f"[{JOB_NAME}] dual-write/review PG batch skipped for brand {brand_id}: {exc}", flush=True)
        try:
            if conn is not None:
                conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0
    finally:
        try:
            if conn is not None:
                conn.close()
        except Exception:  # noqa: BLE001
            pass


def _dual_write_legacy(spark: SparkSession, brands: "list[str]") -> int:
    """AMD-13 legacy mirror: for each NEWLY-stitched session (|B|=1) that CONTAINS an order event, upsert
    the order-grain stitch (brand_id, order_id, stitched_anon_id=brain_anon_id, brain_id) into
    ops.silver_journey_stitch — the exact SoR silver_touchpoint._read_stitch reads today. Deterministic +
    unambiguous only. NULL order_id sessions (browse-only) contribute nothing (an order id is required)."""
    order_ids = (
        spark.table(COLLECTOR_TABLE).where(F.col("brand_id").isin(brands))
        .where(F.col("event_type").isin(ORDER_EVENT_TYPES))
        .select(
            "brand_id",
            F.get_json_object("payload", "$.properties.brain_anon_id").alias("brain_anon_id"),
            F.get_json_object("payload", "$.properties.session_id").alias("sid"),
            F.get_json_object("payload", "$.properties.order_id").alias("order_id"),
        )
        .where(F.col("order_id").isNotNull() & (F.col("order_id") != F.lit("")))
    )
    # Join order events to newly-stitched sessions via (brand_id, brain_anon_id) — the stitched session
    # already carries a single brain_id; an order in that visitor's stitched session inherits it.
    stitched = spark.table("_stitched_sessions").select(
        "brand_id", "brain_anon_id", F.col("brain_id"),
    ).distinct()
    dual = (
        order_ids.join(stitched, ["brand_id", "brain_anon_id"], "inner")
        .select("brand_id", "order_id", "brain_anon_id", "brain_id").distinct()
    )
    sql = (
        "INSERT INTO ops.silver_journey_stitch "
        "(brand_id, order_id, stitched_anon_id, brain_id, created_at, updated_at) "
        "VALUES (?::uuid, ?, ?, ?::uuid, now(), now()) "
        "ON CONFLICT (brand_id, order_id) DO UPDATE SET "
        "stitched_anon_id = EXCLUDED.stitched_anon_id, brain_id = EXCLUDED.brain_id, updated_at = now()"
    )
    total = 0
    for b in brands:
        rows = [
            (r["brand_id"], r["order_id"], r["brain_anon_id"], r["brain_id"])
            for r in dual.where(F.col("brand_id") == b).collect()
        ]
        total += _pg_batch(spark, b, sql, rows)
    print(f"[{JOB_NAME}] legacy dual-write → ops.silver_journey_stitch: {total} order row(s)", flush=True)
    return total


def _bridge_conflicts_to_review(spark: SparkSession, brands: "list[str]") -> int:
    """Task step 3 bridge: conflicts backed by ≥2 STRONG identifiers (email/phone/platform) pointing to
    different brain_ids are genuine MERGE candidates → enqueue a pending row in ops.stitch_conflict_review.
    A SHARED-DEVICE conflict (fresh anon vs one strong id, |strong_brain_ids| < 2) is NEVER enqueued —
    merging two family members would be wrong (it stays in silver_stitch_conflicts for audit only)."""
    mergeable = spark.table("_conflict_sessions").where(F.size("strong_brain_ids") >= 2).select(
        "brand_id", "session_id",
        F.col("strong_brain_ids").getItem(0).alias("brain_id_a"),
        F.col("strong_brain_ids").getItem(1).alias("brain_id_b"),
        F.to_json(F.struct(F.col("identifiers"), F.col("candidate_brain_ids"))).alias("evidence"),
    )
    sql = (
        "INSERT INTO ops.stitch_conflict_review "
        "(brand_id, review_id, session_id, brain_id_a, brain_id_b, trigger_reason, evidence, status, detected_at) "
        "VALUES (?::uuid, ?::uuid, ?, ?::uuid, ?::uuid, 'stitch_conflict', ?::jsonb, 'pending', now()) "
        "ON CONFLICT (brand_id, review_id) DO NOTHING"
    )
    total = 0
    for b in brands:
        rows = []
        for r in mergeable.where(F.col("brand_id") == b).collect():
            # Deterministic review_id (uuid5) → idempotent enqueue across re-runs.
            rid = str(uuid.uuid5(uuid.NAMESPACE_URL,
                                 f"stitch-conflict|{r['brand_id']}|{r['session_id']}|{r['brain_id_a']}|{r['brain_id_b']}"))
            rows.append((r["brand_id"], rid, r["session_id"], r["brain_id_a"], r["brain_id_b"], r["evidence"]))
        total += _pg_batch(spark, b, sql, rows)
    print(f"[{JOB_NAME}] conflict→review bridge → ops.stitch_conflict_review: {total} review(s)", flush=True)
    return total


# ── A.2.3.5 (WA-18) event-driven re-stitch drain ────────────────────────────────────────────────────────
def _read_dirty_set(spark: SparkSession, brands: "list[str]") -> "DataFrame | None":
    """Read the re-stitch dirty set (ops.restitch_pending, migration 0124) for the flag-ON brands over
    JDBC. Returns a DataFrame(brand_id, dirty_kind, dirty_key) or None when the set is EMPTY / unreadable
    (fail-safe: a PG hiccup → no dirty drain this run, watermark-incremental path is unaffected). brands
    are our own flag-gated UUIDs; sanitized (quote-stripped) before inlining, mirroring _pg_batch's SET."""
    if not brands:
        return None
    url = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
    in_list = ",".join("'" + b.replace("'", "") + "'" for b in brands)
    query = (
        "SELECT brand_id::text AS brand_id, dirty_kind, dirty_key "
        f"FROM {RESTITCH_PENDING_TABLE} WHERE brand_id IN ({in_list})"
    )
    try:
        df = (
            spark.read.format("jdbc").option("url", url)
            .option("user", os.environ.get("BRONZE_PG_USER", "brain"))
            .option("password", os.environ.get("BRONZE_PG_PASSWORD", "brain"))
            .option("driver", "org.postgresql.Driver").option("query", query).load()
        )
        return df if df.take(1) else None
    except Exception as exc:  # noqa: BLE001 — dirty set unreadable → skip the drain (safe, incremental still runs)
        print(f"[{JOB_NAME}] dirty-set read skipped ({exc}); no re-stitch drain this run", flush=True)
        return None


def _dirty_session_universe(spark: SparkSession, brands: "list[str]", dirty_df: DataFrame,
                            salts: DataFrame) -> DataFrame:
    """Historical sessions to RE-EVALUATE this run because an identity map mutation dirtied one of their
    keys (A.2.3(5)). Bounded to sessions whose session_start is within RESTITCH_LOOKBACK_DAYS of now (the
    attribution lookback). Same schema as _session_map so it unions straight into the stitch universe:
    (brand_id, brain_anon_id, session_id_raw, session_key, session_start, event_date, session_id).

    A dirty match is at the VISITOR grain (brand_id, brain_anon_id): any dirty identifier/brain touching a
    visitor lifts ALL that visitor's in-window sessions — which is exactly the A.5.5 lift (a day-7 mint
    dirties the anon hash → the visitor → their day-1..6 anonymous sessions re-resolve to the new brain)."""
    tp = (
        spark.table(TOUCHPOINT_TABLE).where(F.col("brand_id").isin(brands))
        .where(F.col("session_id_raw").isNotNull() & (F.col("session_id_raw") != F.lit("")))
        .where(F.col("occurred_at") >= (F.current_timestamp() - F.expr(f"INTERVAL {RESTITCH_LOOKBACK_DAYS} DAYS")))
    )
    base = (
        tp.groupBy("brand_id", "brain_anon_id", "session_id_raw", "session_key")
        .agg(F.min("occurred_at").alias("session_start"))
        .withColumn("event_date", F.to_date("session_start"))
        # Same collision-free MERGE key as _session_map (session_id_raw, NOT the 32-bit session_key).
        .withColumn("session_id", F.concat_ws(":", F.col("brain_anon_id"), F.col("session_id_raw")))
    )

    dirty_ids = (
        dirty_df.where(F.col("dirty_kind") == F.lit("identifier_hash"))
        .select("brand_id", F.col("dirty_key").alias("identifier_hash")).distinct()
    )
    dirty_brains = (
        dirty_df.where(F.col("dirty_kind") == F.lit("brain_id"))
        .select("brand_id", F.col("dirty_key").alias("brain_id")).distinct()
    )

    def _salted(value_col):
        return F.sha2(F.concat(F.coalesce(F.col("salt_hex"), F.lit("")), F.lit("||"), F.trim(value_col)), 256)

    visitor_cols = ["brand_id", "brain_anon_id"]

    # (a) anon-hash dirty: salted(brain_anon_id) ∈ dirty identifier hashes → the visitor.
    anon_v = (
        base.select("brand_id", "brain_anon_id").distinct()
        .join(F.broadcast(salts), "brand_id", "left")
        .withColumn("identifier_hash", _salted(F.col("brain_anon_id")))
        .join(F.broadcast(dirty_ids), ["brand_id", "identifier_hash"], "inner")
        .select(*visitor_cols)
    )

    # (b) brain-id dirty (merge/unmerge): visitors already stitched to a dirty brain_id.
    try:
        si_tbl = spark.table(f"{CATALOG}.{SILVER_NAMESPACE}.{SESSION_IDENTITY_TABLE}")
        brain_v = (
            si_tbl.where(F.col("brand_id").isin(brands))
            .join(F.broadcast(dirty_brains), ["brand_id", "brain_id"], "inner")
            .select(*visitor_cols)
        )
    except Exception:  # noqa: BLE001 — first run, table not yet created → no brain-lane dirties
        brain_v = anon_v.limit(0).select(*visitor_cols)

    # (c) strong-identifier dirty (email/phone/platform/checkout): collector events (in-window) whose
    # computed identifier hash ∈ dirty identifier hashes → the visitor. Covers cross-visitor lifts.
    ev = (
        spark.table(COLLECTOR_TABLE).where(F.col("brand_id").isin(brands))
        .where(F.col("occurred_at") >= (F.current_timestamp() - F.expr(f"INTERVAL {RESTITCH_LOOKBACK_DAYS} DAYS")))
        .select(
            F.col("brand_id"),
            F.get_json_object("payload", "$.properties.brain_anon_id").alias("brain_anon_id"),
            F.get_json_object("payload", "$.properties.hashed_customer_email").alias("email_hash"),
            F.get_json_object("payload", "$.properties.hashed_customer_phone").alias("phone_hash"),
            F.get_json_object("payload", "$.properties.storefront_customer_id").alias("platform_id"),
            F.get_json_object("payload", "$.properties.checkout_session_id").alias("checkout_sid"),
        )
        .where(F.col("brain_anon_id").isNotNull() & (F.col("brain_anon_id") != F.lit("")))
        .join(F.broadcast(salts), "brand_id", "left")
    )

    def _strong_lane(cond, hash_col) -> DataFrame:
        return ev.where(cond).select("brand_id", "brain_anon_id", hash_col.alias("identifier_hash"))

    strong = (
        _strong_lane(F.col("email_hash").isNotNull() & (F.col("email_hash") != F.lit("")), F.col("email_hash"))
        .unionByName(_strong_lane(F.col("phone_hash").isNotNull() & (F.col("phone_hash") != F.lit("")), F.col("phone_hash")))
        .unionByName(_strong_lane(F.col("platform_id").isNotNull() & (F.col("platform_id") != F.lit("")), _salted(F.col("platform_id"))))
        .unionByName(_strong_lane(F.col("checkout_sid").isNotNull() & (F.col("checkout_sid") != F.lit("")), _salted(F.col("checkout_sid"))))
        .join(F.broadcast(dirty_ids), ["brand_id", "identifier_hash"], "inner")
        .select(*visitor_cols)
    )

    dirty_visitors = anon_v.unionByName(brain_v).unionByName(strong).distinct()
    return base.join(dirty_visitors, visitor_cols, "inner").select(
        "brand_id", "brain_anon_id", "session_id_raw", "session_key", "session_start", "event_date", "session_id",
    )


def _drain_dirty_set(spark: SparkSession, brands: "list[str]", dirty_rows: "list") -> int:
    """CRASH-SAFE clear: delete EXACTLY the dirty rows we read+processed (never keys enqueued mid-run),
    AFTER the stitch MERGE has committed. If this DELETE fails or the job crashed before it, the rows
    survive and the next run reprocesses them — the stitch MERGE is idempotent, so that is harmless."""
    sql = (
        f"DELETE FROM {RESTITCH_PENDING_TABLE} "
        "WHERE brand_id = ?::uuid AND dirty_kind = ? AND dirty_key = ?"
    )
    total = 0
    for b in brands:
        rows = [(r["brand_id"], r["dirty_kind"], r["dirty_key"]) for r in dirty_rows if r["brand_id"] == b]
        total += _pg_batch(spark, b, sql, rows)
    print(f"[{JOB_NAME}] re-stitch dirty-set drained: {total} key(s) cleared", flush=True)
    return total


def build(spark: SparkSession) -> "tuple[str, int]":
    """Full Stitch v2 pass over the flag-ON brands. Returns (silver_session_identity fqtn, stitched rows)."""
    brands = _enabled_brands(spark)
    if not brands:
        # Clean no-op: ensure the tables EXIST (empty) so downstream views resolve, advance nothing.
        si_fqtn = create_iceberg_table(spark, SILVER_NAMESPACE, SESSION_IDENTITY_TABLE,
                                       _SESSION_IDENTITY_COLUMNS, partitioned_by="brand_id, event_date")
        create_iceberg_table(spark, SILVER_NAMESPACE, STITCH_CONFLICTS_TABLE,
                             _STITCH_CONFLICTS_COLUMNS, partitioned_by="brand_id, event_date")
        print(f"[{JOB_NAME}] no brand has stitch.v2 ON — no-op (pre-wave, refresh loop unaffected)", flush=True)
        return si_fqtn, 0

    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    wm = None if full_refresh else read_job_watermark(spark, JOB_NAME)

    salts = _load_salts(spark)
    sessions = _session_map(spark, brands, wm)

    # A.2.3.5 (WA-18) event-driven re-stitch: fold in PAST sessions dirtied by an identity map mutation
    # (in ADDITION to the watermark increment). Read the dirty set first so we clear EXACTLY what we drain
    # after the MERGE (crash-safe). With an empty set (no mutations / all brands flag-OFF) this is a no-op
    # and the universe is byte-identical to the pure watermark path (A.5.8).
    dirty_df = _read_dirty_set(spark, brands)
    dirty_rows: "list" = []
    if dirty_df is not None:
        dirty_rows = dirty_df.collect()
        dirty_uni = _dirty_session_universe(spark, brands, dirty_df, salts)
        sessions = sessions.unionByName(dirty_uni).dropDuplicates(
            ["brand_id", "brain_anon_id", "session_id_raw", "session_key"]
        )
        print(f"[{JOB_NAME}] re-stitch drain: {len(dirty_rows)} dirty key(s) → folding historical sessions",
              flush=True)

    matched = _session_identifiers(spark, brands, salts, sessions)
    matched.persist()

    counts = _write_iceberg(spark, matched)

    # Legacy dual-write + conflict→review bridge (flag-on → always here). Best-effort PG mirror.
    counts["dual_written"] = _dual_write_legacy(spark, brands)
    counts["reviews"] = _bridge_conflicts_to_review(spark, brands)

    # Drain the re-stitch dirty set ONLY NOW — after the MERGE committed (crash-safe: a crash before this
    # leaves the rows for the next run; the idempotent MERGE makes reprocessing harmless).
    counts["drained"] = _drain_dirty_set(spark, brands, dirty_rows) if dirty_rows else 0

    # Advance the watermark to the max touch updated_at we just processed (side-table; AUD-IMPL-014: the
    # watermark axis is the touchpoint FOLD time `updated_at`, matching _session_map's filter, so a
    # late-arriving/backfilled touch — old occurred_at, fresh updated_at — is picked up next run).
    # Written last → a crash never advances past unprocessed data. NOTE on axis cutover: a watermark
    # persisted by the old occurred_at code is an EVENT-time max, which trails the ingest axis → the
    # first run after this change re-folds a wider slice (idempotent MERGE → harmless).
    try:
        new_wm = (
            spark.table(TOUCHPOINT_TABLE).where(F.col("brand_id").isin(brands))
            .selectExpr("max(updated_at) AS m").collect()[0]["m"]
        )
        write_job_watermark(spark, JOB_NAME, new_wm)
    except Exception as exc:  # noqa: BLE001 — watermark advance failure → next run reprocesses (safe, MERGE)
        print(f"[{JOB_NAME}] watermark advance skipped: {exc}", flush=True)

    matched.unpersist()
    print(
        f"[{JOB_NAME}] DONE brands={len(brands)} stitched={counts['stitched']} "
        f"conflicts={counts['conflicts']} dual_written={counts['dual_written']} reviews={counts['reviews']} "
        f"restitch_drained={counts['drained']}",
        flush=True,
    )
    return counts["si_fqtn"], counts["stitched"]


def main() -> None:
    spark = build_spark("silver-session-identity")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("silver-session-identity", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
        print(f"[silver-session-identity] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-session-identity", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
