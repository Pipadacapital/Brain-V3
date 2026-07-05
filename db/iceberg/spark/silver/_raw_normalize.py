"""
_raw_normalize.py — ADR-0006 P4 SHARED normalization framework for the Spark-Silver raw→canonical ports.

Every connector that moves OFF a pre-normalized canonical event ONTO a raw provider payload (ADR-0006 P4)
normalizes in Spark Silver using these primitives, so each connector job collapses to its field-mapping.

DESIGN: each primitive is a PURE PYTHON reference implementation that is a BYTE-FOR-BYTE port of the
corresponding TypeScript function (the connector mappers + @brain/identity-core + @brain/connector-core),
verified against golden vectors captured from the real TS (see _p4_golden/ + the test). The Spark jobs
apply them as `udf`-wrapped column functions, so the Spark output is guaranteed identical to the verified
Python, which is identical to the TS — closing the parity loop without re-deriving the crypto in SQL.

PORTED FROM (keep in lockstep):
  - decimal_to_minor_strict      ← @brain/shopify-mapper decimalStringToMinor (I-S07; throws→here NULL/quarantine)
  - classify_payment             ← @brain/shopify-mapper classifyPaymentMethod
  - hash_identifier              ← @brain/identity-core hashIdentifier(value,type,salt) = sha256(salt || '||' || normalized)
  - normalize_email / normalize_phone_in ← @brain/identity-core normalizeIdentifier email/phone
  - uuid_shaped                  ← @brain/connector-core hashToUuidShaped (sha256→16B→v5 nibble→variant→8-4-4-4-12)
  - iso_ms / epoch_ms            ← JS new Date(x).toISOString() / getTime() (ms precision)

MONEY: bigint MINOR units, never float; emitted with a sibling currency_code; never blended.
PII: hashed-only; raw identifiers never stored. brand_id is server-trusted (MT-1) from the envelope.
"""
from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone


# ── BRONZE-SOURCE switch (bronze_landing.py unification / ADR-0010 Kafka Connect writer) ─────────────
# ONE env flips every raw-normalize reader:
#   BRONZE_SOURCE=legacy (default) → read the legacy per-provider *_raw table (current behavior).
#   BRONZE_SOURCE=events           → read the unified brain_bronze.events filtered to this connector
#                                    (the bronze_landing.py Spark-SS sink; G1 payload-parse pending).
#   BRONZE_SOURCE=connect          → the per-provider `<lane>_raw_connect` tables: the ADR-0010 Kafka
#                                    Connect Iceberg sink writes each raw lane to its OWN FRESH table
#                                    with the EXPLODED envelope schema (schemaless JsonConverter) these
#                                    jobs' struct-column reads were originally built against. Fresh
#                                    tables (not the legacy *_raw) because the Spark-written *_raw
#                                    schemas carry required (NOT NULL) columns — dedup_key/payload —
#                                    that an exploded Connect record can't satisfy (verified live: the
#                                    Parquet writer NPEs on the required-column null).
# Rollback = set BRONZE_SOURCE back. The unified events table carries the SAME raw payload/coords the
# *_raw tables did, plus the `connector` column used for the filter.
def bronze_source_table(catalog, namespace, legacy_table):
    """FQTN of the raw source — brain_bronze.events under BRONZE_SOURCE=events, the Connect-written
    `<legacy>_connect` table under BRONZE_SOURCE=connect, else the legacy per-provider *_raw."""
    mode = os.environ.get("BRONZE_SOURCE", "legacy").lower()
    if mode == "events":
        return f"{catalog}.{namespace}.events"
    if mode == "connect":
        return f"{catalog}.{namespace}.{legacy_table}_connect"
    return f"{catalog}.{namespace}.{legacy_table}"


def read_bronze(spark, catalog, namespace, legacy_table, connector):
    """Read a connector's raw Bronze — the unified events table (filtered to `connector`) under
    BRONZE_SOURCE=events, else the legacy per-provider *_raw table. The unified events table has a
    `connector` column (the legacy *_raw tables don't), so the filter is applied only there."""
    from pyspark.sql.functions import col  # noqa: E402 — lazy (keeps pure ports Spark-free)
    df = spark.table(bronze_source_table(catalog, namespace, legacy_table))
    if "connector" in df.columns:
        df = df.where(col("connector") == connector)
    return df


def dedupe_latest(df, keys, order_col):
    """Keep exactly ONE row per key tuple (latest `order_col` wins, NULLs last).

    REQUIRED under the ADR-0010 append-only Connect Bronze: the Iceberg sink has no MERGE, so a
    webhook redelivery / provider re-pull / topic replay lands DUPLICATE raw rows, and a Spark MERGE
    whose source carries duplicate join keys aborts with a cardinality violation. Applied to every
    normalize job's canonical frame just before its MERGE — a no-op when the batch is already unique
    (the bronze_raw_landing/legacy path), so it is safe under every BRONZE_SOURCE mode."""
    from pyspark.sql.functions import col, row_number  # noqa: E402 — lazy (keeps pure ports Spark-free)
    from pyspark.sql.window import Window  # noqa: E402

    w = Window.partitionBy(*keys).orderBy(col(order_col).desc_nulls_last())
    return df.withColumn("_rn", row_number().over(w)).where(col("_rn") == 1).drop("_rn")


