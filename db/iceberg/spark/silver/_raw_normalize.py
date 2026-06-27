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
import re
from datetime import datetime, timezone

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
