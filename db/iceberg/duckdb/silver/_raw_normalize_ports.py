"""
_raw_normalize_ports.py (DuckDB) — VENDORED-VERBATIM copy of the PURE normalization primitives the Spark
raw→canonical normalize jobs depend on, lifted from db/iceberg/spark/silver/_raw_normalize.py.

Only the PURE functions the 7 *_normalize jobs apply as columns are copied here (no Spark import surface).
They are BYTE-IDENTICAL to the Spark ports (same regex, same branch order, same null/None semantics) and are
exposed to DuckDB via con.create_function(...) in each job — exactly as the Spark jobs udf-wrap the same
functions. Keeping them here (rather than importing the Spark module) avoids pulling `import pyspark` at
module load and honours the "vendor-copy any PURE spark helper into duckdb/silver/" rule.

FAITHFULNESS NOTES the DuckDB seam must preserve for byte-exact parity:
  - hash_identifier(value, kind, salt_hex): salt_hex is a STRING interpolated as `f"{salt_hex}||{normalized}"`.
    When the per-brand salt LEFT-join MISSES (brand not in PG), Spark's UDF receives salt_hex=None and Python
    renders it as the LITERAL "None" — verified live against the shopify shadow oracle
    (sha256("None||smoke@example.com") == the oracle hash). The DuckDB UDF is fed the SAME NULL → same "None".
  - money is bigint MINOR units, integer arithmetic only, never a float; malformed → None (row quarantined
    upstream — this port never coerces).
  - uuid_shaped is the sha256→16B→v5-nibble→RFC-4122-variant→8-4-4-4-12 event_id crypto (the dedup key).
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone


# ── Money (I-S07, integer-only, never float) ─────────────────────────────────────────────────────────
_DECIMAL_RE = re.compile(r"^\d+(\.\d{1,2})?$")


def decimal_to_minor_strict(s):
    """Shopify/Woo decimal price string → int minor units (decimalStringToMinor). Malformed → None."""
    if s is None:
        return None
    t = str(s).strip()
    if not _DECIMAL_RE.match(t):
        return None
    if "." not in t:
        return int(t) * 100
    whole, frac = t.split(".", 1)
    frac = (frac + "00")[:2]
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
    """E.164 IN normalization — @brain/identity-core normalizePhone (IN)."""
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
    """@brain/identity-core hashIdentifier — sha256( salt_hex || '||' || normalized(value) ). salt_hex is a
    STRING with a '||' separator; a NULL salt renders as the literal 'None' (Spark-UDF parity, verified)."""
    if kind == "email":
        normalized = normalize_email(value)
    elif kind == "phone":
        normalized = normalize_phone_in(value, region)
    else:
        normalized = value.strip()
    return _sha256_hex(f"{salt_hex}||{normalized}")


def hash_salted_bytes(value, salt_hex):
    """The OTHER convention (AWB / Razorpay ids / UTR): sha256( bytes.fromhex(salt_hex) ++ utf8(lower(trim)) ),
    salt as HEX BYTES, NO separator. A NULL salt_hex cannot bytes.fromhex → returns None (row's hash null)."""
    if salt_hex is None:
        return None
    return hashlib.sha256(bytes.fromhex(salt_hex) + (value or "").strip().lower().encode("utf-8")).hexdigest()


# ── Identity: uuid-shaped event_id ────────────────────────────────────────────────────────────────────
def uuid_shaped(inp):
    """@brain/connector-core hashToUuidShaped — sha256(input) → first 16 bytes → version nibble 0x5,
    RFC-4122 variant → 8-4-4-4-12 dash form."""
    b = bytearray(hashlib.sha256(inp.encode("utf-8")).digest()[:16])
    b[6] = (b[6] & 0x0F) | 0x50
    b[8] = (b[8] & 0x3F) | 0x80
    hx = b.hex()
    return f"{hx[0:8]}-{hx[8:12]}-{hx[12:16]}-{hx[16:20]}-{hx[20:32]}"


def _escape_breakdown_token(s):
    return str(s).replace("\\", "\\\\").replace("|", "\\|").replace("=", "\\=")


def canonical_breakdown_key(dims):
    """canonicalBreakdownKey — present dims name=value, escaped, sorted by name, joined by '|'; empty → ''."""
    pairs = []
    for name in sorted(dims.keys()):
        raw = dims[name]
        if raw is None:
            continue
        value = str(raw)
        if value == "":
            continue
        pairs.append(f"{_escape_breakdown_token(name)}={_escape_breakdown_token(value)}")
    return "|".join(pairs)


def event_id_order_live(brand_id, order_id, updated_at_ms):
    """uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs)."""
    return uuid_shaped(f"{brand_id}:{order_id}:{updated_at_ms}:order.live.v1")


# ── Time (JS Date semantics, ms precision) ────────────────────────────────────────────────────────────
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
    """new Date(raw).getTime() — integer epoch milliseconds."""
    if raw is None:
        return None
    return int(_parse_utc(raw).timestamp() * 1000)


# ── Money family (provider-specific; all integer-only, minor units, never float) ──────────────────────
_MAJOR_DECIMAL_RE = re.compile(r"^(\d+)(?:\.(\d+))?$")  # ad-spend: allows >2 frac, rounds DOWN to 2
_INT_RE = re.compile(r"^\d+$")
_COUNT_RE = re.compile(r"^(\d+)(?:\.\d+)?$")
_MONEY_STRICT2_RE = re.compile(r"^\d+(\.\d{1,2})?$")  # shopflo: at most 2 dp, else raise


def major_decimal_to_minor(value):
    """ad-spend majorDecimalToMinorString (Meta major-decimal → minor; cut beyond 2dp; null/empty → '0';
    malformed → None). BIGINT-as-string."""
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
    """ad-spend microsToMinorString (Google cost_micros // 10_000; null → '0'; non-int → None)."""
    if value is None:
        return "0"
    s = str(value).strip()
    if not _INT_RE.match(s):
        return None
    return str(int(s) // 10000)


def to_count_string(value):
    """ad-spend toCountString (integer-part-only count string; null/empty/malformed → None)."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    m = _COUNT_RE.match(s)
    return m.group(1) if m else None


def money_to_minor_string(value):
    """shopflo moneyToMinorString (major → minor; null → '0'; >2dp/negative/non-numeric → RAISES like the TS
    throw — the build wrapper catches → quarantine)."""
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


# ── Time (gmt-naive variant, WooCommerce) ─────────────────────────────────────────────────────────────
_TZ_RE = re.compile(r"([zZ]$)|([+-]\d{2}:?\d{2}$)")


def iso_ms_assume_utc(value):
    """woocommerce toUtcIso — a *_gmt string is GMT but often lacks a tz suffix; append 'Z' when no offset,
    then iso_ms (.mmmZ). None on empty."""
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if not _TZ_RE.search(raw):
        raw = raw + "Z"
    return iso_ms(raw)


# ── Logistics status → terminal_class (shiprocket + gokwik, frozen authority) ─────────────────────────
_RTO_TERMINAL = {
    "rto", "rto initiated", "rto in transit", "rto undelivered", "rto out for delivery",
    "rto delivered", "rto ofd", "rto acknowledged", "rto rejected", "rto ndr", "rto disposed",
}
_DELIVERED_TERMINAL = {"delivered", "completed"}
_OTHER_TERMINAL = {
    "cancelled", "lost", "damaged", "returned", "canceled", "destroyed", "disposed", "disposed of",
}


def normalize_status(raw):
    """Lower + collapse [_-]/whitespace → canonical status token."""
    s = (raw or "").strip().lower()
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s


def classify_terminal_class(raw):
    """status → terminal_class in {rto, delivered, other, none} — the frozen 3-set authority."""
    s = normalize_status(raw)
    if s in _RTO_TERMINAL:
        return "rto"
    if s in _DELIVERED_TERMINAL:
        return "delivered"
    if s in _OTHER_TERMINAL:
        return "other"
    return "none"
