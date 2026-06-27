"""
silver_engagement_signal.py — NET-NEW canonical Silver `engagement_signal` (Brain V4 Phase 1b, GROUP pixel).

NO dbt predecessor (parity status=NEW). The UX-QUALITY / engagement grain — one row per first-party pixel
engagement signal (a friction or interaction marker emitted by the universal collector). This normalizes the
four behavioral-quality pixel events into ONE shape so the engagement + UX-quality dashboards (and any
recommendation that wants "where do visitors struggle") read a single canonical surface instead of four
raw Bronze event shapes. Distinct from `silver_touchpoint` (the journey/attribution touch grain): this is
the friction/interaction signal grain, the events that say "the page is fighting the visitor", not the
events that move them through the funnel.

SOURCE  : rest.brain_bronze.collector_events — the four engagement signal pixel events:
            rage.click       — repeated rapid clicks in one spot (frustration); props x/y/count
            dead.click       — a click on a non-interactive element (broken affordance); props x/y/element
            scroll.depth     — a scroll-depth milestone reached; prop percent (0..100)
            element.clicked  — a tracked element click; prop element (selector/role)
GRAIN   : 1 row per (brand_id, event_id) — the Bronze idempotency key (replay-safe MERGE on it). signal_type
          is the normalized discriminant (rage_click | dead_click | scroll_depth | element_clicked).
CANONICAL COLUMNS (the union of the four event shapes, normalized):
            signal_type   — the normalized discriminant above.
            selector      — the clicked element/selector (dead.click/element.clicked `element`; NULL for the
                            position-only rage/scroll signals). NOT raw text content — a structural selector.
            scroll_pct    — the scroll-depth milestone percent (scroll.depth only; NULL otherwise).
            click_count   — the rage-click repeat count (rage.click only; NULL otherwise).
            pos_x, pos_y  — the click coordinates (rage/dead click; NULL for scroll/element-only signals).
            page          — landing_path, the page the signal fired on (the engagement dashboards group by it).
            session_id    — the client session the signal belongs to (engagement-per-session rollups).
            brain_anon_id — the pseudonymous visitor id (links the signal back to the journey/identity graph).
            device_class, viewport — coarse device context (desktop/mobile + WxH) for UX-quality slicing.
MONEY   : none — an engagement signal carries no money (it is a UX-quality marker, not a transaction). There
          is deliberately NO money column on this mart (registered with money_columns=[]).
PII     : pseudonymous-only — brain_anon_id is an opaque id (not raw PII); `selector` is a structural element
          selector/role, never user-entered text. NO raw contact/financial identifier is read or stored.
ISOLATION: brand_id is the FIRST column + the bucket() partition anchor (tenant isolation by construction).

STAGE-1 GATE (Brain V4 two-stage, _silver_technical): an engagement signal is a TIMESTAMPED behavioral
  event with NO money — so the ONLY Stage-1 DQ rule that genuinely applies is the timestamp gate. Each
  signal is run through dq_check (via dq_violations_udf, occurred_at only) and a row whose occurred_at is
  future-dated (> now + skew) or unparseable is diverted to brain_silver.silver_quarantine (stage='dq')
  and NEVER written to silver_engagement_signal; Bronze keeps the original (replay-safe). N/A here:
  money/currency rules (no money column), impossible_quantity (the int fields scroll_pct/click_count/x/y
  are coordinates/milestones, not a quantity), empty_identifier (brain_anon_id is nullable on this grain —
  a position-only rage/scroll signal can fire pre-identification), and clean_name/clean_string (no non-PII
  display name/title — `selector` is a structural element selector, not titlecased text). Good rows are
  byte-identical to before (parity-faithful).

DATA AVAILABILITY (this session): current Bronze HAS these signals (scroll.depth=585, element.clicked=383,
dead.click=127, rage.click=1) so this materializes a populated table. Parity status=NEW (no dbt
engagement-signal predecessor to compare against — the oracle emits SKIP reason=current-mart-absent).
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer `str | None` annotation eval.

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from _silver_technical import dq_violations_udf, write_quarantine
from pyspark.sql.functions import array_join, col, lit, size, when

TABLE = "silver_engagement_signal"

# The four behavioral-quality pixel events (universal collector taxonomy).
ENGAGEMENT_EVENTS = ["rage.click", "dead.click", "scroll.depth", "element.clicked"]

COLUMNS_SQL = """
          brand_id       string    NOT NULL,
          event_id       string    NOT NULL,
          signal_type    string    NOT NULL,
          selector       string,
          scroll_pct     int,
          click_count    int,
          pos_x          int,
          pos_y          int,
          page           string,
          session_id     string,
          brain_anon_id  string,
          device_class   string,
          viewport       string,
          occurred_at    timestamp NOT NULL,
          ingested_at    timestamp NOT NULL
""".strip("\n")


def _signal_type(event_type_col):
    """Normalize the four raw event_names to a stable signal_type discriminant (NEVER a model)."""
    return (
        when(event_type_col == "rage.click", lit("rage_click"))
        .when(event_type_col == "dead.click", lit("dead_click"))
        .when(event_type_col == "scroll.depth", lit("scroll_depth"))
        .when(event_type_col == "element.clicked", lit("element_clicked"))
        .otherwise(lit("unknown"))
    )


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    raw = read_bronze_events(spark, ENGAGEMENT_EVENTS)
    typed = raw.select(
        col("brand_id"),
        col("event_id"),
        _signal_type(col("event_type")).alias("signal_type"),
        # `element` is present on dead.click / element.clicked; NULL on the position-only rage/scroll signals.
        prop("pj", "element").alias("selector"),
        # scroll.depth carries `percent`; everything else NULL.
        prop("pj", "percent").cast("int").alias("scroll_pct"),
        # rage.click carries the repeat `count`; everything else NULL.
        prop("pj", "count").cast("int").alias("click_count"),
        prop("pj", "x").cast("int").alias("pos_x"),
        prop("pj", "y").cast("int").alias("pos_y"),
        prop("pj", "landing_path").alias("page"),
        prop("pj", "session_id").alias("session_id"),
        prop("pj", "brain_anon_id").alias("brain_anon_id"),
        prop("pj", "device.ua_class").alias("device_class"),
        prop("pj", "device.viewport").alias("viewport"),
        col("occurred_at"),
        col("ingested_at"),
        # Transient carriers for the Stage-1 gate (dropped before the canonical MERGE): the source
        # event_name (quarantine `source`) and the raw payload (replayable quarantine row).
        col("event_type").alias("_source_event"),
        col("pj").alias("_payload"),
    ).where(col("event_id").isNotNull() & col("brand_id").isNotNull())

    # ── Stage-1 DQ gate: timestamped signal → future/unparseable occurred_at → quarantine(stage='dq') ──
    gated = typed.withColumn(
        "_dq",
        dq_violations_udf()(
            lit(None).cast("bigint"), lit(None).cast("string"),
            col("occurred_at").cast("string"), lit(None).cast("bigint"),
        ),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            col("_source_event").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("_payload").alias("payload"),
        ),
        stage="dq",
    )
    staged = gated.where(size(col("_dq")) == 0).drop("_dq", "_payload", "_source_event")

    merge_on_pk(spark, fqtn, staged, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-engagement-signal", build)
