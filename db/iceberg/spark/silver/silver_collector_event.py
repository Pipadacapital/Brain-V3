"""
silver_collector_event.py — Brain V4 / ADR-0006 P2: the ADMISSION GATE moved into Spark Silver.

Under ADR-0006 the Kafka Connect Iceberg sink writes the collector topic to a TRULY RAW Bronze table
(brain_bronze.collector_events_raw) — no R2/R3 gate, no canonicalization. This job is the gate the Spark
Bronze sink (bronze_materialize.py gate_and_map) used to apply, lifted to Silver:

  brain_bronze.collector_events_raw  →  [R2 tenant + R3 consent gate + lane split + dedup]  →  brain_silver.silver_collector_event

`silver_collector_event` has the SAME column contract as the old (Spark-sink-written) Bronze
`collector_events` table (event_id/brand_id/occurred_at/ingested_at/schema_name/schema_version/
event_type/correlation_id/partition_key/payload/…), so EVERY downstream Silver job repoints from
brain_bronze.collector_events → brain_silver.silver_collector_event with NO other change (they read
`payload` via get_json_object exactly as before).

WHY a reconstructed `payload`: the Connect JsonConverter exploded the envelope into typed/struct columns
(properties + consent_flags are STRUCTs, there is no verbatim JSON string). Downstream readers do
get_json_object(payload,'$.properties.X'), so we rebuild payload = to_json(struct(all raw cols)) — a
faithful re-serialization of the envelope, restoring the `payload`-is-the-full-envelope contract.

GATE (faithful port of gate_and_map — Iceberg parity with the PG/Spark admission set):
  - malformed drop: event_id / brand_id / occurred_at NULL → never written.
  - LEDGER_ONLY (settlement.live.v1) → excluded (consumed by a ledger bridge, never a Bronze row).
  - SERVER_TRUSTED lane (order.live.v1, spend.live.v1, shipment/AWB, …): brand_id is already
    server-derived → trust the claimed brand_id (no install_token, no consent signal).
  - PIXEL lane (everything else): R3 = consent_flags present (else quarantine); R2 = resolve brand from
    properties.install_token via pixel.pixel_installation (INNER join drops tenant_unresolved) and drop
    claimed≠derived (brand_mismatch). brand_id = the DERIVED brand.
  - DEDUP on (brand_id, event_id) keeping latest ingested — the Connect sink APPENDS (at-least-once), so
    the de-dup the Spark MERGE used to do now lives here (replay/​redelivery-safe).

IDEMPOTENT: MERGE on (brand_id, event_id). Re-running over the same raw Bronze yields identical rows.

STAGE-1 GATE (Brain V4 two-stage): this admission gate used to SILENTLY DROP every rejected row (malformed
envelope, R3 consent-missing, R2 tenant-unresolved, R2 brand-mismatch). Each silent drop is now ROUTED
through _silver_technical.write_quarantine to brain_silver.silver_quarantine — observable + replayable —
with the SAME admission set (good rows byte-identical / parity-faithful), Bronze keeping the untouched
original:
  - malformed envelope (event_id / brand_id / occurred_at NULL = a MISSING required structural field) →
    stage='schema' (empty_identifier:* / unparseable_timestamp).
  - R3 consent_flags absent on a pixel event → stage='dq' (reason='consent_missing').
  - R2 install_token resolves to no tenant (was an INNER-join drop → now a LEFT join + capture) →
    stage='dq' (reason='tenant_unresolved').
  - R2 claimed brand_id ≠ install-derived brand_id → stage='dq' (reason='brand_mismatch').
LEDGER_ONLY (settlement.live.v1) is an INTENTIONAL routing exclusion (consumed by the ledger bridge, never a
Bronze/Silver collector row) — NOT a data-quality reject — so it is excluded as before and NOT quarantined.
The reconstructed `payload` envelope is already hashed-PII-safe (the collector boundary hashes identifiers),
so it is threaded into the quarantine row for replay — no raw PII crosses this gate.
"""
from __future__ import annotations

