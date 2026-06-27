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

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import DataFrame, SparkSession  # noqa: E402
from pyspark.sql.functions import (  # noqa: E402
    coalesce, col, concat, concat_ws, current_timestamp, lit, row_number, struct, to_json, to_timestamp, when,
)
from pyspark.sql.window import Window  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
from _silver_technical import write_quarantine  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.collector_events_raw"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"

# Lane policy — MUST stay in lockstep with bronze_materialize.py (the same constants, same meaning).
SERVER_TRUSTED = {
    "order.live.v1", "order.backfill.v1", "spend.live.v1", "shopflo.checkout_abandoned.v1",
    "gokwik.rto_predict.v1", "gokwik.awb_status.v1", "gokwik.webhook.v1", "shiprocket.shipment_status.v1",
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


def build(spark: SparkSession):
    create_iceberg_table(
        spark, SILVER_NAMESPACE, "silver_collector_event", COLUMNS_SQL,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )

    raw = spark.table(RAW_TABLE)
    # Reconstruct the full envelope JSON from the exploded struct columns → restores the
    # payload-is-the-full-envelope contract the downstream get_json_object readers depend on.
    payload = to_json(struct(*[col(c) for c in raw.columns]))

    selected = raw.select(
        col("event_id").cast("string").alias("event_id"),
        col("brand_id").cast("string").alias("claimed_brand_id"),
        col("event_name").cast("string").alias("event_type"),
        to_timestamp(col("occurred_at")).alias("occurred_at"),
        coalesce(to_timestamp(col("_received_at")), current_timestamp()).alias("ingested_at"),
        col("correlation_id").cast("string").alias("correlation_id"),
        col("properties.install_token").cast("string").alias("install_token"),
        col("consent_flags").alias("consent_flags_raw"),  # R3 signal: PRESENT (struct non-null)
        payload.alias("payload"),
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

    installs = _load_installs(spark)
    from pyspark.sql.functions import broadcast  # local import keeps the module import surface minimal

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
    spark.sql(
        f"""
        MERGE INTO {TARGET} t
        USING _gated_collector s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
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
