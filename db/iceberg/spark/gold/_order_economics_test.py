# SPEC: C.3 / C.5.2 / C.5.3
"""
_order_economics_test.py — PURE (no Spark) self-test of the gold_order_economics CM math
(_order_economics.py). Proves the Wave-C money invariants at the scalar level:

  - C.3 unit: CM1/CM2/CM3 waterfall on integer minor units (spec numbering, AMD-17).
  - C.5.2 golden RTO order: CM3 NEGATIVE + revenue reversal (exact minor-unit assert).
  - C.5.3 golden KWD order: 3-decimal (fils) minor units, sum-of-parts == total, ZERO rounding loss.
  - economics_state mapping (AMD-15: provisional | settled | reversed).
  - marketing allocation / product apportionment: Σ parts == total EXACTLY (no money leak).

Run: python3 db/iceberg/spark/gold/_order_economics_test.py
Exit 0 = all green, exit 1 = one or more failures.
"""
from __future__ import annotations

import os
import sys

_GOLD_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _GOLD_DIR)

from _order_economics import (  # noqa: E402
    BASIS_DAY_PRORATA,
    allocate_prorata,
    apportion_by_share,
    compute_margins,
    economics_state,
    is_new_customer,
    net_revenue_minor,
)

_failures: list = []


def check(name: str, got, want) -> None:
    if got != want:
        _failures.append(f"{name}: got {got!r}, want {want!r}")
        print(f"  x {name}: got {got!r}, want {want!r}")
    else:
        print(f"  ok {name}")


# ── C.3 unit — CM waterfall on integer minor units (spec numbering) ──────────────────────────────
print("== C.3 CM1/CM2/CM3 waterfall (integer minor units, spec numbering AMD-17) ==")
m = compute_margins(
    net_revenue_minor=100_000,  # ₹1000.00
    cogs_minor=40_000,          # ₹400.00
    shipping_fwd_minor=8_000,   # ₹80.00
    shipping_rev_minor=0,
    packaging_minor=2_000,      # ₹20.00
    fees_minor=2_500,           # ₹25.00 payment/platform
    marketing_minor=15_000,     # ₹150.00 allocated
)
check("cm1 = net − cogs = 60000", m["cm1_minor"], 60_000)
check("cm2 = cm1 − ship_fwd − ship_rev − pkg − fees = 47500", m["cm2_minor"], 47_500)
check("cm3 = cm2 − marketing = 32500", m["cm3_minor"], 32_500)
# sum-of-parts reconciliation: net_rev == cm3 + all deducted components, EXACTLY.
check(
    "sum-of-parts: net = cm3 + cogs + ship + pkg + fees + mkt",
    m["cm3_minor"] + 40_000 + 8_000 + 0 + 2_000 + 2_500 + 15_000,
    100_000,
)

# ── net_revenue_minor: provisional excluded (== silver_order_state non-'placed' Σ) ───────────────
print("== net_revenue_minor: provisional booking EXCLUDED ==")
check(
    "prepaid delivered: provisional excluded, finalization counts",
    net_revenue_minor([("provisional_recognition", 100_000), ("finalization", 100_000)]),
    100_000,
)
check(
    "COD delivered: provisional excluded, cod_delivery_confirmed counts",
    net_revenue_minor([("provisional_recognition", 50_000), ("cod_delivery_confirmed", 50_000)]),
    50_000,
)