import math
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import DataFrame, SparkSession  # noqa: E402
from pyspark.sql.functions import (  # noqa: E402
    coalesce, col, concat, concat_ws, current_timestamp, get_json_object, lit, row_number, struct, to_json, to_timestamp, when,
)
from pyspark.sql.window import Window  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
from _silver_technical import write_quarantine  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
# V4 REPOINT: the Kafka-Connect Iceberg sink that wrote `collector_events_raw` was RETIRED (Spark-SS is
# the sole Bronze landing). The live collector lane now lands in `collector_events` (bronze_materialize.py),
# whose `payload` column already IS the full envelope JSON. Reading the retired `_raw` table froze the
# entire Silver tier at the Kafka-Connect cut-over date (new orders/pixels/spend never reached Silver).
RAW_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.{os.environ.get('COLLECTOR_BRONZE_TABLE', 'collector_events')}"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"

# Lane policy — MUST stay in lockstep with bronze_materialize.py (the same constants, same meaning).
SERVER_TRUSTED = {
    "order.live.v1", "order.backfill.v1", "spend.live.v1", "shopflo.checkout_abandoned.v1",
    "gokwik.rto_predict.v1", "shiprocket.shipment_status.v1",
    # SR-4: shiprocket.return_status.v1 is the SEPARATE return canonical (brand server-derived via the
    # webhook pipeline — MT-1; no install_token/consent → server-trusted lane). Kept BYTE-IDENTICAL with
    # bronze_materialize.SERVER_TRUSTED_BRONZE. It is NOT the shipment lane, so a return is never folded
    # as a forward shipment status (the false-delivery bug SR-4 fixes).
    "shiprocket.return_status.v1",
    # GoKwik webhook-first canonical events (brand server-derived from gokwik_appid via the
    # webhook pipeline — no install_token/consent, so they MUST take the server-trusted lane, not the
    # PIXEL lane that would quarantine them). RETIRED: gokwik.awb_status.v1 + gokwik.webhook.v1 (the
    # wrong AWB/opaque-envelope model — see docs/architecture/gokwik-connector-reimplementation.md).
    "checkout.abandoned.v1", "gokwik.checkout_started.v1", "gokwik.checkout_step.v1",
    "payment.attempted.v1", "payment.authorized.v1",
    # CRIT-4: the Shopify CONNECTOR-derived RESOURCE events. Emitted by the Shopify backfill/repull/webhook
    # path with a server-derived brand_id (MT-1, from the resolved connector row — NEVER the API response)
    # and NO install_token / consent signal. Without server-trust they fell to the PIXEL lane and were
    # SILENTLY DROPPED by the R2 join on a null install_token, starving silver_refund / silver_fulfillment /
    # silver_product_variant / silver_inventory_level (all of which read THIS gated keystone). They take the
    # SAME lane as order.live.v1 (server-derived, no pixel signal). Kept BYTE-IDENTICAL with
    # bronze_materialize.SERVER_TRUSTED_BRONZE.
    "product.upsert.v1", "customer.upsert.v1", "refund.recorded.v1", "fulfillment.recorded.v1",
    # WOO-3: coupon.upsert.v1 is the NEW canonical coupon grain (no Shopify peer). The WooCommerce
    # connector emits it server-derived (brand_id from the resolved connector row, MT-1 — NEVER the API
    # response) with NO install_token / consent signal, so — exactly like the CRIT-4 resource events — it
    # MUST take the server-trusted lane or the PIXEL-lane R2 install_token join would SILENTLY DROP it and
    # starve silver_coupon. Kept BYTE-IDENTICAL with bronze_materialize.SERVER_TRUSTED_BRONZE.
    "coupon.upsert.v1",
    # AD-1: ad.entity.updated is the SHARED Meta+Google entity-metadata canonical (campaign/adset/ad
    # name/status/objective/advertising_channel_type), emitted by meta-entity-sync / google-entity-sync on
    # the SAME live collector lane as spend.live.v1 — connector-derived (brand_id server-derived from the
    # resolved connector row, MT-1; NO install_token / consent). Without server-trust the PIXEL-lane R2 join
    # SILENTLY DROPS it (tenant_unresolved) and starves silver_campaign's authoritative dim. BYTE-IDENTICAL
    # with bronze_materialize.SERVER_TRUSTED_BRONZE.
    "ad.entity.updated",
    # SHOPFLO lifecycle: the NEW Shopflo checkout-funnel canonicals (webhook-first; brand_id server-derived
    # from the resolved connector row via the webhook pipeline — MT-1; NO install_token / consent). Like
    # checkout.abandoned.v1 they MUST take the server-trusted lane or the PIXEL-lane R2 join would drop them
    # and starve silver_checkout_signal. Kept BYTE-IDENTICAL with bronze_materialize.SERVER_TRUSTED_BRONZE.
    "shopflo.checkout_started.v1", "shopflo.checkout_step.v1", "shopflo.checkout_completed.v1",
}
LEDGER_ONLY = {"settlement.live.v1"}

