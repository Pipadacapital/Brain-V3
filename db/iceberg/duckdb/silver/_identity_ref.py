"""
_identity_ref.py — the deterministic, collision-free PUBLIC customer reference derived from brain_id.

brain_id stays a UUID internally (typed `uuid` across ~12 PG tables + ~14 z.uuid() contracts — see
packages/contracts/src/identity/decision.ts). This module adds a HUMAN-READABLE surrogate `customer_ref`
that the UI / APIs surface INSTEAD of the raw UUID, WITHOUT changing any storage or contract:

    brain_ref('9f2c1a4e-7b33-4c9a-8e21-b4d7f0a10000')  ->  'BRN-JX5GD8SFPKR9K87GNPFRY440000'

Properties (why this is safe as a public id):
  - DETERMINISTIC   : pure function of brain_id — the same brain_id always yields the same ref, so it can
                      be computed independently in Spark (Python here) and in TypeScript (identity-export /
                      API) and in the UI, and they always agree. No lookup table, no state.
  - INJECTIVE (1:1) : we encode the FULL 128 bits of the UUID (16 bytes) — never a truncation — so distinct
                      brain_ids always map to distinct refs. No collisions. Reversible in principle (the ref
                      IS the UUID re-encoded), though we never need to decode it.
  - PATTERNED       : a fixed `BRN-` prefix + Crockford base32 (26 chars). Crockford's alphabet omits I/L/O/U
                      so a ref is unambiguous to read aloud / type (no 0-vs-O, 1-vs-I/L confusion).

The TypeScript mirror is packages/contracts/src/identity/brain-ref.ts — it MUST stay byte-identical to this
(same alphabet, same MSB-first bit packing, same sha256[:16] fallback for a non-UUID input). Golden vectors
in _identity_ref_test.py + brain-ref.test.ts lock the two implementations together.
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import hashlib

# Crockford base32 — canonical alphabet, uppercase, excludes I L O U (read-aloud safe). 32 symbols.
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
REF_PREFIX = "BRN-"


def _crockford_b32(data: bytes) -> str:
    """MSB-first Crockford base32 of raw bytes. 16 bytes (128 bits) → 26 chars (last char pads 3 low bits).
    Big-endian bit accumulator so the encoding matches the TS mirror byte-for-byte."""
    bits = 0
    nbits = 0
    out = []
    for byte in data:
        bits = (bits << 8) | byte
        nbits += 8
        while nbits >= 5:
            nbits -= 5
            out.append(_CROCKFORD[(bits >> nbits) & 0x1F])
    if nbits > 0:  # flush the remaining <5 bits, left-aligned into a final symbol
        out.append(_CROCKFORD[(bits << (5 - nbits)) & 0x1F])
    return "".join(out)


def _to_16_bytes(brain_id: str) -> bytes:
    """A UUID → its 16 raw bytes (dashes stripped, case-insensitive). A non-UUID input (should never happen
    in this system — brain_id is always a UUID) → the first 16 bytes of its sha256, so the function is still
    total + deterministic. The TS mirror uses the identical fallback."""
    s = str(brain_id).strip()
    hexs = s.replace("-", "").lower()
    if len(hexs) == 32:
        try:
            return bytes.fromhex(hexs)
        except ValueError:
            pass
    return hashlib.sha256(s.encode("utf-8")).digest()[:16]


def brain_ref(brain_id):
    """brain_id (UUID string) → the public 'BRN-' + Crockford-base32(128 bits) reference. None/empty → None
    (so a NULL brain_id row stays NULL — honest-empty, never a fabricated ref)."""
    if brain_id is None:
        return None
    s = str(brain_id).strip()
    if not s:
        return None
    return REF_PREFIX + _crockford_b32(_to_16_bytes(s))


def brain_ref_udf():
    """Spark UDF(brain_id:string) → customer_ref:string (wraps the pure brain_ref above so the EXECUTED
    encoding IS the unit-tested one). pyspark imported lazily → the pure fn stays testable without Spark."""
    from pyspark.sql.functions import udf
    from pyspark.sql.types import StringType
    return udf(brain_ref, StringType())
