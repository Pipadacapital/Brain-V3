"""
_silver_technical.py — Brain V4 Stage-1 TECHNICAL-PROCESSING shared layer for Bronze→Silver.

The 40 silver_*.py jobs already do canonical mapping + dedup + PII-hash + money-minor (Stage-2 BUSINESS
truth, via _silver_base.merge_on_pk + _raw_normalize ports). What was MISSING was an EXPLICIT, reusable
Stage-1 in front of them: technical processing that every connector shares BEFORE the canonical rollup —
  (1) schema validation / evolution policy (required/unknown/wrong-type),
  (2) a unified DQ-quarantine for business-validity violations (negative money, bad currency, future ts…),
  (3) non-PII string cleaning (trim/collapse/NFC; names titlecased) — PII stays on the EXISTING
      _raw_normalize.normalize_email / normalize_phone_in (hash-only; raw PII never reaches Silver),
  (4) deterministic intra-entity event ordering so a rollup folds order→payment→shipment in time order.

DESIGN MIRRORS _raw_normalize.py: every primitive here is a PURE PYTHON function (no Spark import at module
load — the Spark sink helpers import pyspark lazily inside the function body). So the ports are unit-testable
with plain `python3` against golden vectors (_silver_technical_test.py), exactly like the _p4_golden suite,
and the Spark jobs udf-wrap the SAME verified functions.

TWO-STAGE FORMALIZATION (Technical → Business):
  Stage-1 TECHNICAL  = validate_schema (+ schema_policy) → clean_string/clean_name → event_order_key
  Stage-1 DQ         = dq_check  (business-validity gate; failures → write_quarantine(stage='dq'))
  Stage-2 BUSINESS   = the existing canonical silver_*.py rollup (merge_on_pk on the entity PK)
Records that fail Stage-1 go to brain_silver.silver_quarantine — NEVER to the canonical Silver table; the
original row is UNTOUCHED in Bronze (replay-safe: fix the policy, re-run, it re-admits).

HARD RULES: brand_id is the tenant key + FIRST column. Money is bigint MINOR units + sibling currency_code
(never float/blended). PII is hash-only (this layer never lowercases/cleans an id or hash; only non-PII
strings). Idempotent + replay-safe.
"""
from __future__ import annotations  # Spark image is Python 3.8.

import re
import unicodedata

# ======================================================================================================
# (1) SCHEMA VALIDATION / EVOLUTION  — pure, Spark-UDF-wrappable
# ======================================================================================================
# validate_schema returns a STATUS + reason; the policy mapper (schema_policy) decides the ACTION. Kept
# separate so a connector can override the policy (e.g. accept a known-additive field) without touching the
# detector. Severity order is fixed: missing-required (most severe) > wrong-type > unknown-field > ok.
SCHEMA_OK = "ok"
SCHEMA_MISSING = "missing"
SCHEMA_WRONG_TYPE = "wrong_type"
SCHEMA_UNKNOWN = "unknown"

# Schema-evolution ACTIONS the policy can choose.
ACTION_ACCEPT = "accept"     # admit to the canonical rollup
ACTION_QUARANTINE = "quarantine"  # divert to silver_quarantine (stage='schema')
ACTION_EVOLVE = "evolve"     # admit + signal the table should grow a column (additive)
ACTION_REJECT = "reject"     # drop (Bronze still holds the original)

# Type tokens validate_schema understands. Deliberately small + JSON-payload shaped.
_TYPE_CHECKERS = {
    "string": lambda v: isinstance(v, str),
    "int": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: (isinstance(v, (int, float)) and not isinstance(v, bool)),
    "bool": lambda v: isinstance(v, bool),
    "array": lambda v: isinstance(v, (list, tuple)),
    "object": lambda v: isinstance(v, dict),
    # money/currency/timestamp accept the over-the-wire STRING form (the connectors carry decimal strings
    # + ISO timestamps as strings); deep validity is dq_check's job, not the schema gate's.
    "money": lambda v: isinstance(v, (str, int)) and not isinstance(v, bool),
    "currency": lambda v: isinstance(v, str),
    "timestamp": lambda v: isinstance(v, (str, int)) and not isinstance(v, bool),
}


