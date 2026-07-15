# SPEC: A.2.2 / audit-G1 — behaviour + parity test for the query-time revenue-spine brain_id resolver.
"""
test_revenue_identity_g1.py — proves the audit-G1 flag-gated, additive, query-time brain_id_v2 resolver:

  1. FLAG OFF (default / no brands ON): resolve_brain_id_v2_sql degrades to an EMPTY result, so a LEFT-JOIN
     of the revenue spine against it yields brain_id_v2 = NULL on EVERY order — i.e. byte-identical to the
     legacy flat single-key output (parity preserved; nothing new resolved).
  2. FLAG ON (brands forced ON): brain_id_v2 is resolved MULTI-KEY and merge-aware from a tiny in-memory
     silver_identity_map fixture, proving each of the audit's target behaviours:
       (a) PHONE-ONLY resolution   — an order the flat email path CANNOT resolve is resolved via phone.
       (b) PLATFORM-ID resolution  — resolved via the salted storefront_customer_id (platform_customer_id).
       (c) MERGE-AWARE             — a superseded id whose current row carries replaced_by_brain_id resolves
                                     to the SURVIVOR, not the dead brain_id.
       (d) BI-TEMPORAL identity_current — a NON-current / system-closed map row is IGNORED (never resolves).
       (e) NEVER-GUESS             — an order whose keys resolve to TWO distinct brains → brain_id_v2 NULL.

Self-contained: builds the fixtures in a fresh in-memory DuckDB and runs the ACTUAL production SQL from
_revenue_identity.resolve_brain_id_v2_sql — so the test exercises the shipped resolver, not a paraphrase.
Run:  python -m pytest db/iceberg/duckdb/test_revenue_identity_g1.py
      (or plain `python db/iceberg/duckdb/test_revenue_identity_g1.py` — a __main__ runner is included).
"""
from __future__ import annotations

import os
import sys

import duckdb

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _revenue_identity import resolve_brain_id_v2_sql  # noqa: E402

BRAND = "brand-A"

# ── Fixture: a tiny bi-temporal MULTI-KEY silver_identity_map (only the columns the resolver reads). ──
# identifier_hash is the join key (join on hash ALONE); identifier_type is provenance only.
#   h_email_1 / h_phone_1  → brain-1                         (email + phone both point at brain-1)
#   h_phone_2              → brain-2                         (phone-only customer, no email edge)
#   h_platform_3           → brain-3                         (platform-id-only customer)
#   h_email_4 (current)    → brain-dead-4, replaced_by brain-survivor-4   (merge: survivor wins)
#   h_email_5 (NOT current / system-closed) → brain-5       (must be IGNORED by identity_current)
#   h_email_6 → brain-6a  AND  h_phone_6 → brain-6b          (ambiguous → never-guess → NULL)
_MAP_ROWS = [
    # (identifier_hash, identifier_type, brain_id, replaced_by_brain_id, confidence, is_current, system_to)
    ("h_email_1", "pre_hashed_email", "brain-1", None, 1.0, True, None),
    ("h_phone_1", "pre_hashed_phone", "brain-1", None, 1.0, True, None),
    ("h_phone_2", "pre_hashed_phone", "brain-2", None, 1.0, True, None),
    ("h_platform_3", "storefront_customer_id", "brain-3", None, 0.9, True, None),
    ("h_email_4", "pre_hashed_email", "brain-dead-4", "brain-survivor-4", 1.0, True, None),
    # non-current / system-closed → identity_current predicate must exclude it:
    ("h_email_5", "pre_hashed_email", "brain-5", None, 1.0, False, "2026-01-01 00:00:00"),
    ("h_email_6", "pre_hashed_email", "brain-6a", None, 1.0, True, None),
    ("h_phone_6", "pre_hashed_phone", "brain-6b", None, 1.0, True, None),
]

# ── Fixture: the order spine (post-salt platform hash already supplied, mirroring the caller). ──
# (order_id, email_hash, phone_hash, platform_hash)
_ORDER_ROWS = [
    ("o1", "h_email_1", "h_phone_1", None),        # email+phone agree → brain-1
    ("o2", None, "h_phone_2", None),               # PHONE-ONLY → brain-2 (flat email path yields NULL)
    ("o3", None, None, "h_platform_3"),            # PLATFORM-ID → brain-3
    ("o4", "h_email_4", None, None),               # MERGE → survivor brain-survivor-4
    ("o5", "h_email_5", None, None),               # only a non-current map row → NULL (bi-temporal)
    ("o6", "h_email_6", "h_phone_6", None),        # two distinct brains → NEVER-GUESS → NULL
    ("o7", "h_unknown", None, None),               # no map edge → NULL
]


