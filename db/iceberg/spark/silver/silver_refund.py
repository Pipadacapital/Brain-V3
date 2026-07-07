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
#
# SPEC:C.2.1 (AMD-16 R1 — extend the live silver_refund, do NOT fork a new fact): the refund taxonomy +
# lineage columns the measurement engine needs are ADDED here (all nullable → additive-safe on the live,
# currently-empty table via create_iceberg_table's ALTER-ADD reconciler):
#   order_line_id   — line-scoped refund ref (nullable; whole-order refund → NULL).
#   reason_code     — normalized taxonomy: 'rto' (first-class) | 'return' | 'damaged' | 'cancellation'
#                     | 'customer_request' | 'other'. Derived from the free-text refund note.
#   refund_method   — 'original_payment' | 'store_credit' | 'cod_not_collected' | null (connector-honest;
#                     the current Shopify refund payload omits it → NULL, forward-compat).
#   initiated_at / settled_at — a refund.recorded.v1 is a SETTLED refund event, so both default to
#                     occurred_at (honest: the record IS the settlement moment); a future connector that
#                     splits initiate→settle can populate them distinctly with no schema change.
#   source_system / source_event_id — canonical lineage (source_system = the emitting platform;
#                     source_event_id = the Bronze event_id) required on every measurement fact.
COLUMNS_SQL = """
          brand_id        string    NOT NULL,
          event_id        string    NOT NULL,
          source          string,
          refund_id       string,
          order_id        string,
          order_line_id   string,
          amount_minor    bigint,
          currency_code   string,
          reason          string,
          reason_code     string,
          refund_method   string,
          status          string,
          initiated_at    timestamp,
          settled_at      timestamp,
          occurred_at     timestamp NOT NULL,
          ingested_at     timestamp NOT NULL,
          source_system   string,
          source_event_id string,
          order_unresolved boolean
""".strip("\n")


# SPEC:C.2.1 — normalize the free-text refund note into the reason_code taxonomy (RTO first-class). The
# ordered rule table is the SHARED pure source of truth (_measurement_taxonomy.REASON_CODE_RULES) so this
# Spark CASE and the C.2 unit test's Python classifier can never drift. Deterministic + replay-stable.
def _reason_code(reason_col):
    from _measurement_taxonomy import (
        DEFAULT_EMPTY,
        DEFAULT_WITH_NOTE,
        REASON_CODE_RULES,
    )
    from functools import reduce
    from pyspark.sql.functions import lower, when

    r = lower(reason_col)
    expr = when(r.isNull() | (r == lit("")), lit(DEFAULT_EMPTY))
    for substrings, code in REASON_CODE_RULES:
        match = reduce(lambda acc, s: acc | r.contains(s), substrings[1:], r.contains(substrings[0]))
        expr = expr.when(match, lit(code))
    return expr.otherwise(lit(DEFAULT_WITH_NOTE))


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
        # SPEC:C.2.1 — line-scoped refund ref (nullable; whole-order refund → NULL, forward-compat).
        prop("pj", "order_line_id").alias("order_line_id"),
        # Money: BIGINT minor units (settled refund total) — cast the string property to bigint, default 0.
        coalesce(prop("pj", "amount_minor").cast("bigint"), lit(0).cast("bigint")).alias("amount_minor"),
        # currency_code is honest-null at the mapper when the refund payload omits it — carry the null through.
        prop("pj", "currency_code").alias("currency_code"),
        prop("pj", "reason").alias("reason"),
        # SPEC:C.2.1 — normalized taxonomy (RTO first-class) derived from the free-text note.
        _reason_code(prop("pj", "reason")).alias("reason_code"),
        # SPEC:C.2.1 — refund_method: honest-null when the connector omits it (current Shopify payload does).
        prop("pj", "refund_method").alias("refund_method"),
        # status is not emitted by the current shopify refund mapper; nullable for forward-compat connectors.
        prop("pj", "status").alias("status"),
        # SPEC:C.2.1 — a refund.recorded.v1 IS the settlement moment; both timestamps default to occurred_at.
        col("occurred_at").alias("initiated_at"),
        col("occurred_at").alias("settled_at"),
        col("occurred_at"),
        col("ingested_at"),
        # SPEC:C.2.1 — canonical lineage on every measurement fact.
        coalesce(prop("pj", "source"), lit("unknown")).alias("source_system"),
        col("event_id").alias("source_event_id"),
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
        col("order_line_id"),
        col("amount_minor"),
        col("currency_code"),
        col("reason"),
        col("reason_code"),
        col("refund_method"),
        col("status"),
        col("initiated_at"),
        col("settled_at"),
        col("occurred_at"),
        col("ingested_at"),
        col("source_system"),
        col("source_event_id"),
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
    """Resolve (brand_id, order_id, _order_first_event_at) = the moment each order came into existence, for
    the refund-timing business rule (a refund cannot economically precede its order).

    SPEC:C.2.1 BUGFIX — this MUST be the order's CREATION time, i.e. min(occurred_at) over the order's
    order.{live,backfill}.v1 events in Bronze. It was previously read from silver_order_state.first_event_at,
    which for a REFUNDED order collapses to the refund-webhook's occurred_at (the deduped winning row), so a
    legitimately-timed refund (days after the order) was ~30s "before" that first_event_at and got
    false-quarantined refund_before_order (verified live on the golden a0a0 brand: 40 valid refunds dropped,
    silver_refund stranded at 0 rows). Folding the true creation time straight from the Bronze order lane
    removes the false positive while keeping the gate's intent (a refund before the order's birth is still a
    business reject). Absent Bronze → empty df → every refund resolves NULL → flagged order_unresolved
    (validate_refund_timing), never dropped."""
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
    empty_schema = "brand_id string, order_id string, _order_first_event_at timestamp"
    try:
        spark.table(fqtn).createOrReplaceTempView("_refund_order_src")
        return spark.sql(
            """
            SELECT brand_id,
                   get_json_object(payload, '$.properties.order_id') AS order_id,
                   min(occurred_at)                                  AS _order_first_event_at
            FROM _refund_order_src
            WHERE event_type IN ('order.live.v1', 'order.backfill.v1')
              AND get_json_object(payload, '$.properties.order_id') IS NOT NULL
            GROUP BY brand_id, get_json_object(payload, '$.properties.order_id')
            """
        )
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            print("[silver_refund] order lane absent → refund order times NULL (all flagged unresolved)", flush=True)
            return spark.createDataFrame([], empty_schema)
        raise


if __name__ == "__main__":
    run_job("silver-refund", build, target_table="silver_refund")