def validate_schema(payload, required_fields, known_fields=None, types=None):
    """Stage-1 schema check on a raw payload dict.

    Args:
      payload:         the decoded source payload (a dict).
      required_fields: fields that MUST be present & non-null.
      known_fields:    the full known field set (None ⇒ skip the unknown-field check). Anything outside
                       it is "unknown" (a possible schema evolution / drift signal).
      types:           optional {field: type_token} map (tokens in _TYPE_CHECKERS).

    Returns (status, reason). Severity order: missing > wrong_type > unknown > ok. The caller turns the
    status into an action via schema_policy().
    """
    if not isinstance(payload, dict):
        return (SCHEMA_WRONG_TYPE, "payload is not an object")

    missing = [f for f in required_fields if f not in payload or payload[f] is None]
    if missing:
        return (SCHEMA_MISSING, "missing required: " + ", ".join(sorted(missing)))

    if types:
        for field, token in types.items():
            if field in payload and payload[field] is not None:
                checker = _TYPE_CHECKERS.get(token)
                if checker is not None and not checker(payload[field]):
                    return (SCHEMA_WRONG_TYPE, f"field {field!r} expected {token}, got {type(payload[field]).__name__}")

    if known_fields is not None:
        known = set(known_fields)
        unknown = [f for f in payload if f not in known]
        if unknown:
            return (SCHEMA_UNKNOWN, "unknown fields: " + ", ".join(sorted(unknown)))

    return (SCHEMA_OK, "")


# Default policy: missing-required → quarantine; wrong-type → quarantine; unknown-field → accept (+log so
# drift is observable, NOT silently dropped); ok → accept. A connector may pass its own mapping (e.g.
# unknown→evolve once it wants the column).
_DEFAULT_SCHEMA_POLICY = {
    SCHEMA_OK: ACTION_ACCEPT,
    SCHEMA_MISSING: ACTION_QUARANTINE,
    SCHEMA_WRONG_TYPE: ACTION_QUARANTINE,
    SCHEMA_UNKNOWN: ACTION_ACCEPT,
}


def schema_policy(status, overrides=None):
    """Map a validate_schema status → an evolution ACTION. Default per the spec; `overrides` wins."""
    policy = dict(_DEFAULT_SCHEMA_POLICY)
    if overrides:
        policy.update(overrides)
    return policy.get(status, ACTION_QUARANTINE)


# ======================================================================================================
# (2) DQ CHECK  — business-validity violations (pure). Returns [] when clean.
# ======================================================================================================
_ISO4217_RE = re.compile(r"^[A-Z]{3}$")  # ISO-4217 alpha-3, UPPERCASE (e.g. INR, USD, KWD).
_INT_TS_RE = re.compile(r"^\d{10,}$")     # bare epoch (s or ms) as a string.

# Defaults: a 5-minute clock-skew grace for "future" timestamps; an absurd-quantity ceiling that no real
# single line item reaches but that catches a sign-flip / unit error.
DEFAULT_SKEW_MS = 5 * 60 * 1000
DEFAULT_ABSURD_QTY = 1_000_000


