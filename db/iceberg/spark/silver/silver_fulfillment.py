"""
silver_fulfillment.py — GAP canonical Silver `fulfillment` entity (Brain V4 Phase 1b, GROUP storefront).

GAP table (matrix §1: fulfillment.recorded.v1 → silver_fulfillment). The storefront-side fulfillment
grain — per-fulfillment status + tracking for an order, distinct from silver_shipment (the LOGISTICS-
carrier status from Shiprocket/GoKwik). Built here as a Spark→Iceberg Silver job reading raw Iceberg
Bronze, dual-run BESIDE the dbt brain_silver (additive, non-breaking — no reader/dbt repoint).

SOURCE  : rest.brain_bronze.collector_events WHERE event_type = 'fulfillment.recorded.v1'
          Emitted by @brain/shopify-mapper resources.ts::mapFulfillmentToDraft (FulfillmentRecordedProperties):
            source, shopify_fulfillment_id, fulfillment_id, order_id, status (success|cancelled|error|
            failure|pending|open), shipment_status (confirmed|in_transit|delivered|...), tracking_company,
            tracking_number. occurred_at = updated_at ?? created_at so a status change restates the row.
GRAIN   : 1 row per (brand_id, fulfillment_id) — the upstream-immutable fulfillment id (provider_id dedup).
          A status change re-emits the SAME fulfillment_id with a newer occurred_at → latest-ingested-wins
          MERGE carries the latest fulfillment state (idempotent re-pull). NOTE: keyed on fulfillment_id
          (NOT event_id) because the mapper folds updated_at into the dedup identity, so a status change is a
          DISTINCT Bronze event_id for the SAME fulfillment — we want the latest STATE, not one row per state.
MONEY   : none (fulfillment carries no money; revenue/refund truth lives in order/refund/settlement).
PII     : tracking_number is a carrier waybill ref (not person-linkable); no raw contact identifier here.
ISOLATION: brand_id first column + the bucket() partition anchor (tenant key on every row).

STAGE-1 GATE (Brain V4 two-stage): this is a timestamped event with NO money / NO quantity field, so the
  applicable Stage-1 DQ rule is the TIMESTAMP gate — _silver_technical.dq_check over occurred_at
  (future_occurred_at / unparseable_timestamp). A fulfillment whose occurred_at is unparseable or in the
  future (clock-skew beyond grace) is diverted to brain_silver.silver_quarantine (stage='dq') and NEVER
  written to silver_fulfillment; Bronze keeps the original (replay-safe). status / shipment_status /
  tracking_company are status enums + carrier refs (NOT human display names) and are stored as-is, so the
  clean_name/clean_string ports do not apply (no parity-altering string rewrite). Good rows are
  byte-identical to before (parity-faithful).

DATA AVAILABILITY (this session): current Bronze has ZERO fulfillment.recorded.v1 rows (the dedicated
fulfillment resource is unsynced — order.live.v1 carries only a coarse fulfillment_status string), so this
writes a correct EMPTY table over current Bronze. Schema + transform are the deliverable; a Shopify
fulfillment repull populates it with no code change. Parity status=NEW (no dbt/StarRocks baseline).
"""
from __future__ import annotations

from _silver_base import (
    ensure_silver_table,
    merge_on_pk,
    prop,
    read_bronze_events,
    run_job,
)
from _silver_technical import dq_violations_udf, write_quarantine
from pyspark.sql.functions import array_join, coalesce, col, lit, size

TABLE = "silver_fulfillment"

# brand_id-first; latest-state grain on fulfillment_id; no money column.
COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          fulfillment_id    string    NOT NULL,
          source            string,
          order_id          string,
          status            string,
          shipment_status   string,
          tracking_company  string,
          tracking_number   string,
          event_id          string,
          occurred_at       timestamp NOT NULL,
          ingested_at       timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    raw = read_bronze_events(spark, ["fulfillment.recorded.v1"])
    staged = raw.select(
        col("brand_id"),
        coalesce(prop("pj", "fulfillment_id"), prop("pj", "shopify_fulfillment_id")).alias("fulfillment_id"),
        prop("pj", "source").alias("source"),
        prop("pj", "order_id").alias("order_id"),
        prop("pj", "status").alias("status"),
        prop("pj", "shipment_status").alias("shipment_status"),
        prop("pj", "tracking_company").alias("tracking_company"),
        prop("pj", "tracking_number").alias("tracking_number"),
        # event_id retained as provenance (the per-state Bronze idempotency key) but NOT the grain key.
        col("event_id"),
        col("occurred_at"),
        col("ingested_at"),
        # Carry the raw payload so a quarantined reject is replayable from the quarantine row alone.
        col("pj").alias("_payload"),
    ).where(col("fulfillment_id").isNotNull() & col("brand_id").isNotNull())

    # ── Stage-1 DQ gate: timestamp validity only (no money / no quantity on a fulfillment) ────────────
    gated = staged.withColumn(
        "_dq",
        dq_violations_udf()(lit(None).cast("bigint"), lit(None).cast("string"), col("occurred_at").cast("string")),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            col("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("_payload").alias("payload"),
        ),
        stage="dq",
    )
    good = gated.where(size(col("_dq")) == 0).drop("_dq", "_payload")

    # Latest-state-wins on the fulfillment id: a status change is a newer-occurred_at re-emission.
    merge_on_pk(
        spark, fqtn, good, ["brand_id", "fulfillment_id"], order_by_desc=["occurred_at", "ingested_at"]
    )
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-fulfillment", build, target_table="silver_fulfillment")
