# SPEC: A.1.3
"""
_identity_normalization.py — Python twin of @brain/identity-normalization (Wave A, WA-06).

BYTE-FOR-BYTE mirror of packages/identity-normalization/src/index.ts. Any change here MUST
land in the TS twin, and the A.5.2 cross-language property test
(_identity_normalization_xlang_test.py + packages/identity-normalization/src/a52-gen-corpus.ts —
10k+ generated identifiers, 0 mismatches) MUST pass. Hash drift silently destroys stitch rates.

One normalization, two hash spaces (AMD-01 — BINDING dual-convention):
  INTEROP  — interop_hash*  = plain unsalted sha256(normalized) → 64-hex (pixel + connector
             dual-write space, carried under pre_hashed_* identifier types per AMD-02).
  INTERNAL — internal_hash* = sha256( salt ‖ '||' ‖ normalized ) → 64-hex, the EXISTING
             per-brand-salted identity-core wire convention (same bytes as
             _raw_normalize.hash_identifier / @brain/identity-core saltedIdentifierSha256Hex).

Normalization (SPEC §A.1.3):
  Email — strip edge whitespace, lowercase, NFC. Gmail dots/plus NOT stripped
          (knowledge-base/amendments/ADR-normalization-gmail.md). Empty → None.
  Phone — E.164 via the `phonenumbers` lib (Google libphonenumber port) with the brand
          default country (IN/AE/SA/QA/BH/KW/OM). Unparseable OR invalid → None — NEVER a
          "cleaned digits" fallback (this deliberately fixes the old _raw_normalize
          normalize_phone_in fallback for the new identifier space). E.164 includes '+'.

DEPENDENCY: `phonenumbers` (pip). Pinned in db/iceberg/spark/Dockerfile so the prod image
matches the metadata the A.5.2 property test ran against. The dev docker-run path uses the
vanilla apache/spark image — jobs that consume phone normalization must ensure the dep
(the import below is lazy-guarded with a clear error so email-only consumers still work).

TRIM NOTE: JS String.trim and Python str.strip() disagree on the whitespace set (U+FEFF is
JS-only; U+0085 is Python-only), so both twins strip an EXPLICIT shared edge set.

UNICODE-STABILITY BOUNDARY: the Spark image runs Python 3.8 (unicodedata = Unicode 12.1)
while Node's ICU is ~15.x — codepoints ASSIGNED AFTER Unicode 12.1 can NFC/lowercase
differently across the runtimes. The A.5.2 equivalence contract covers the repertoire
stable in BOTH (verified 0/12000 mismatches inside apache/spark:3.5.3 AND on python3.13).
"""
import hashlib
import unicodedata

try:  # lazy-guarded: email normalization/hashing must not require phonenumbers
    import phonenumbers as _phonenumbers
except ImportError:  # pragma: no cover
    _phonenumbers = None

# ── Brand default countries (SPEC A.1.3) ──────────────────────────────────────────────────
BRAND_DEFAULT_COUNTRIES = ("IN", "AE", "SA", "QA", "BH", "KW", "OM")

# ── Explicit shared edge-whitespace strip (lockstep with the TS twin's EDGE_WS_CLASS) ─────
# U+0009–U+000D, SPACE, NBSP, OGHAM SPACE, U+2000–U+200A, LS, PS, NNBSP, MMSP,
# IDEOGRAPHIC SPACE, ZWNBSP/BOM. Deliberately EXCLUDES U+0085 (NEL — Python-only).
_EDGE_WS_CHARS = (
    "\t\n\x0b\x0c\r \u00a0\u1680"
    + "".join(chr(c) for c in range(0x2000, 0x200B))
    + "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def strip_edge_whitespace(value):
    """Strip the shared explicit edge-whitespace set (NOT bare str.strip — see header)."""
    return value.strip(_EDGE_WS_CHARS)


# ── Normalization (SPEC A.1.3) ────────────────────────────────────────────────────────────
def normalize_email(raw):
    """Email: strip edge whitespace → lowercase → NFC. Empty → None. No gmail stripping (ADR)."""
    if raw is None:
        return None
    normalized = unicodedata.normalize("NFC", strip_edge_whitespace(raw).lower())
    return normalized if len(normalized) > 0 else None


def normalize_phone(raw, default_country):
    """Phone: E.164 via libphonenumber with the brand default country.

    Unparseable or invalid → None (no identifier). A raw '+…' international number
    overrides the default country. Returned E.164 includes the leading '+'.
    """
    if raw is None:
        return None
    stripped = strip_edge_whitespace(raw)
    if len(stripped) == 0:
        return None
    if _phonenumbers is None:  # pragma: no cover
        raise ImportError(
            "_identity_normalization.normalize_phone requires the 'phonenumbers' pip package "
            "(pinned in db/iceberg/spark/Dockerfile; `pip3 install phonenumbers` for local runs)"
        )
    try:
        parsed = _phonenumbers.parse(stripped, default_country)
    except _phonenumbers.NumberParseException:
        return None
    if not _phonenumbers.is_valid_number(parsed):
        return None
    return _phonenumbers.format_number(parsed, _phonenumbers.PhoneNumberFormat.E164)


# ── Hashing — AMD-01 dual convention ──────────────────────────────────────────────────────
def interop_hash(normalized_value):
    """INTEROP space: plain unsalted sha256(normalized_value) → 64-char lowercase hex."""
    return hashlib.sha256(normalized_value.encode("utf-8")).hexdigest()


def internal_hash(normalized_value, salt_hex):
    """INTERNAL space: sha256( salt ‖ '||' ‖ normalized_value ) → 64-hex.

    SAME BYTES as @brain/identity-core saltedIdentifierSha256Hex and
    _raw_normalize.hash_identifier's hashing step (salt as STRING with '||' separator —
    distinct from hash_salted_bytes). Kept as the two-line convention in lockstep.
    """
    return hashlib.sha256(f"{salt_hex}||{normalized_value}".encode("utf-8")).hexdigest()


# ── Convenience: normalize + hash in one call (None-safe end-to-end) ──────────────────────
def email_interop_hash(raw):
    normalized = normalize_email(raw)
    return None if normalized is None else interop_hash(normalized)


def phone_interop_hash(raw, default_country):
    normalized = normalize_phone(raw, default_country)
    return None if normalized is None else interop_hash(normalized)


def email_internal_hash(raw, salt_hex):
    normalized = normalize_email(raw)
    return None if normalized is None else internal_hash(normalized, salt_hex)


def phone_internal_hash(raw, default_country, salt_hex):
    normalized = normalize_phone(raw, default_country)
    return None if normalized is None else internal_hash(normalized, salt_hex)