# ── Money (I-S07, integer-only, never float) ─────────────────────────────────────────────────────────
_DECIMAL_RE = re.compile(r"^\d+(\.\d{1,2})?$")


def decimal_to_minor_strict(s):
    """Shopify/Woo decimal price string → int minor units. Mirrors decimalStringToMinor: regex-guarded,
    whole*100 + frac padEnd(2). The TS THROWS on a malformed string; in Silver we return None so the row
    is quarantined rather than crashing the batch (admission-set parity is preserved by the gate)."""
    if s is None:
        return None
    t = str(s).strip()
    if not _DECIMAL_RE.match(t):
        return None
    if "." not in t:
        return int(t) * 100
    whole, frac = t.split(".", 1)
    frac = (frac + "00")[:2]  # padEnd(2, '0')
    return int(whole) * 100 + int(frac)


# ── Payment classification (Shopify) ─────────────────────────────────────────────────────────────────
_COD_GATEWAYS = {"cash_on_delivery", "cod", "cash", "pay_on_delivery"}
_COD_GATEWAY_NAMES = ["cash on delivery", "cod", "pay on delivery", "manual"]


def classify_payment(gateway, gateway_names, financial_status):
    g = (gateway or "").lower()
    names = [(n or "").lower() for n in (gateway_names or [])]
    fs = (financial_status or "").lower()
    if g in _COD_GATEWAYS:
        return "cod"
    if any(any(c in n for c in _COD_GATEWAY_NAMES) for n in names):
        return "cod"
    if fs == "pending":
        return "cod"
    return "prepaid"


# ── Identity / PII (hashed-only) ─────────────────────────────────────────────────────────────────────
def _sha256_hex(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def normalize_email(value):
    return value.strip().lower()


def normalize_phone_in(value, region="IN"):
    """E.164 IN normalization — mirrors @brain/identity-core normalizePhone for the IN region: keep
    digits (and a leading +), 10-digit → +91XXXXXXXXXX, 0 + 10-digit → +91 + last 10, +91 + 10 passthrough."""
    if value is None:
        return ""
    cleaned = re.sub(r"[^\d+]", "", value)
    digits = re.sub(r"\D", "", cleaned)
    if cleaned.startswith("+91") and len(digits) == 12:
        return "+" + digits
    if len(digits) == 10:
        return "+91" + digits
    if len(digits) == 11 and digits.startswith("0"):
        return "+91" + digits[1:]
    if len(digits) == 12 and digits.startswith("91"):
        return "+" + digits
    return cleaned


def hash_identifier(value, kind, salt_hex, region="IN"):
    """@brain/identity-core hashIdentifier — sha256( salt_hex || '||' || normalized(value) ). Salt is a
    STRING with a '||' separator (the email/phone/storefront convention). kind ∈ {email, phone, external_id}."""
    if kind == "email":
        normalized = normalize_email(value)
    elif kind == "phone":
        normalized = normalize_phone_in(value, region)
    else:
        normalized = value.strip()
    return _sha256_hex(f"{salt_hex}||{normalized}")


def hash_salted_bytes(value, salt_hex):
    """The OTHER convention (AWB / Razorpay ids / UTR): sha256( bytes.fromhex(salt_hex) ++ utf8(lower(trim)) ),
    salt as HEX BYTES, NO separator. Kept distinct from hash_identifier so the two are never confused."""
    return hashlib.sha256(bytes.fromhex(salt_hex) + (value or "").strip().lower().encode("utf-8")).hexdigest()


# ── Identity: uuid-shaped event_id (the order_id-stable live event_id) ────────────────────────────────
def uuid_shaped(inp):
    """@brain/connector-core hashToUuidShaped — sha256(input) → first 16 bytes → version nibble 0x5,
    RFC-4122 variant → 8-4-4-4-12 dash form."""
    b = bytearray(hashlib.sha256(inp.encode("utf-8")).digest()[:16])
    b[6] = (b[6] & 0x0F) | 0x50
    b[8] = (b[8] & 0x3F) | 0x80
    hx = b.hex()
    return f"{hx[0:8]}-{hx[8:12]}-{hx[12:16]}-{hx[16:20]}-{hx[20:32]}"


def event_id_order_live(brand_id, order_id, updated_at_ms):
    """uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs) — Silver now derives the event_id the
    connector used to stamp, from the server-trusted brand_id + the raw order id + updated_at ms."""
    return uuid_shaped(f"{brand_id}:{order_id}:{updated_at_ms}:order.live.v1")


# ── Time (JS Date semantics, ms precision so event_id seeds + occurred_at match) ──────────────────────
def _parse_utc(raw):
    return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).astimezone(timezone.utc)


