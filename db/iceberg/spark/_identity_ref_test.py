"""
_identity_ref_test.py — pure-python golden-vector tests for brain_ref (the public customer_ref).

These GOLDEN VECTORS are shared with the TypeScript mirror (packages/contracts/src/identity/brain-ref.test.ts):
the exact same brain_id inputs MUST produce the exact same BRN- outputs in both languages, or Spark-written
customer_ref would disagree with the API/UI-computed one. Run: `python3 db/iceberg/spark/_identity_ref_test.py`.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _identity_ref import REF_PREFIX, brain_ref  # noqa: E402

# GOLDEN VECTORS — keep byte-identical with brain-ref.test.ts.
GOLDEN = {
    "9f2c1a4e-7b33-4c9a-8e21-b4d7f0a10000": "BRN-KWP1MKKV6D69N3H1PKBZ188000",
    "00000000-0000-0000-0000-000000000000": "BRN-00000000000000000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff": "BRN-ZZZZZZZZZZZZZZZZZZZZZZZZZW",
    "018f9a2c-1a4e-7b33-8c9a-8e21b4d7f0a1": "BRN-067SMB0T9SXK734THRGV9NZGM4",
}


def test_length_and_prefix():
    ref = brain_ref("9f2c1a4e-7b33-4c9a-8e21-b4d7f0a10000")
    assert ref.startswith(REF_PREFIX), ref
    # 'BRN-' + 26 Crockford chars = 30 total (128 bits → ceil(128/5)=26 symbols).
    assert len(ref) == len(REF_PREFIX) + 26, f"{ref} len={len(ref)}"


def test_alphabet_is_crockford():
    ref = brain_ref("018f9a2c-1a4e-7b33-8c9a-8e21b4d7f0a1")[len(REF_PREFIX):]
    for ch in ref:
        assert ch in "0123456789ABCDEFGHJKMNPQRSTVWXYZ", f"non-crockford char {ch!r} in {ref}"
    # excludes I, L, O, U
    for bad in "ILOU":
        assert bad not in ref or True  # alphabet check above already guarantees it


def test_deterministic():
    a = brain_ref("9f2c1a4e-7b33-4c9a-8e21-b4d7f0a10000")
    b = brain_ref("9F2C1A4E-7B33-4C9A-8E21-B4D7F0A10000")  # case-insensitive
    assert a == b == GOLDEN["9f2c1a4e-7b33-4c9a-8e21-b4d7f0a10000"]


def test_injective_distinct_inputs_distinct_refs():
    refs = {brain_ref(k) for k in GOLDEN}
    assert len(refs) == len(GOLDEN), "collision: distinct brain_ids mapped to the same ref"


def test_null_empty_passthrough():
    assert brain_ref(None) is None
    assert brain_ref("") is None
    assert brain_ref("   ") is None


def test_golden_vectors():
    for brain_id, expected in GOLDEN.items():
        assert brain_ref(brain_id) == expected, f"{brain_id} → {brain_ref(brain_id)} != {expected}"


def test_non_uuid_fallback_is_total_and_stable():
    # A non-UUID input must not throw and must be deterministic (sha256[:16] path).
    r1 = brain_ref("not-a-uuid")
    r2 = brain_ref("not-a-uuid")
    assert r1 == r2 and r1.startswith(REF_PREFIX) and len(r1) == len(REF_PREFIX) + 26


def _run_all():
    fns = [g for n, g in sorted(globals().items()) if n.startswith("test_") and callable(g)]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"\nOK — all {len(fns)} brain_ref golden-vector tests passed.")


if __name__ == "__main__":
    _run_all()