# Postgres pixel_installation — install_token → brand_id for R2. Superuser read (cross-brand, RLS-bypass
# ETL posture), mirroring bronze_materialize.load_pixel_installations + resolve_brand_by_install_token.
PG_JDBC_URL = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("BRONZE_PG_USER", "brain")
PG_PASSWORD = os.environ.get("BRONZE_PG_PASSWORD", "brain")

COLUMNS_SQL = """
  event_id          string  NOT NULL,
  brand_id          string  NOT NULL,
  occurred_at       timestamp NOT NULL,
  ingested_at       timestamp NOT NULL,
  schema_name       string  NOT NULL,
  schema_version    int     NOT NULL,
  event_type        string  NOT NULL,
  correlation_id    string,
  partition_key     string  NOT NULL,
  payload           string  NOT NULL
"""


def _load_installs(spark: SparkSession) -> DataFrame:
    return (
        spark.read.format("jdbc")
        .option("url", PG_JDBC_URL)
        .option("user", PG_USER)
        .option("password", PG_PASSWORD)
        .option("driver", "org.postgresql.Driver")
        .option(
            "query",
            "SELECT install_token::text AS install_token, brand_id::text AS derived_brand_id FROM pixel.pixel_installation",
        )
        .load()
    )


def _process_window(spark: SparkSession, raw: DataFrame, installs: DataFrame) -> None:
    """Run the full Stage-1 gate (schema → consent → tenant) + dedup + MERGE for ONE bounded slice of
    raw Bronze (the adaptive-batch unit). Idempotent: MERGE on (brand_id, event_id) with a
    newer-ingested-wins guard, so batch boundaries / overlaps / re-runs never corrupt or double-count.
    `installs` is loaded once by the caller and broadcast here (it's small + constant across batches)."""
    from pyspark.sql.functions import broadcast  # local import keeps the module import surface minimal

    # bronze_materialize's `collector_events.payload` IS the verbatim full envelope JSON, so the
    # downstream get_json_object('$.properties.X') readers work unchanged — no struct reconstruction.
    # The flat envelope fields come straight off the materialized columns; install_token + the R3
    # consent signal are parsed out of the payload (collector_events has no struct properties/consent cols).
    selected = raw.select(
        col("event_id").cast("string").alias("event_id"),
        col("brand_id").cast("string").alias("claimed_brand_id"),
        col("event_type").cast("string").alias("event_type"),
        col("occurred_at").alias("occurred_at"),
        coalesce(col("ingested_at"), col("received_at"), current_timestamp()).alias("ingested_at"),
        col("correlation_id").cast("string").alias("correlation_id"),
        get_json_object(col("payload"), "$.properties.install_token").alias("install_token"),
        # R3 signal: the consent_flags object PRESENT in the envelope (non-null string) vs absent (null).
        get_json_object(col("payload"), "$.consent_flags").alias("consent_flags_raw"),
        col("payload").cast("string").alias("payload"),
    )

    _qsource = coalesce(col("event_type"), lit("collector"))
    _qtarget = lit("silver_collector_event")

    # ── Stage-1 SCHEMA gate: a malformed envelope (missing required event_id / brand_id / occurred_at) →
    #    quarantine (stage='schema') instead of the old silent drop. Same admission set.
    _wellformed = col("event_id").isNotNull() & col("claimed_brand_id").isNotNull() & col("occurred_at").isNotNull()
    write_quarantine(
        spark,
        selected.where(~_wellformed).select(
            col("claimed_brand_id").alias("brand_id"),
            _qsource.alias("source"),
            col("event_id").alias("bronze_event_id"),
            _qtarget.alias("canonical_target"),
            concat_ws(
                ",",
                when(col("event_id").isNull(), lit("empty_identifier:event_id")),
                when(col("claimed_brand_id").isNull(), lit("empty_identifier:brand_id")),
                when(col("occurred_at").isNull(), lit("unparseable_timestamp")),
            ).alias("reason"),
            col("payload"),
        ),
        stage="schema",
    )

    # LEDGER_ONLY is an INTENTIONAL routing exclusion (ledger bridge), NOT a reject — excluded, never quarantined.
    base = selected.where(_wellformed).where(~col("event_type").isin(*LEDGER_ONLY))

    server = base.where(col("event_type").isin(*SERVER_TRUSTED)).withColumn("brand_id", col("claimed_brand_id"))

    pixel_candidates = base.where(~col("event_type").isin(*SERVER_TRUSTED))

    # ── Stage-1 DQ gate (R3 consent): a pixel event with no consent_flags → quarantine (stage='dq'). ──────
    write_quarantine(
        spark,
        pixel_candidates.where(col("consent_flags_raw").isNull()).select(
            col("claimed_brand_id").alias("brand_id"),
            _qsource.alias("source"),
            col("event_id").alias("bronze_event_id"),
            _qtarget.alias("canonical_target"),
            lit("consent_missing").alias("reason"),
            col("payload"),
        ),
        stage="dq",
    )
    consent_ok = pixel_candidates.where(col("consent_flags_raw").isNotNull())  # R3

    # ── Stage-1 DQ gate (R2 tenant resolution): LEFT join so an unresolved install_token is CAPTURED (the
    #    old INNER join silently dropped it), then brand_mismatch — both → quarantine (stage='dq'). ─────────
    resolved = consent_ok.join(broadcast(installs), "install_token", "left")
    write_quarantine(
        spark,
        resolved.where(col("derived_brand_id").isNull()).select(
            col("claimed_brand_id").alias("brand_id"),
            _qsource.alias("source"),
            col("event_id").alias("bronze_event_id"),
            _qtarget.alias("canonical_target"),
            lit("tenant_unresolved").alias("reason"),
            col("payload"),
        ),
        stage="dq",
    )
    matched = resolved.where(col("derived_brand_id").isNotNull())
    write_quarantine(
        spark,
        matched.where(col("claimed_brand_id") != col("derived_brand_id")).select(
            col("claimed_brand_id").alias("brand_id"),
            _qsource.alias("source"),
            col("event_id").alias("bronze_event_id"),
            _qtarget.alias("canonical_target"),
            lit("brand_mismatch").alias("reason"),
            col("payload"),
        ),
        stage="dq",
    )
    pixel = (
        matched.where(col("claimed_brand_id") == col("derived_brand_id"))  # R2: admit only claimed==derived
        .withColumn("brand_id", col("derived_brand_id"))
    )

    def project(df):
        return df.select(
            col("event_id"), col("brand_id"), col("occurred_at"), col("ingested_at"),
            lit("brain.collector.event.v1").alias("schema_name"), lit(1).alias("schema_version"),
            col("event_type"), col("correlation_id"),
            concat(col("brand_id"), lit(":"), col("event_id")).alias("partition_key"),
            col("payload"),
        )

    gated = project(server).unionByName(project(pixel))
    # DEDUP on (brand_id, event_id), latest ingested wins (the Connect sink is at-least-once).
    w = Window.partitionBy("brand_id", "event_id").orderBy(col("ingested_at").desc())
    deduped = gated.withColumn("_rn", row_number().over(w)).where(col("_rn") == 1).drop("_rn")

    deduped.createOrReplaceTempView("_gated_collector")
    # Newer-ingested-wins guard makes the MERGE order-independent: when the same (brand_id,event_id)
    # appears across adaptive batches (or a watermark overlap), the latest-ingested copy always wins,
    # never an older one — so batching/replay can't regress a row.
    spark.sql(
        f"""
        MERGE INTO {TARGET} t
        USING _gated_collector s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED AND s.ingested_at >= t.ingested_at THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def build(spark: SparkSession):
    """Bronze→Silver collector-event gate, processed INCREMENTALLY in ADAPTIVE bounded batches so peak
    memory is O(new data) — not O(all-time history) — and a backlog (e.g. a fresh backfill) drains in
    bounded chunks instead of one giant OOM-prone job. Scales by SIZE here; scale by VELOCITY (a huge
    brand) by pointing the same job at a Spark cluster with more executors — the code is unchanged and
    the table is already brand_id-partitioned. See docs/ops/local-memory-budget.md.

    Knobs (env): FULL_REFRESH=1 (ignore watermark — backfills/schema changes);
    SILVER_INCREMENTAL_OVERLAP_HOURS (re-scan window, MERGE dedups; default 2);
    SILVER_BATCH_TARGET_ROWS (rows per adaptive batch; default 500k); SILVER_MAX_CHUNKS (cap; default 48)."""
    create_iceberg_table(
        spark, SILVER_NAMESPACE, "silver_collector_event", COLUMNS_SQL,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )

    # AQE: let Spark coalesce shuffle partitions + split skew at RUNTIME (adaptive WITHIN each batch),
    # and cap input split size so even a full reprocess streams in small tasks rather than few huge ones.
    for _k, _v in {
        "spark.sql.adaptive.enabled": "true",
        "spark.sql.adaptive.coalescePartitions.enabled": "true",
        "spark.sql.adaptive.skewJoin.enabled": "true",
        "spark.sql.files.maxPartitionBytes": str(128 * 1024 * 1024),
    }.items():
        spark.conf.set(_k, _v)

    raw_all = spark.table(RAW_TABLE)

    # ── INCREMENTAL WATERMARK ───────────────────────────────────────────────────────────────────────
    # Process only Bronze rows newer than what Silver already has (minus a small overlap; the MERGE
    # dedups). FULL_REFRESH=1 ignores it; an empty target (first run) → full scan.
    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    overlap_hours = int(os.environ.get("SILVER_INCREMENTAL_OVERLAP_HOURS", "2"))
    wm = None
    if not full_refresh:
        try:
            wm = spark.sql(f"SELECT max(ingested_at) AS wm FROM {TARGET}").collect()[0]["wm"]
        except Exception:
            wm = None  # target absent/empty → full scan
    src = raw_all
    if wm is not None:
        src = raw_all.where(col("ingested_at") >= lit(wm - timedelta(hours=overlap_hours)))

    installs = _load_installs(spark)  # small + constant — load once, broadcast per batch

    # ── ADAPTIVE BATCHING ───────────────────────────────────────────────────────────────────────────
    # Size the number of batches to the ACTUAL delta: ~SILVER_BATCH_TARGET_ROWS per batch. Steady state
    # → 1 small batch; a large backlog → many bounded batches (time-windowed, processed oldest-first so
    # the newer-ingested-wins MERGE stays correct). The delta is watermark-bounded, so count() is cheap.
    rng = src.selectExpr("min(ingested_at) AS lo", "max(ingested_at) AS hi").collect()[0]
    lo_ts, hi_ts = rng["lo"], rng["hi"]
    if lo_ts is None:  # nothing new since the watermark
        n = spark.sql(f"SELECT COUNT(*) AS n FROM {TARGET}").collect()[0]["n"]
        return TARGET, n

    target_rows = max(1, int(os.environ.get("SILVER_BATCH_TARGET_ROWS", "500000")))
    max_chunks = max(1, int(os.environ.get("SILVER_MAX_CHUNKS", "48")))
    total = src.count()
    n_chunks = max(1, min(max_chunks, math.ceil(total / target_rows)))

    _mode = "FULL_REFRESH" if full_refresh else ("INCREMENTAL" if wm is not None else "FIRST_FULL")
    print(
        f"[silver-collector-event] {_mode}: delta={total} rows over [{lo_ts} .. {hi_ts}] "
        f"→ {n_chunks} adaptive batch(es) (~{target_rows} rows/batch, driver heap {os.environ.get('SPARK_DRIVER_MEMORY', '4g')})",
        flush=True,
    )

    if n_chunks == 1 or hi_ts == lo_ts:
        _process_window(spark, src, installs)
    else:
        span = (hi_ts - lo_ts) / n_chunks  # timedelta per batch
        for i in range(n_chunks):
            start = lo_ts + span * i
            window = src.where(col("ingested_at") >= lit(start))
            if i < n_chunks - 1:  # last batch has no upper bound → catches hi_ts exactly
                window = window.where(col("ingested_at") < lit(lo_ts + span * (i + 1)))
            _process_window(spark, window, installs)

    n = spark.sql(f"SELECT COUNT(*) AS n FROM {TARGET}").collect()[0]["n"]
    return TARGET, n


def main() -> None:
    import time

    spark = build_spark("silver-collector-event")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("silver-collector-event", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
        print(f"[silver-collector-event] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-collector-event", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