# ── C.5.2 golden RTO order → revenue REVERSAL + CM3 NEGATIVE (exact minor units) ─────────────────
# A golden GoKwik COD order that RTOs: the ledger emits provisional_recognition(+amount) then
# cod_rto_clawback(−amount). Recognized net = Σ non-provisional = −amount (the reversal). Reverse-
# logistics cost + any allocated marketing push CM3 further negative. economics_state = 'reversed'.
print("== C.5.2 golden RTO order: revenue reversal + CM3 negative (exact minor units) ==")
rto_amount = 89_900  # ₹899.00 COD order (a golden brand price point)
rto_events = [
    ("provisional_recognition", rto_amount),
    ("cod_rto_clawback", -rto_amount),
]
rto_net = net_revenue_minor(rto_events)
check("RTO recognized net revenue == −amount (reversal, exact)", rto_net, -89_900)
check("RTO economics_state == 'reversed'", economics_state(et for et, _ in rto_events), "reversed")
# Reverse-logistics cost the RTO adds (from gold_measurement_costs when built; a representative fils/paise
# value here). Even with COGS/fees degraded to 0 (WC-C2 costs fact not yet built), CM3 < 0 because the
# revenue reversal alone makes net revenue negative — the RTO destroys margin.
rto_m = compute_margins(
    net_revenue_minor=rto_net,
    cogs_minor=0,               # gold_product_costs absent → degraded to 0 (documented)
    shipping_fwd_minor=6_000,   # forward leg already spent (₹60.00)
    shipping_rev_minor=6_000,   # REVERSE logistics the RTO adds (₹60.00)
    packaging_minor=1_500,      # ₹15.00 packaging already consumed
    fees_minor=0,               # COD → no prepaid gateway fee captured
    marketing_minor=12_000,     # ₹120.00 allocated acquisition spend, now wasted
)
check("RTO CM1 == net − cogs == −89900", rto_m["cm1_minor"], -89_900)
check("RTO CM2 == −89900 − 6000 − 6000 − 1500 == −103400", rto_m["cm2_minor"], -103_400)
check("RTO CM3 == −103400 − 12000 == −115400", rto_m["cm3_minor"], -115_400)
check("RTO CM3 is NEGATIVE", rto_m["cm3_minor"] < 0, True)
# Degraded (all WC-C2 cost facts null): CM3 still negative from the revenue reversal alone.
rto_degraded = compute_margins(
    net_revenue_minor=rto_net, cogs_minor=0, shipping_fwd_minor=0, shipping_rev_minor=0,
    packaging_minor=0, fees_minor=0, marketing_minor=0,
)
check("RTO CM3 negative even with ALL cost facts degraded to 0", rto_degraded["cm3_minor"] < 0, True)
check("RTO CM3 degraded == −89900 (pure reversal)", rto_degraded["cm3_minor"], -89_900)

# ── C.5.3 golden KWD order → 3-decimal (fils) minor units, ZERO rounding loss ────────────────────
# Cedar & Sand (GCC / KWD) prepaid order: incense-gift-box 24.125 KWD == 24125 fils (scale-3). The
# fractional fils (…125) are the whole point — a scale-2 assumption would lose them. Every component
# is integer fils; sum-of-parts MUST equal the total with ZERO rounding loss.
print("== C.5.3 golden KWD order: 3-decimal fils, sum-of-parts == total, zero rounding loss ==")
kwd_net = 24_125            # 24.125 KWD (fils, scale-3)
kwd_cogs = 9_650           # 9.650 KWD
kwd_ship_fwd = 1_375       # 1.375 KWD
kwd_pkg = 500              # 0.500 KWD
kwd_fees = 723             # 0.723 KWD payment fee (a non-round fils value)
kwd_mkt = 3_200            # 3.200 KWD allocated
kwd_m = compute_margins(
    net_revenue_minor=kwd_net, cogs_minor=kwd_cogs, shipping_fwd_minor=kwd_ship_fwd,
    shipping_rev_minor=0, packaging_minor=kwd_pkg, fees_minor=kwd_fees, marketing_minor=kwd_mkt,
)
check("KWD CM1 == 24125 − 9650 == 14475 fils", kwd_m["cm1_minor"], 14_475)
check("KWD CM2 == 14475 − 1375 − 500 − 723 == 11877 fils", kwd_m["cm2_minor"], 11_877)
check("KWD CM3 == 11877 − 3200 == 8677 fils", kwd_m["cm3_minor"], 8_677)
# The zero-rounding-loss invariant: the parts reassemble the total to the EXACT fil.
check(
    "KWD sum-of-parts: net == cm3 + cogs + ship_fwd + ship_rev + pkg + fees + mkt (EXACT fils)",
    kwd_m["cm3_minor"] + kwd_cogs + kwd_ship_fwd + 0 + kwd_pkg + kwd_fees + kwd_mkt,
    kwd_net,
)
check("KWD economics_state settled (prepaid finalized)", economics_state(["finalization"]), "settled")