def _to_epoch_ms(value):
    """Best-effort parse of an occurred_at value (ISO-8601 string OR epoch s/ms) → int ms, or None if
    unparseable. Mirrors the lenient _raw_normalize time handling but never throws."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        v = int(value)
        # Heuristic: >1e12 ⇒ already ms; else seconds.
        return v if v >= 1_000_000_000_000 else v * 1000
    s = str(value).strip()
    if not s:
        return None
    if _INT_TS_RE.match(s):
        v = int(s)
        return v if v >= 1_000_000_000_000 else v * 1000
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except (ValueError, OverflowError):
        return None


def dq_check(
    record,
    *,
    now_ms=None,
    max_skew_ms=DEFAULT_SKEW_MS,
    required_ids=None,
    absurd_qty=DEFAULT_ABSURD_QTY,
):
    """Stage-1 DQ gate over a (partly-)canonical record dict. Returns a list of violation codes ([] = clean).

    Rules (all from the spec, all deterministic):
      - negative_amount        amount_minor < 0
      - invalid_currency       currency_code present & not ISO-4217 alpha-3 (UPPERCASE)
      - missing_currency       amount_minor present but currency_code empty (money must carry a sibling)
      - unparseable_timestamp  occurred_at present but NULL/again-unparseable
      - future_occurred_at     occurred_at > now + skew
      - impossible_quantity    quantity < 0 or > absurd ceiling
      - empty_identifier:<f>   a required identifier (in required_ids) is missing/empty

    Money is bigint MINOR units: amount_minor must be an int (or an int-shaped string). A FLOAT amount_minor
    is itself a violation (money is never a float).
    """
    violations = []

    has_amount = "amount_minor" in record and record["amount_minor"] is not None
    amount = None
    if has_amount:
        raw = record["amount_minor"]
        if isinstance(raw, bool):
            violations.append("non_integer_amount")
        elif isinstance(raw, float):
            violations.append("non_integer_amount")  # money is never a float
        elif isinstance(raw, int):
            amount = raw
        else:
            s = str(raw).strip()
            if re.match(r"^-?\d+$", s):
                amount = int(s)
            else:
                violations.append("non_integer_amount")
        if amount is not None and amount < 0:
            violations.append("negative_amount")

    cur = record.get("currency_code")
    if cur is not None and str(cur).strip() != "":
        if not _ISO4217_RE.match(str(cur).strip()):
            violations.append("invalid_currency")
    elif has_amount:
        # Money present without a sibling currency — never blend / assume.
        violations.append("missing_currency")

    if "occurred_at" in record:
        ms = _to_epoch_ms(record["occurred_at"])
        if ms is None:
            violations.append("unparseable_timestamp")
        else:
            ref = now_ms if now_ms is not None else _now_ms()
            if ms > ref + max_skew_ms:
                violations.append("future_occurred_at")

    if "quantity" in record and record["quantity"] is not None:
        q = record["quantity"]
        try:
            qi = int(q) if not isinstance(q, bool) else None
        except (ValueError, TypeError):
            qi = None
        if qi is None:
            violations.append("impossible_quantity")
        elif qi < 0 or qi > absurd_qty:
            violations.append("impossible_quantity")

    for field in (required_ids or []):
        v = record.get(field)
        if v is None or str(v).strip() == "":
            violations.append(f"empty_identifier:{field}")

    return violations


def _now_ms():
    import time
    return int(time.time() * 1000)


# ======================================================================================================
# (3) NON-PII STRING CLEANING  — pure. NEVER touches ids/hashes/PII (those use _raw_normalize ports).
# ======================================================================================================
_WS_RE = re.compile(r"\s+")
# Word boundaries for name capitalization: start, or after whitespace / hyphen / apostrophe.
_NAME_BOUNDARY_RE = re.compile(r"(^|[\s\-'])([A-Za-zÀ-ɏ])")


def clean_string(s):
    """Trim, collapse internal whitespace to a single space, and NFC-normalize unicode. Returns None for
    None; preserves case (this is for arbitrary non-PII text, e.g. a product title or city). Idempotent."""
    if s is None:
        return None
    t = unicodedata.normalize("NFC", str(s))
    t = _WS_RE.sub(" ", t).strip()
    return t


def clean_name(s):
    """clean_string + titlecase-safe for a human/display name: each word's first letter upper, the rest
    lower (handles hyphen + apostrophe boundaries). "JOHN"/"john"/"  john  " → "John". Non-PII display
    field only — the HASHED identity lives on _raw_normalize.hash_identifier; this never sees raw PII used
    as a key."""
    t = clean_string(s)
    if t is None:
        return None
    if t == "":
        return ""
    t = t.lower()
    return _NAME_BOUNDARY_RE.sub(lambda m: m.group(1) + m.group(2).upper(), t)


# ======================================================================================================
# (4) EVENT ORDERING  — deterministic intra-entity sort key (pure).
# ======================================================================================================
def event_order_key(record):
    """Deterministic sort key for ordering events WITHIN an entity before the rollup (e.g. fold
    order→payment→shipment in time order). Tuple (occurred_ms, source_ms, sequence) — all coerced to int,
    a missing/unparseable component sorts FIRST (0) so it never jumps ahead of a real later event. Total
    order, stable across runs."""
    occurred_ms = _to_epoch_ms(record.get("occurred_at")) or 0
    source_ms = _to_epoch_ms(record.get("source_ts") or record.get("ingested_at")) or 0
    seq = record.get("sequence")
    try:
        seq_i = int(seq) if seq is not None and not isinstance(seq, bool) else 0
    except (ValueError, TypeError):
        seq_i = 0
    return (occurred_ms, source_ms, seq_i)


def event_order_key_str(record):
    """event_order_key as a single lexicographically-sortable STRING (zero-padded occurred:source:seq).
    Lets a Spark window ORDER BY a single column reproduce the tuple order — used as an ADDITIVE final
    tiebreaker so a fold is totally ordered + replay-stable on exact ties (never changes the winner for
    well-formed data). Pure; same total order as event_order_key."""
    o, s, q = event_order_key(record)
    return f"{o:020d}:{s:020d}:{q:012d}"


# ======================================================================================================
# (5) BUSINESS-VALIDATION RULES  — Stage-2 (BUSINESS) gates, pure. Each returns the violation code(s) the
# caller diverts to write_quarantine(stage='business'). Distinct from dq_check (Stage-1 technical validity)
# in that these encode DOMAIN rules that need entity context (a payment must be positive money; a refund
# cannot predate its order; an inactive campaign cannot be credited a conversion).
# ======================================================================================================
def validate_payment_amount(amount_minor, *, is_money_bearing=True):
    """A money-bearing payment must be a POSITIVE integer minor-unit amount.

    - None amount               → [] (a behavioral marker, e.g. a pixel 'initiated'/'failed' with no money —
                                  NOT a money-bearing payment; nothing to validate).
    - float / bool amount       → ['non_integer_amount'] (money is never a float).
    - negative                  → ['negative_payment_amount'].
    - zero & is_money_bearing    → ['zero_payment_amount'] (an authorized/paid/succeeded payment of 0 is invalid;
                                  a non-money-bearing marker with 0 is allowed → [] ).
    """
    if amount_minor is None:
        return []
    if isinstance(amount_minor, bool) or isinstance(amount_minor, float):
        return ["non_integer_amount"]
    if isinstance(amount_minor, int):
        amt = amount_minor
    else:
        s = str(amount_minor).strip()
        if not re.match(r"^-?\d+$", s):
            return ["non_integer_amount"]
        amt = int(s)
    if amt < 0:
        return ["negative_payment_amount"]
    if amt == 0 and is_money_bearing:
        return ["zero_payment_amount"]
    return []


def validate_refund_timing(refund_occurred, order_occurred):
    """A refund cannot economically precede the order it refunds.

    Returns (violations, order_unresolved):
      - order ref UNRESOLVABLE (order_occurred None/unparseable) → ([], True): we FLAG rather than hard-drop
        (the refund is real; the order spine may simply not be built yet — a later run resolves it). The
        caller keeps the row in the canonical table with an additive order_unresolved=true flag.
      - refund_occurred unparseable → ([], False): a timestamp-validity concern dq_check owns, not a timing
        violation here.
      - refund strictly before order → (['refund_before_order'], False): a BUSINESS reject → quarantine.
      - otherwise → ([], False).
    """
    order_ms = _to_epoch_ms(order_occurred)
    if order_ms is None:
        return ([], True)
    refund_ms = _to_epoch_ms(refund_occurred)
    if refund_ms is None:
        return ([], False)
    if refund_ms < order_ms:
        return (["refund_before_order"], False)
    return ([], False)


def inactive_campaign_conversion_flag(is_active, conversions):
    """The inactive-campaign-cannot-receive-conversion rule, as a FLAG (never a drop): True iff the campaign
    is EXPLICITLY inactive (is_active is False) AND it nonetheless carries conversion activity (>0).

    is_active None (status unknown) → never flagged, so a well-formed/unknown campaign row is UNCHANGED.
    Conversions is coerced to int (non-int → 0). This is advisory: the caller writes the boolean to a new
    additive column and keeps the row in the canonical dimension (it is data the attribution layer must see,
    not discard)."""
    try:
        c = int(conversions) if conversions is not None and not isinstance(conversions, bool) else 0
    except (ValueError, TypeError):
        c = 0
    return (is_active is False) and c > 0


# ======================================================================================================
# QUARANTINE SINK  — Spark-side (pyspark imported lazily so the pure ports above test without Spark).
# ======================================================================================================
# stage ∈ {schema, dq, business}: WHERE in the 2-stage pipeline the record was diverted.
QUARANTINE_TABLE = "silver_quarantine"
# brand_id FIRST (tenant). canonical_target = the silver_* table the row was bound for. payload = the
# original source payload string (so the row is replayable from the quarantine record alone too).
QUARANTINE_COLUMNS_SQL = """
          brand_id        STRING,
          source          STRING,
          bronze_event_id STRING,
          canonical_target STRING,
          stage           STRING,
          reason          STRING,
          payload         STRING,
          quarantined_at  TIMESTAMP
