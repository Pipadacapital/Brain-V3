# SPEC: ADR-0016 P1.1 — the Gold incremental↔full parity gate (flip GOLD_INCREMENTAL default-on ONLY after this passes).
"""
test_parity_gold_incremental.py — proves the STRICT incremental↔full comparator that gates GOLD_INCREMENTAL:

  A. The Gold manifest is well-formed: every incremental-safe mart has keys, the three full-recompute money
     marts (gold_revenue_ledger / gold_cac / gold_contribution_margin) are DELIBERATELY ABSENT (they never
     window — delete_orphans / multi-source money-safety — so incremental==full is vacuous for them).

  B. parity(..., strict=True) — the SHIPPED comparator — over an in-memory DuckDB standing in for the catalog:
     - identical full & incremental builds        → PASS (money byte-exact, zero drift).
     - incremental MISSING a full row             → FAIL (dropped-row regression: only_l > 0).
     - incremental INVENTED a row                 → FAIL (strict: right-only rows are NOT drift here, both
                                                     sides share a frozen snapshot).
     - incremental with a MONEY diff on a shared key → FAIL (content diff / checksum mismatch — the core
                                                     money-byte-exact bar).
     - non-strict mode tolerates a right-only superset (the Spark↔DuckDB migration gate's oracle drift).

The comparator ships in parity_check.parity; this test imports it (and monkeypatches `connect` to an
in-memory DuckDB) so the tested algebra is the REAL gate, not a copy. Live end-to-end parity over the actual
medallion remains parity_check.py's job pre-merge (it needs a full + incremental Gold build on one snapshot).
Run:  python -m pytest db/iceberg/duckdb/test_parity_gold_incremental.py
      (or plain `python db/iceberg/duckdb/test_parity_gold_incremental.py` — a __main__ runner is included).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # db/iceberg/duckdb

import duckdb  # noqa: E402

import parity_check as pc  # noqa: E402

# A minimal Gold-like mart: (brand_id, order_id) PK + a money col + currency, exactly the manifest shape.
_KEYS = ["brand_id", "order_id"]
_COLS = ["net_revenue_minor", "currency_code"]
_NS = "brain_gold"
_MART = "gold_probe"


def _seed(con, suffix: str, rows: list[tuple]):
    """Create {CATALOG}.brain_gold.gold_probe{suffix} as a plain in-memory table (the FQTN parity() builds).

    parity() references CATALOG.NS.TABLE; an in-memory DuckDB can't attach a 3-part catalog, so we alias the
    catalog part to `memory` (DuckDB's default in-memory database) by overriding pc.CATALOG for the test.
    """
    fq = f"{pc.CATALOG}.{_NS}.{_MART}{suffix}"
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {pc.CATALOG}.{_NS}")
    con.execute(
        f"CREATE OR REPLACE TABLE {fq} "
        "(brand_id VARCHAR, order_id VARCHAR, net_revenue_minor BIGINT, currency_code VARCHAR)"
    )
    for r in rows:
        con.execute(f"INSERT INTO {fq} VALUES (?, ?, ?, ?)", list(r))


def _harness(full_rows, incr_rows):
    """Build an in-memory DuckDB with a _full and _incr build, monkeypatch pc.connect/pc.CATALOG to it, and
    return a zero-arg runner that calls the SHIPPED parity() in strict mode."""
    con = duckdb.connect(":memory:")
    orig_cat, orig_connect = pc.CATALOG, pc.connect
    pc.CATALOG = "memory"  # in-memory DB name → the FQTN resolves to memory's gold namespace
    pc.connect = lambda: con
    _seed(con, "_full", full_rows)
    _seed(con, "_incr", incr_rows)

    def run(strict=True):
        return pc.parity(_NS, _MART, _KEYS, _COLS, "_incr", left_suffix="_full", strict=strict)

    def restore():
        pc.CATALOG, pc.connect = orig_cat, orig_connect
        con.close()

    return run, restore


# ── A. manifest shape ───────────────────────────────────────────────────────────────────────────────────
def test_manifest_marts_are_well_formed():
    for mart, (keys, cols) in pc.GOLD_INCREMENTAL_MARTS.items():
        assert mart.startswith("gold_"), mart
        assert keys and keys[0] == "brand_id", f"{mart}: brand_id-first key (tenant isolation)"
        assert isinstance(cols, list), mart


def test_full_recompute_money_marts_are_excluded():
    # These three NEVER window (delete_orphans / multi-source money-safety) — flipping GOLD_INCREMENTAL must
    # not touch them, so they are intentionally absent from the incremental↔full manifest.
    for exempt in ("gold_revenue_ledger", "gold_cac", "gold_contribution_margin"):
        assert exempt not in pc.GOLD_INCREMENTAL_MARTS, f"{exempt} must stay full-recompute-exempt"


# ── B. strict incremental↔full comparator ──────────────────────────────────────────────────────────────
_BASE = [("b1", "o1", 1000, "INR"), ("b1", "o2", 2500, "INR"), ("b2", "o3", 999, "USD")]


def test_identical_builds_pass():
    run, restore = _harness(_BASE, list(_BASE))
    try:
        assert run() is True, "identical full & incremental builds must PASS (money byte-exact)"
    finally:
        restore()


def test_dropped_row_fails():
    run, restore = _harness(_BASE, _BASE[:-1])  # incremental missing o3
    try:
        assert run() is False, "incremental dropping a full row is a regression (only_l>0) → FAIL"
    finally:
        restore()


def test_invented_row_fails_under_strict():
    extra = list(_BASE) + [("b2", "o4", 42, "USD")]  # incremental invented o4
    run, restore = _harness(_BASE, extra)
    try:
        assert run(strict=True) is False, "strict: incremental inventing a row (no drift allowed) → FAIL"
        # non-strict (migration gate) tolerates the right-only superset as oracle drift.
        assert run(strict=False) is True, "non-strict tolerates a right-only superset (oracle drift)"
    finally:
        restore()


def test_money_diff_on_shared_key_fails():
    drifted = [("b1", "o1", 1000, "INR"), ("b1", "o2", 9999, "INR"), ("b2", "o3", 999, "USD")]  # o2 money moved
    run, restore = _harness(_BASE, drifted)
    try:
        assert run() is False, "a money-column diff on a shared key must FAIL (money-byte-exact bar)"
    finally:
        restore()


if __name__ == "__main__":
    test_manifest_marts_are_well_formed()
    test_full_recompute_money_marts_are_excluded()
    test_identical_builds_pass()
    test_dropped_row_fails()
    test_invented_row_fails_under_strict()
    test_money_diff_on_shared_key_fails()
    print("PASS: gold incremental↔full parity gate (6/6)")
