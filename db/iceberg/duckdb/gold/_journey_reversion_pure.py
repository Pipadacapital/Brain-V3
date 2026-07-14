# SPEC: A.2.4 (WA-19) / G4
"""
_journey_reversion_pure.py — the PySpark-FREE driver-side helpers for gold_journey_events_reversion.py.

Kept in a dependency-thin module (no pyspark import) so the merge chain-resolution and the unmerge
transfer-pair derivation are unit-testable on a vanilla Python without a Spark runtime — the same
posture as _silver_technical.py (imported by a12_identify_consent_denied_test.py). The Spark job
imports these; the tests import THIS module directly.
"""
from __future__ import annotations


def resolve_terminal(pairs):
    """Collapse merge CHAINS driver-side: [(brand, old, new), …] → old maps to its TERMINAL canonical
    id (A→B + B→C becomes A→C and B→C). Cycle-guarded (a pathological A→B→A stops at the last id before
    revisiting). Merge batches since a checkpoint are tiny, so a driver dict is fine."""
    fwd = {}
    for brand, old, new in pairs:
        fwd[(brand, old)] = new
    resolved = []
    for (brand, old), new in fwd.items():
        seen = {old}
        terminal = new
        while (brand, terminal) in fwd and terminal not in seen:
            seen.add(terminal)
            terminal = fwd[(brand, terminal)]
        resolved.append((brand, old, terminal))
    return resolved


def derive_unmerge_pairs(rows):
    """SPEC: A.2.4 (WA-19) — pure derivation of the (brand, survivor→FROM, absorbed→TO) transfer pairs
    from silver_identity_unmerge rows. A row is a mapping with brand_id / survivor_brain_id /
    absorbed_brain_id. Skips rows with no survivor or a self-pair (nothing to move back). De-duplicated,
    order-stable. The _apply_unmerge SQL then joins these against journey_events' prior-version ownership
    to find exactly the rows the merge transferred, and moves them back (data_version + 1)."""
    seen = set()
    out = []
    for r in rows:
        brand = r.get("brand_id")
        survivor = r.get("survivor_brain_id")
        absorbed = r.get("absorbed_brain_id")
        if brand is None or absorbed is None or survivor is None:
            continue
        if survivor == absorbed:
            continue
        key = (brand, survivor, absorbed)
        if key in seen:
            continue
        seen.add(key)
        # old_brain_id = survivor (current owner, moving FROM); new_brain_id = absorbed (moving TO).
        out.append((brand, survivor, absorbed))
    return out
