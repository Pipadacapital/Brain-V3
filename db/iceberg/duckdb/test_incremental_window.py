# SPEC: realtime rearchitecture Phase 0 — the incremental-read foundation (flag-gated, default OFF).
"""
test_incremental_window.py — proves _base.incremental_window()'s watermark-windowing contract:

  1. DEFAULT OFF (SILVER_INCREMENTAL unset)          → (None, hi): a full scan, byte-identical to the
     pre-incremental behavior. This is the inert prod default.
  2. ON, no prior watermark (first run)              → (None, hi): full scan (bootstrap the watermark).
  3. ON, with a watermark                            → (watermark − LOOKBACK, hi): the trailing-lookback
     window that guarantees a slightly out-of-order arrival is never skipped.
  4. FULL_REFRESH forces a full scan even when ON    → (None, hi): the entity-fold widen/backfill escape.
  5. LOOKBACK_SECONDS=0 disables the trailing margin  → (watermark, hi): a strict half-open window.

Self-contained: no Iceberg catalog / DuckDB connection needed — _CURRENT_HI is pinned directly (as run_job
does) and read_watermark is stubbed, so the test exercises the SHIPPED window arithmetic in isolation.
Run:  python -m pytest db/iceberg/duckdb/test_incremental_window.py
      (or plain `python db/iceberg/duckdb/test_incremental_window.py` — a __main__ runner is included).
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _base  # noqa: E402

WATERMARK = datetime(2026, 7, 16, 10, 0, 0)
HI = datetime(2026, 7, 16, 10, 5, 0)


def _run(*, incremental: bool, full_refresh: bool, watermark, lookback: int, enabled=None):
    """Drive incremental_window with the module globals set exactly as the env would set them, _CURRENT_HI
    pinned (as run_job does), and read_watermark stubbed to `watermark`. `enabled` overrides the tier gate
    (None → SILVER_INCREMENTAL; the Gold tier passes enabled=GOLD_INCREMENTAL)."""
    _base.INCREMENTAL = incremental
    _base.FULL_REFRESH = full_refresh
    _base.LOOKBACK_SECONDS = lookback
    _base._CURRENT_HI = HI
    orig = _base.read_watermark
    _base.read_watermark = lambda con, job: watermark
    try:
        return _base.incremental_window(None, "job-x", "src.tbl", ts_col="kafka_timestamp", enabled=enabled)
    finally:
        _base.read_watermark = orig


def test_default_off_is_full_scan():
    lo, hi = _run(incremental=False, full_refresh=False, watermark=WATERMARK, lookback=600)
    # HARD INVARIANT: lo is None IFF hi is None IFF full scan — so NO predicate leaks into the default path.
    assert lo is None and hi is None, "default OFF must be a full scan (None, None) — no bound leaks"


def test_on_first_run_no_watermark_is_full_scan():
    lo, hi = _run(incremental=True, full_refresh=False, watermark=None, lookback=600)
    assert lo is None and hi is None, "first run (no watermark) bootstraps via a full scan (None, None)"


def test_on_with_watermark_applies_lookback():
    lo, hi = _run(incremental=True, full_refresh=False, watermark=WATERMARK, lookback=600)
    assert lo == WATERMARK - timedelta(seconds=600), "lo must be watermark minus the trailing lookback"
    assert hi == HI


def test_full_refresh_forces_full_scan_even_when_on():
    lo, hi = _run(incremental=True, full_refresh=True, watermark=WATERMARK, lookback=600)
    assert lo is None and hi is None, "FULL_REFRESH is the fold/backfill escape → full scan (None, None)"


def test_zero_lookback_is_strict_half_open():
    lo, hi = _run(incremental=True, full_refresh=False, watermark=WATERMARK, lookback=0)
    assert lo == WATERMARK, "lookback=0 → strict [watermark, hi)"
    assert hi == HI


def test_gold_tier_gate_is_independent_of_silver():
    # GOLD gate ON while SILVER off → the Gold job still windows (Phase 1b flips tiers independently).
    lo, hi = _run(incremental=False, full_refresh=False, watermark=WATERMARK, lookback=600, enabled=True)
    assert lo == WATERMARK - timedelta(seconds=600) and hi == HI, "enabled=True windows regardless of SILVER"
    # GOLD gate OFF while SILVER on → the Gold job full-scans (default-OFF byte-identity for the Gold tier).
    lo, hi = _run(incremental=True, full_refresh=False, watermark=WATERMARK, lookback=600, enabled=False)
    assert lo is None and hi is None, "enabled=False is a full scan regardless of SILVER"
    # FULL_REFRESH still wins for the Gold tier.
    lo, hi = _run(incremental=False, full_refresh=True, watermark=WATERMARK, lookback=600, enabled=True)
    assert lo is None and hi is None, "FULL_REFRESH forces a full scan for the Gold tier too"


if __name__ == "__main__":
    test_default_off_is_full_scan()
    test_on_first_run_no_watermark_is_full_scan()
    test_on_with_watermark_applies_lookback()
    test_full_refresh_forces_full_scan_even_when_on()
    test_zero_lookback_is_strict_half_open()
    test_gold_tier_gate_is_independent_of_silver()
    print("PASS: incremental_window window arithmetic (6/6)")
