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

STAGE-1 GATE (Brain V4 two-stage): runs the Stage-2 BUSINESS rule _silver_technical.validate_refund_timing
  (a refund cannot economically precede its order) BEFORE the canonical MERGE, resolving the order time
  from the sibling silver_order_state spine (LEFT JOIN on brand_id+order_id → first_event_at):
    - refund strictly BEFORE its order   → quarantine (stage='business', reason='refund_before_order');
                                           NEVER written to silver_refund.
    - order ref UNRESOLVABLE (order not in the spine yet) → FLAG, do NOT drop: the row is written with the
      additive boolean column order_unresolved=true (a later run, once the order lands, re-admits it clean).
  Good rows are unchanged (order_unresolved=false). Idempotent/replay-safe (recompute over the same Bronze
  + spine is deterministic); Bronze keeps the original.

DATA AVAILABILITY (this session): current Bronze has ZERO refund.* rows (no connector has synced refunds
yet — order events fold refunds into recognition, but the dedicated refund resource is unsynced), so this
writes a correct EMPTY table over current Bronze. Schema + transform are the deliverable; a Shopify/Woo
refund repull populates it with no code change. Parity status=NEW (no dbt/StarRocks refund baseline).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _silver_base import (
    ensure_silver_table,
    merge_on_pk,
    prop,
    read_bronze_events,
    run_job,
)
from _silver_technical import refund_timing_udf, write_quarantine
from iceberg_base import CATALOG, SILVER_NAMESPACE
from pyspark.sql.functions import array_join, coalesce, col, lit, size
from pyspark.sql.utils import AnalysisException

TABLE = "silver_refund"

# brand_id-first; money = bigint minor + currency_code; opaque refs only (hashed-PII discipline).
# order_unresolved is an ADDITIVE Stage-1 flag: the refund's order ref was not resolvable in the spine at
# build time (flagged, not dropped — see validate_refund_timing). false for every well-formed refund.
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
          ingested_at     timestamp NOT NULL,
          order_unresolved boolean
""".strip("\n")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    raw = read_bronze_events(spark, ["refund.recorded.v1", "refund.processed"])
    base = raw.select(
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
        col("pj").alias("_payload"),
    ).where(col("event_id").isNotNull() & col("brand_id").isNotNull())

    # ── Resolve each refund's order time from the sibling order spine (LEFT JOIN; absent → unresolved) ──
    order_times = _read_order_times(spark)
    joined = base.join(order_times, ["brand_id", "order_id"], "left")

    # ── Stage-2 BUSINESS gate: a refund cannot precede its order; unresolvable order ref → flag ───────
    timing = refund_timing_udf()(
        col("occurred_at").cast("string"), col("_order_first_event_at").cast("string")
    )
    gate = joined.withColumn("_timing", timing)
    bad = gate.where(size(col("_timing.violations")) > 0)
    good = gate.where(size(col("_timing.violations")) == 0).select(
        col("brand_id"),
        col("event_id"),
        col("source"),
        col("refund_id"),
        col("order_id"),
        col("amount_minor"),
        col("currency_code"),
        col("reason"),
        col("status"),
        col("occurred_at"),
        col("ingested_at"),
        col("_timing.order_unresolved").alias("order_unresolved"),
    )

    rejects = bad.select(
        col("brand_id"),
        col("source"),
        col("event_id").alias("bronze_event_id"),
        lit(TABLE).alias("canonical_target"),
        array_join(col("_timing.violations"), ",").alias("reason"),
        col("_payload").alias("payload"),
    )
    write_quarantine(spark, rejects, stage="business")

    merge_on_pk(spark, fqtn, good, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


def _read_order_times(spark):
    """Read (brand_id, order_id, first_event_at) from the sibling silver_order_state spine for the refund
    timing rule. Absent (spine not built yet) → empty df → every refund's order resolves to NULL → flagged
    order_unresolved (validate_refund_timing), never dropped."""
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
    empty_schema = "brand_id string, order_id string, _order_first_event_at timestamp"
    try:
        return spark.table(fqtn).select(
            col("brand_id"), col("order_id"), col("first_event_at").alias("_order_first_event_at")
        )
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            print("[silver_refund] silver_order_state absent → refund order times NULL (all flagged unresolved)", flush=True)
            return spark.createDataFrame([], empty_schema)
        raise


if __name__ == "__main__":
    run_job("silver-refund", build)