# ── economics_state mapping (AMD-15) ─────────────────────────────────────────────────────────────
print("== economics_state (AMD-15: provisional | settled | reversed) ==")
check("provisional-only booking → provisional", economics_state(["provisional_recognition"]), "provisional")
check("prepaid finalized → settled", economics_state(["provisional_recognition", "finalization"]), "settled")
check("COD delivered → settled", economics_state(["provisional_recognition", "cod_delivery_confirmed"]), "settled")
check("COD RTO → reversed", economics_state(["provisional_recognition", "cod_rto_clawback"]), "reversed")
check("refund → reversed", economics_state(["provisional_recognition", "refund"]), "reversed")
check("cancel → reversed", economics_state(["provisional_recognition", "cancellation"]), "reversed")
check("reversal beats settled (finalized then refunded)",
      economics_state(["finalization", "refund"]), "reversed")

# ── marketing day-pro-rata allocation: Σ parts == total EXACTLY (no money leak) ──────────────────
print("== marketing day-pro-rata allocation (largest-remainder, zero leak) ==")
alloc = allocate_prorata(10_003, ["o1", "o2", "o3"])  # 10003 / 3 = 3334 r1 → first order +1
check("allocate 10003/3: o1 gets remainder", alloc, {"o1": 3_335, "o2": 3_334, "o3": 3_334})
check("allocation Σ == total (no leak)", sum(alloc.values()), 10_003)
check("allocate over 1 order == full total", allocate_prorata(777, ["only"]), {"only": 777})
check("allocate 0 spend → all zero", allocate_prorata(0, ["a", "b"]), {"a": 0, "b": 0})
check("basis constant is stable", BASIS_DAY_PRORATA, "day_channel_prorata")

# ── product apportionment by line-revenue share: Σ parts == order total EXACTLY ──────────────────
print("== product apportionment by line share (largest-remainder, zero leak) ==")
ap = apportion_by_share(100, [("skuA", 1), ("skuB", 1), ("skuC", 1)])  # 100/3 → +1 to two lines
check("apportion 100 across 3 equal lines Σ == 100", sum(ap.values()), 100)
ap2 = apportion_by_share(1_000, [("skuA", 3), ("skuB", 1)])  # 3:1 weight
check("apportion 1000 by 3:1 == {750,250}", ap2, {"skuA": 750, "skuB": 250})
check("apportion Σ == total (weighted)", sum(ap2.values()), 1_000)
# negative total (reversed order economics pushed onto lines): signed sum still exact.
apn = apportion_by_share(-89_900, [("skuA", 2), ("skuB", 1)])
check("apportion negative total: signed Σ == total (exact)", sum(apn.values()), -89_900)
check("apportion zero-weight lines → equal split", sum(apportion_by_share(90, [("a", 0), ("b", 0), ("c", 0)]).values()), 90)
# AUD-IMPL-017: a negative weight is a caller bug — must RAISE, never silently equal-split.
try:
    apportion_by_share(100, [("a", -1), ("b", 2)])
    check("apportion negative weight raises ValueError", "no raise", "ValueError")
except ValueError:
    check("apportion negative weight raises ValueError", "ValueError", "ValueError")
# AUD-IMPL-017 tiebreak docstring fix: the deterministic tie-break is (-remainder, INPUT ORDER),
# not weight. total=2 over weights [1,3]: remainder-numerators tie (2,2) → input order gives the
# +1 to "a"; a weight-first tiebreak would have produced {"a": 0, "b": 2}.
check("apportion tiebreak = (-remainder, input order), not weight",
      apportion_by_share(2, [("a", 1), ("b", 3)]), {"a": 1, "b": 1})

# ── is_new_customer per order (C.5.5) ────────────────────────────────────────────────────────────
print("== is_new_customer per order (C.5.5) ==")
check("first recognized order → True", is_new_customer(1), True)
check("later order → False", is_new_customer(2), False)
check("unresolved brain_id → None (honest unknown)", is_new_customer(None), None)


print()
if _failures:
    print(f"FAILED — {len(_failures)} check(s):")
    for f in _failures:
        print(f"  - {f}")
    sys.exit(1)
print(f"ALL GREEN — {sys.modules['__main__'].__doc__.splitlines()[1].strip()}")
sys.exit(0)