""".strip("\n")
QUARANTINE_PARTITION = "bucket(256, brand_id), days(quarantined_at)"


def ensure_quarantine_table(spark):
    """Idempotently create brain_silver.silver_quarantine (Iceberg). brand_id-first, partitioned by
    bucket(brand_id)+days(quarantined_at). Returns the FQTN."""
    import os
    import sys

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from iceberg_base import SILVER_NAMESPACE, create_iceberg_table  # noqa: E402

    return create_iceberg_table(
        spark, SILVER_NAMESPACE, QUARANTINE_TABLE, QUARANTINE_COLUMNS_SQL,
        partitioned_by=QUARANTINE_PARTITION,
    )


def write_quarantine(spark, df_of_rejects, stage):
    """Append rejected rows to silver_quarantine, stamping `stage` + quarantined_at. The caller supplies a
    DataFrame carrying at least (brand_id, source, bronze_event_id, canonical_target, reason, payload); the
    canonical Silver table is NEVER written for these rows, and Bronze keeps the untouched original.

    stage ∈ {schema, dq, business}. Idempotent at the dataset level via re-run is the caller's concern (the
    Bronze→Stage-1 pass is deterministic, so re-running the SAME Bronze produces the SAME quarantine rows);
    quarantine is an append-only diagnostic ledger, not a keyed entity.
    """
    if stage not in ("schema", "dq", "business"):
        raise ValueError(f"quarantine stage must be schema|dq|business, got {stage!r}")
    from pyspark.sql.functions import current_timestamp, lit  # noqa: E402

    fqtn = ensure_quarantine_table(spark)
    out = (
        df_of_rejects
        .withColumn("stage", lit(stage))
        .withColumn("quarantined_at", current_timestamp())
        .select("brand_id", "source", "bronze_event_id", "canonical_target", "stage", "reason", "payload",
                "quarantined_at")
    )
    out.writeTo(fqtn).append()
    return fqtn


# ======================================================================================================
# SPARK UDF WRAPPERS  — udf-wrap the SAME pure ports above so a job applies them as columns (pyspark
# imported lazily inside each factory; the pure ports stay testable with plain python3). Each factory
# returns a fresh pyspark UDF Column-callable.
# ======================================================================================================
def clean_name_udf():
    """Spark UDF(string) → cleaned display name (clean_name). For NON-PII name fields ONLY."""
    from pyspark.sql.functions import udf
    from pyspark.sql.types import StringType
    return udf(clean_name, StringType())


def clean_string_udf():
    """Spark UDF(string) → trimmed/collapsed/NFC string (clean_string). NON-PII text only."""
    from pyspark.sql.functions import udf
    from pyspark.sql.types import StringType
    return udf(clean_string, StringType())


def dq_violations_udf(*, now_ms=None, max_skew_ms=DEFAULT_SKEW_MS, required_ids=None, absurd_qty=DEFAULT_ABSURD_QTY):
    """Spark UDF(amount_minor, currency_code, occurred_at, quantity) → array<string> of dq_check codes.

    A column passed as NULL is OMITTED from the checked record (so a job opts INTO exactly the fields it
    wants gated — e.g. customer passes only currency_code). occurred_at must be a STRING (cast the timestamp)
    so the pure parser sees an ISO string, not a datetime. [] ⇒ clean."""
    from pyspark.sql.functions import udf
    from pyspark.sql.types import ArrayType, StringType

    def _f(amount_minor=None, currency_code=None, occurred_at=None, quantity=None):
        rec = {}
        if amount_minor is not None:
            rec["amount_minor"] = amount_minor
        if currency_code is not None:
            rec["currency_code"] = currency_code
        if occurred_at is not None:
            rec["occurred_at"] = occurred_at
        if quantity is not None:
            rec["quantity"] = quantity
        return dq_check(rec, now_ms=now_ms, max_skew_ms=max_skew_ms, required_ids=required_ids, absurd_qty=absurd_qty)

    return udf(_f, ArrayType(StringType()))


def payment_amount_violations_udf():
    """Spark UDF(amount_minor, is_money_bearing) → array<string> (validate_payment_amount)."""
    from pyspark.sql.functions import udf
    from pyspark.sql.types import ArrayType, StringType

    def _f(amount_minor, is_money_bearing):
        return validate_payment_amount(amount_minor, is_money_bearing=bool(is_money_bearing))

    return udf(_f, ArrayType(StringType()))


def refund_timing_udf():
    """Spark UDF(refund_occurred:string, order_occurred:string) → struct<violations:array<string>,
    order_unresolved:boolean> (validate_refund_timing). Pass timestamps cast to STRING."""
    from pyspark.sql.functions import udf
    from pyspark.sql.types import ArrayType, BooleanType, StringType, StructField, StructType

    schema = StructType([
        StructField("violations", ArrayType(StringType())),
        StructField("order_unresolved", BooleanType()),
    ])

    def _f(refund_occurred, order_occurred):
        violations, unresolved = validate_refund_timing(refund_occurred, order_occurred)
        return (violations, unresolved)

    return udf(_f, schema)


def inactive_conversion_flag_udf():
    """Spark UDF(is_active:boolean, conversions) → boolean (inactive_campaign_conversion_flag)."""
    from pyspark.sql.functions import udf
    from pyspark.sql.types import BooleanType
    return udf(inactive_campaign_conversion_flag, BooleanType())


def event_order_key_str_udf():
    """Spark UDF(occurred_at:string, source_ts:string, sequence) → sortable key string (event_order_key_str).
    Pass timestamps cast to STRING; use as an additive final ORDER BY tiebreaker."""
    from pyspark.sql.functions import udf
    from pyspark.sql.types import StringType

    def _f(occurred_at=None, source_ts=None, sequence=None):
        return event_order_key_str({"occurred_at": occurred_at, "source_ts": source_ts, "sequence": sequence})

    return udf(_f, StringType())
