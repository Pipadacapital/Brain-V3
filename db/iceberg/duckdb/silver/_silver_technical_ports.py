"""
_silver_technical_ports.py (DuckDB) — VENDORED-VERBATIM copy of the PURE Stage-1 helpers the Spark
silver_collector_event gate depends on, lifted from db/iceberg/spark/silver/_silver_technical.py.

Only the two PURE functions the keystone gate applies as columns are copied (no Spark import surface):
  - event_category(event_type)                      → coarse category (Gap A), stored on every good row.
  - identify_consent_denied(event_type, consent_state, analytics_flag) → the SPEC A.1.2 / AMD-04
    denied-VALUE drop for IDENTIFY events (part of the R3 consent gate).

They are BYTE-IDENTICAL to the Spark ports (same branch order, same return values), and are exposed to
DuckDB via con.create_function(...) in silver_collector_event.py — exactly as the Spark job udf-wraps the
same functions. Keeping them here (rather than importing the Spark module) avoids pulling `import pyspark`
at module load and honours the "vendor-copy any PURE spark helper into duckdb/silver/" rule.
"""
from __future__ import annotations


# ── EVENT CATEGORY (verbatim port of _silver_technical.event_category) ────────────────────────────────
def event_category(event_type):
    """Map a CANONICAL event_type → one of {transaction, behaviour, fulfillment, support, marketing, other}.

    Prefix-first so new `.v1` events fall into the right bucket without an edit; unknown/empty → 'other'.
    Order matters: resource upserts + money/logistics/marketing are decided before the broad behaviour
    bucket so e.g. `payment.*` stays transaction and `product.upsert.v1` stays other (vs `product.viewed`
    → behaviour). BYTE-IDENTICAL to the Spark port."""
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
                        "pixel.identify.v1",                           # SPEC A.1.1 (WA-07): identity bridge
                        "coupon.applied", "download", "share"}         # pixel singletons (coupon.upsert.v1 → other above)
    if et in _behaviour_exact or et.startswith(_behaviour_prefixes) or "checkout" in et:
        return "behaviour"                                                     # browser + checkout-funnel signals
    return "other"


# ── IDENTIFY CONSENT-DENIED (verbatim port of _silver_technical.identify_consent_denied) ──────────────
IDENTIFY_EVENT_TYPES = ("identify", "pixel.identify.v1")


def identify_consent_denied(event_type, consent_state, analytics_flag):
    """True ⇒ this event is an IDENTIFY whose consent VALUE denies identity capture → consent_rejected.

    Inputs are the raw get_json_object strings:
      consent_state  — $.properties.consent_state of the WA-07 pixel.identify.v1 envelope
                       ('granted'|'denied'; anything present-but-not-'granted' is FAIL-CLOSED denied).
      analytics_flag — $.consent_flags.analytics of the collector envelope ('true'/'false' strings).
    Absent both signals → NOT denied here. BYTE-IDENTICAL to the Spark port."""
    if event_type not in IDENTIFY_EVENT_TYPES:
        return False
    if consent_state is not None:
        return str(consent_state).strip().lower() != "granted"
    if analytics_flag is not None and str(analytics_flag).strip().lower() == "false":
        return True
    return False