def _con():
    con = duckdb.connect(":memory:")
    con.execute(
        "CREATE TABLE silver_identity_map ("
        "  brand_id VARCHAR, identifier_hash VARCHAR, identifier_type VARCHAR, brain_id VARCHAR,"
        "  replaced_by_brain_id VARCHAR, confidence DOUBLE, is_current BOOLEAN, system_to TIMESTAMP)"
    )
    con.executemany(
        "INSERT INTO silver_identity_map VALUES (?,?,?,?,?,?,?,?)",
        [(BRAND, h, t, b, r, c, cur, (st and __import__("datetime").datetime.fromisoformat(st)))
         for (h, t, b, r, c, cur, st) in _MAP_ROWS],
    )
    con.execute(
        "CREATE TABLE _orders ("
        "  brand_id VARCHAR, order_id VARCHAR, hashed_customer_email VARCHAR,"
        "  hashed_customer_phone VARCHAR, platform_customer_id_hash VARCHAR)"
    )
    con.executemany(
        "INSERT INTO _orders VALUES (?,?,?,?,?)",
        [(BRAND, oid, e, p, pl) for (oid, e, p, pl) in _ORDER_ROWS],
    )
    return con


def _resolve(con, on_brands):
    """Run the ACTUAL production resolver SQL, LEFT-JOINed to the spine exactly as the jobs do →
    {order_id: brain_id_v2}. LEFT JOIN so an unresolved order surfaces as NULL (not a dropped row)."""
    orders_cte = "SELECT * FROM _orders"
    resolver = resolve_brain_id_v2_sql("silver_identity_map", orders_cte, on_brands)
    rows = con.execute(
        f"""
        SELECT o.order_id, v2.brain_id_v2
        FROM _orders o
        LEFT JOIN ({resolver}) v2
          ON v2.brand_id = o.brand_id AND v2.order_id = o.order_id
        ORDER BY o.order_id
        """
    ).fetchall()
    return {oid: b for (oid, b) in rows}


def test_flag_off_is_all_null_parity_preserved():
    """OFF (no brands ON) → resolver is EMPTY → brain_id_v2 NULL on EVERY order (legacy flat output intact)."""
    con = _con()
    got = _resolve(con, on_brands=[])
    assert set(got.keys()) == {r[0] for r in _ORDER_ROWS}, "every order row must survive the LEFT JOIN"
    assert all(v is None for v in got.values()), f"flag OFF must yield all-NULL brain_id_v2, got {got}"


def test_flag_on_multikey_merge_aware_bitemporal_neverguess():
    """ON → multi-key + merge-aware + bi-temporal + never-guess, all in one pass."""
    con = _con()
    got = _resolve(con, on_brands=[BRAND])
    assert got["o1"] == "brain-1", "email+phone agree → brain-1"
    assert got["o2"] == "brain-2", "(a) PHONE-ONLY resolves where the flat email path cannot"
    assert got["o3"] == "brain-3", "(b) PLATFORM-ID (salted storefront_customer_id) resolves"
    assert got["o4"] == "brain-survivor-4", "(c) MERGE-AWARE: survivor wins over the dead brain_id"
    assert got["o5"] is None, "(d) BI-TEMPORAL: a non-current / system-closed map row is ignored"
    assert got["o6"] is None, "(e) NEVER-GUESS: two distinct brains → NULL (never fabricate)"
    assert got["o7"] is None, "an order with no map edge stays NULL"


def test_flag_on_does_not_change_a_brand_left_off():
    """Per-brand isolation: with only BRAND forced ON, an order under a DIFFERENT brand still resolves NULL
    (the resolver's brand IN-list is the tenant gate)."""
    con = _con()
    con.execute(
        "INSERT INTO _orders VALUES (?,?,?,?,?)",
        ["brand-B", "ob1", "h_email_1", None, None],
    )
    got = _resolve(con, on_brands=[BRAND])  # brand-B NOT in the ON list
    assert got.get("ob1") is None, "a brand left OFF must not resolve, even on a shared hash"


if __name__ == "__main__":
    test_flag_off_is_all_null_parity_preserved()
    test_flag_on_multikey_merge_aware_bitemporal_neverguess()
    test_flag_on_does_not_change_a_brand_left_off()
    print("OK — audit-G1 revenue-identity resolver: flag-OFF parity + flag-ON multi-key/merge/bitemporal/never-guess")