def iso_ms(*candidates):
    """First non-null candidate → new Date(x).toISOString() form: YYYY-MM-DDTHH:MM:SS.mmmZ (always .mmm)."""
    for c in candidates:
        if c:
            dt = _parse_utc(c)
            return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
    return None


def epoch_ms(raw):
    """new Date(raw).getTime() — integer epoch milliseconds (the event_id seed component)."""
    return int(_parse_utc(raw).timestamp() * 1000)


# ======================================================================================================
# P4 CONNECTOR PRIMITIVE PORTS — consolidated from the per-connector normalizers (ADR-0006 cutover
# follow-up). Each is a BYTE-FOR-BYTE port of a connector's TS helper; the per-connector golden tests
# (_p4_golden/test_<c>-golden.py) are the regression guard. The money ports are a FAMILY (not one fn):
# each provider has subtly different regex + null/throw semantics, deliberately preserved here.
# ======================================================================================================

# -- Money family (provider-specific; all integer-only, minor units, never float) ----------------------
_MAJOR_DECIMAL_RE = re.compile(r"^(\d+)(?:\.(\d+))?$")  # ad-spend: allows >2 frac, rounds DOWN to 2
_INT_RE = re.compile(r"^\d+$")
_COUNT_RE = re.compile(r"^(\d+)(?:\.\d+)?$")
_MONEY_STRICT2_RE = re.compile(r"^\d+(\.\d{1,2})?$")  # shopflo: at most 2 dp, else raise


def major_decimal_to_minor(value):
    """ad-spend majorDecimalToMinorString (Meta major-decimal -> minor; cut beyond 2dp; null/empty -> '0';
    malformed -> None/quarantine). Returns a BIGINT-as-string."""
    if value is None:
        return "0"
    s = str(value).strip()
    if s == "":
        return "0"
    m = _MAJOR_DECIMAL_RE.match(s)
    if not m:
        return None
    frac = (m.group(2) or "").ljust(2, "0")[:2]
    return str(int(m.group(1)) * 100 + int(frac))


def micros_to_minor(value):
    """ad-spend microsToMinorString (Google cost_micros // 10_000; null -> '0'; non-int -> None)."""
    if value is None:
        return "0"
    s = str(value).strip()
    if not _INT_RE.match(s):
        return None
    return str(int(s) // 10000)


def to_count_string(value):
    """ad-spend toCountString (integer-part-only count string; null/empty/malformed -> None)."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    m = _COUNT_RE.match(s)
    return m.group(1) if m else None


def money_to_minor_string(value):
    """shopflo moneyToMinorString (major -> minor; null -> '0' [NOT None]; >2dp/negative/non-numeric ->
    RAISES like the TS throw; the build wrapper catches -> quarantine)."""
    if value is None:
        return "0"
    if isinstance(value, bool):
        raise ValueError(f"invalid money value {value!r}")
    if isinstance(value, float):
        s = str(int(value)) if value.is_integer() else repr(value)
    elif isinstance(value, int):
        s = str(value)
    else:
        s = str(value).strip()
    if s == "":
        return "0"
    if not _MONEY_STRICT2_RE.match(s):
        raise ValueError(f"invalid money value {s!r} (I-S07)")
    if "." not in s:
        return str(int(s) * 100)
    whole, frac = s.split(".", 1)
    return str(int(whole) * 100 + int((frac + "00")[:2]))


# -- Time (gmt-naive variant) --------------------------------------------------------------------------
_TZ_RE = re.compile(r"([zZ]$)|([+-]\d{2}:?\d{2}$)")


def iso_ms_assume_utc(value):
    """woocommerce toUtcIso — a wc/v3 *_gmt string is GMT but often lacks a tz suffix; append 'Z' (treat
    as UTC) when no offset is present, then iso_ms (.mmmZ). None on empty."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if not _TZ_RE.search(raw):
        raw = raw + "Z"
    return iso_ms(raw)


# -- Logistics status -> terminal_class (the logistics-status frozen authority; shiprocket + gokwik) ----
_RTO_TERMINAL = {
    "rto", "rto initiated", "rto in transit", "rto undelivered", "rto out for delivery",
    "rto delivered", "rto ofd", "rto acknowledged", "rto rejected", "rto ndr", "rto disposed",
}
_DELIVERED_TERMINAL = {"delivered", "completed"}
_OTHER_TERMINAL = {
    "cancelled", "lost", "damaged", "returned", "canceled", "destroyed", "disposed", "disposed of",
}


def normalize_status(raw):
    """Lower + collapse [_-]/whitespace -> canonical status token (shared by shiprocket + gokwik)."""
    s = (raw or "").strip().lower()
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s


def classify_terminal_class(raw):
    """status -> terminal_class in {rto, delivered, other, none} — the frozen 3-set authority that drives
    the bigint-minor cod_rto_clawback downstream. In lockstep with packages/logistics-status."""
    s = normalize_status(raw)
    if s in _RTO_TERMINAL:
        return "rto"
    if s in _DELIVERED_TERMINAL:
        return "delivered"
    if s in _OTHER_TERMINAL:
        return "other"
    return "none"
