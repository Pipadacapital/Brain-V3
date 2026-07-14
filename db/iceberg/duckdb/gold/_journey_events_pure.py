"""
_journey_events_pure.py — VENDORED pure helpers for the DuckDB port of gold_journey_events.

Byte-copy of the ONE pure function gold_journey_events depends on: `event_category` from
db/iceberg/spark/silver/_silver_technical.py (the SoT event_type → coarse category mapping that
silver_collector_event.event_category / the Spark job's `brain_event_category` UDF use). Copied
verbatim (no pyspark deps) so the DuckDB tree is self-contained and survives Spark-tree deletion, and
so the EXECUTED categorization IS the unit-tested one (registered as a DuckDB scalar UDF, the analogue
of Spark's spark.udf.register("brain_event_category", event_category, StringType())).

Kept a byte-for-byte copy of _silver_technical.event_category — do NOT edit here; if the SoT mapping
changes in _silver_technical.py, re-copy.
"""
from __future__ import annotations


def event_category(event_type):
    """Map a CANONICAL event_type → one of {transaction, behaviour, fulfillment, support, marketing, other}.

    Pure/testable (no Spark). Prefix-first so new `.v1` events fall into the right bucket without an edit;
    unknown/empty → 'other'. Order matters: resource upserts + money/logistics/marketing are decided before
    the broad behaviour bucket so e.g. `payment.*` stays transaction and `product.upsert.v1` stays other
    (vs `product.viewed` → behaviour)."""
    et = (event_type or "").strip().lower()
    if not et:
        return "other"
    if et.endswith(".upsert.v1"):                                              # product/customer/coupon dims
        return "other"
    if et.startswith(("order.", "refund.", "payment.", "settlement.")):        # money-moving
        return "transaction"
    if et.startswith(("spend.", "ad.")):                                       # ad spend + ad-entity metadata
        return "marketing"
    if et.startswith(("shiprocket.", "fulfillment.")) or et == "gokwik.rto_predict.v1":  # logistics / RTO
        return "fulfillment"
    if et.startswith(("ticket.", "call.", "support.")):                        # reserved (none today)
        return "support"
    _behaviour_prefixes = ("page.", "product.", "collection.", "cart.", "session.", "scroll.",
                           "element.", "search.", "form.", "user.")   # user.* = pixel account funnel (login/signup)
    _behaviour_exact = {"dead.click", "rage.click", "exit_intent", "video", "identify",
                        "pixel.identify.v1",                           # SPEC A.1.1 (WA-07): identity bridge, same bucket as legacy identify
                        "coupon.applied", "download", "share"}         # pixel singletons (coupon.upsert.v1 → other above)
    if et in _behaviour_exact or et.startswith(_behaviour_prefixes) or "checkout" in et:
        return "behaviour"                                                     # browser + checkout-funnel signals
    return "other"
