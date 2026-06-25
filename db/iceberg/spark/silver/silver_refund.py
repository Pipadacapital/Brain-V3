"""
silver_refund.py — GAP canonical Silver `refund` entity (Brain V4 Phase 1b, GROUP storefront).

GAP table (matrix §1: refund.processed / refund.recorded.v1 → silver_refund — "only folded into
recognition" today, no canonical Silver). Built here as a Spark→Iceberg Silver job reading raw Iceberg
Bronze, dual-run BESIDE the dbt brain_silver (no reader/dbt repoint — additive, non-breaking).

SOURCE  : rest.brain_bronze.collector_events WHERE event_type IN ('refund.recorded.v1','refund.processed')
          Emitted by @brain/shopify-mapper resources.ts::mapRefundToDraft (RefundRecordedProperties):
            source, shopify_refund_id, refund_id, order_id, amount_minor (settled total, I-S07 minor),
            currency_code (honest-null when the refund payload omits it), reason (the refund note).
          'refund.processed' is accepted as a forward-compatible alias (matrix names both); whichever
          a future connector emits lands in the SAME canonical row.
GRAIN   : 1 row per (brand_id, event_id) — the Bronze idempotency key (one refund → one stable id →
          one deterministic event_id; a re-pull re-emits the SAME id → latest-ingested-wins MERGE = idempotent).
MONEY   : amount_minor is bigint MINOR units (settled refund total) + currency_code. brand_id is the
          tenant key, first column + the bucket() partition anchor.
PII     : refund_id / order_id are opaque store refs (not person-linkable); the mapper drops raw PII at
          its boundary. This job NEVER sees or stores a raw contact/financial identifier.

DATA AVAILABILITY (this session): current Bronze has ZERO refund.* rows (no connector has synced refunds
yet — order events fold refunds into recognition, but the dedicated refund resource is unsynced), so this
writes a correct EMPTY table over current Bronze. Schema + transform are the deliverable; a Shopify/Woo
refund repull populates it with no code change. Parity status=NEW (no dbt/StarRocks refund baseline).
"""
from __future__ import annotations

from _silver_base import (
    ensure_silver_table,
    merge_on_pk,
    prop,
    read_bronze_events,
    run_job,
)
from pyspark.sql.functions import coalesce, col, lit

TABLE = "silver_refund"

# brand_id-first; money = bigint minor + currency_code; opaque refs only (hashed-PII discipline).
COLUMNS_SQL = """
          brand_id        string    NOT NULL,
          event_id        string    NOT NULL,
          source          string,
          refund_id       string,
          order_id        string,
          amount_minor    bigint,
          currency_code   string,
          reason          string,
          status          string,
          occurred_at     timestamp NOT NULL,
          ingested_at     timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    raw = read_bronze_events(spark, ["refund.recorded.v1", "refund.processed"])
    staged = raw.select(
        col("brand_id"),
        col("event_id"),
        prop("pj", "source").alias("source"),
        # refund_id is the canonical id; shopify_refund_id is the source-specific alias on the same payload.
        coalesce(prop("pj", "refund_id"), prop("pj", "shopify_refund_id")).alias("refund_id"),
        prop("pj", "order_id").alias("order_id"),
        # Money: BIGINT minor units (settled refund total) — cast the string property to bigint, default 0.
        coalesce(prop("pj", "amount_minor").cast("bigint"), lit(0).cast("bigint")).alias("amount_minor"),
        # currency_code is honest-null at the mapper when the refund payload omits it — carry the null through.
        prop("pj", "currency_code").alias("currency_code"),
        prop("pj", "reason").alias("reason"),
        # status is not emitted by the current shopify refund mapper; nullable for forward-compat connectors.
        prop("pj", "status").alias("status"),
        col("occurred_at"),
        col("ingested_at"),
    ).where(col("event_id").isNotNull() & col("brand_id").isNotNull())

    merge_on_pk(spark, fqtn, staged, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-refund", build)
