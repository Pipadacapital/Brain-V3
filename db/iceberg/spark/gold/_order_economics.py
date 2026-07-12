# SPEC: C.3
"""
_order_economics.py — PURE (no Spark) scalar/vector math for the Wave-C contribution-margin
engine (gold_order_economics + gold_product_economics). Kept Spark-free so the money invariants
(§1.2: integer minor units, NO floats anywhere incl. intermediates; GCC 3-decimal zero-rounding
sum-of-parts) are unit-testable at the scalar level — the same discipline as _customer_360_enrich.py.

AMD-17 (BINDING): this NEW mart adopts the INDUSTRY-CONVENTION spec numbering. The live
gold_contribution_margin uses a SHIFTED scheme (live CM1 ≙ spec CM2, live CM2 ≙ spec CM3) and is left
UNTOUCHED — see knowledge-base/measurement/cm-mapping.md.

  CM1 = net_revenue − COGS
  CM2 = CM1 − shipping(forward + reverse) − packaging − payment/platform fees
  CM3 = CM2 − allocated marketing spend

ALL money is signed BIGINT minor units (int in Python, bigint in Spark). Every operation here is
integer add/subtract/floor-div — there is NO float, so the sum-of-parts ALWAYS equals the total with
ZERO rounding loss, in ANY currency scale (KWD/BHD/OMR 3-decimal fils included). Currency is carried
alongside, NEVER blended across codes (the caller groups by currency_code first).

AMD-15 (BINDING): economics_state maps onto the live two-stage recognition ledger — provisional at
booking, finalized after the prepaid horizon / COD delivery, reversed on RTO / cancellation / refund.
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

from typing import Dict, Iterable, List, Optional, Sequence, Tuple

# ── Recognition-event → economics_state mapping (AMD-15) ─────────────────────────────────────────
# The gold_revenue_ledger event grammar (gold_revenue_ledger.py:283-315 + the two extra terminal
# labels silver_order_state carries). PROVISIONAL is the booking; SETTLED = revenue became final;
# REVERSED = revenue clawed back. Precedence: reversed > settled > provisional.
PROVISIONAL_EVENT_TYPE = "provisional_recognition"
SETTLED_EVENT_TYPES = frozenset({"finalization", "cod_delivery_confirmed"})
REVERSAL_EVENT_TYPES = frozenset(
    {"cod_rto_clawback", "cancellation", "refund", "chargeback", "rto_reversal"}
)

# cm3_allocation_basis vocabulary (recorded per row so the number is explainable).
BASIS_DETERMINISTIC = "deterministic_attributed"  # per-order attributed spend (when a source exists)
BASIS_DAY_PRORATA = "day_channel_prorata"          # equal day×(brand,currency) pro-rata split
BASIS_NONE = "none"                                # no spend data for the day → marketing = 0


def net_revenue_minor(events: Iterable[Tuple[str, int]]) -> int:
    """Recognized net revenue for an order = Σ amount_minor over its NON-provisional ledger events.

    `events` = iterable of (event_type, amount_minor). The provisional_recognition booking row is
    EXCLUDED (it is the not-yet-recognized placeholder — identical to silver_order_state.order_value_minor,
    which sums lifecycle_state <> 'placed'). A fully-reversed order (RTO/refund) therefore nets to a
    NEGATIVE recognized revenue (only the signed reversal survives) — which is exactly why its CM3 is
    negative. Integer minor units throughout.
    """
    total = 0
    for event_type, amount in events:
        if event_type == PROVISIONAL_EVENT_TYPE:
            continue
        total += int(amount)
    return total


def economics_state(event_types: Iterable[str]) -> str:
    """provisional | settled | reversed from the SET of an order's ledger event_types (AMD-15).

    reversed (any clawback/refund/cancel) > settled (finalized or COD-delivered) > provisional (booking
    only — COD pre-delivery or a prepaid order still inside its recognition horizon)."""
    types = set(event_types)
    if types & REVERSAL_EVENT_TYPES:
        return "reversed"
    if types & SETTLED_EVENT_TYPES:
        return "settled"
    return "provisional"


def compute_margins(
    *,
    net_revenue_minor: int,
    cogs_minor: int,
    shipping_fwd_minor: int,
    shipping_rev_minor: int,
    packaging_minor: int,
    fees_minor: int,
    marketing_minor: int,
) -> Dict[str, int]:
    """The CM1/CM2/CM3 waterfall on integer minor units (spec numbering, AMD-17).

    Returns cm1_minor/cm2_minor/cm3_minor. Pure integer arithmetic → zero rounding loss in ANY
    currency scale. All inputs signed minor units (revenue may be negative for a reversed order;
    cost components are non-negative)."""
    cm1 = int(net_revenue_minor) - int(cogs_minor)
    cm2 = cm1 - int(shipping_fwd_minor) - int(shipping_rev_minor) - int(packaging_minor) - int(fees_minor)
    cm3 = cm2 - int(marketing_minor)
    return {"cm1_minor": cm1, "cm2_minor": cm2, "cm3_minor": cm3}


def allocate_prorata(total_minor: int, keys: Sequence[str]) -> Dict[str, int]:
    """Split `total_minor` across `keys` with ZERO money leak (largest-remainder apportionment).

    base = total // n; the first `remainder` keys (in the given order — the caller passes a
    DETERMINISTIC sort, e.g. order_id asc) each get +1 minor unit. Σ allocations == total_minor
    EXACTLY (no rounding drift — the §1.2 sum-of-parts invariant applied to spend allocation).
    total_minor must be non-negative (marketing spend); empty keys → {}."""
    n = len(keys)
    if n == 0:
        return {}
    total = int(total_minor)
    if total < 0:
        raise ValueError("allocate_prorata: total_minor must be non-negative (spend)")
    base = total // n
    remainder = total - base * n  # 0 .. n-1
    out: Dict[str, int] = {}
    for i, key in enumerate(keys):
        out[key] = base + (1 if i < remainder else 0)
    return out


def apportion_by_share(total_minor: int, shares: Sequence[Tuple[str, int]]) -> Dict[str, int]:
    """Apportion `total_minor` across keys weighted by non-negative integer `shares` (e.g. line
    revenue), with ZERO leak — the largest-remainder method. Used to push an order's economics down
    onto its product lines so gold_product_economics reconciles to gold_order_economics EXACTLY.

    shares = [(key, weight)]. Weights MUST be non-negative — a negative weight raises ValueError
    (AUD-IMPL-017: silently equal-splitting would mask a caller bug as a plausible allocation).
    If Σweights == 0, falls back to an equal split (allocate_prorata over the keys in order).
    Returns {key: minor} with Σ == total_minor. Handles negative totals (a reversed order's
    negative revenue) by apportioning the magnitude then re-signing, so the signed sum still
    equals total_minor exactly."""
    keys = [k for k, _ in shares]
    if not keys:
        return {}
    if any(int(w) < 0 for _, w in shares):
        raise ValueError("apportion_by_share: weights must be non-negative")
    total = int(total_minor)
    weight_sum = sum(int(w) for _, w in shares)
    if weight_sum == 0:
        signed = allocate_prorata(abs(total), keys)
        return {k: (-v if total < 0 else v) for k, v in signed.items()}
    mag = abs(total)
    # floor share + remainder distributed to the largest fractional parts (deterministic tie-break:
    # larger remainder-numerator first, then input order — AUD-IMPL-017 docstring fix: the key is
    # (-remainder, index), NOT weight) so Σ == mag exactly.
    provisional: List[Tuple[str, int, int]] = []  # (key, floor, remainder_numerator)
    for k, w in shares:
        num = mag * int(w)
        provisional.append((k, num // weight_sum, num % weight_sum))
    allocated = sum(fl for _, fl, _ in provisional)
    leftover = mag - allocated  # 0 .. len-1
    order = sorted(range(len(provisional)), key=lambda i: (-provisional[i][2], i))
    give = set(order[:leftover])
    out: Dict[str, int] = {}
    for i, (k, fl, _) in enumerate(provisional):
        v = fl + (1 if i in give else 0)
        out[k] = -v if total < 0 else v
    return out


def is_new_customer(order_rank: Optional[int]) -> Optional[bool]:
    """is_new_customer per order (C.5.5): True iff this is the customer's FIRST recognized order.

    `order_rank` = the 1-based rank of this order among the brain_id's recognized orders ordered by
    first_event_at (computed by the caller's window). rank == 1 → True; rank > 1 → False;
    None (unresolved brain_id — anonymous / not yet identified) → None (HONEST unknown, never a
    silent False that would inflate 'new' counts)."""
    if order_rank is None:
        return None
    return order_rank == 1
