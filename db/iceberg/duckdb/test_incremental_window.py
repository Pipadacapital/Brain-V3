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
  6. WATERMARK_MAX_SLICE_SECONDS>0 caps the window    → bootstrap walks from min(ts) in bounded slices, and
     an established watermark clamps hi to wm+slice — with _CURRENT_HI overwritten so run_job advances the
     watermark to exactly the capped hi (no skipped rows). This is the backlog-bootstrap OOM fix.

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


class _FakeCon:
    """Minimal stand-in for the DuckDB connection: answers the bootstrap min()/max() probes the sliced
    window issues when _CURRENT_HI is not pre-pinned. Returns `min_ts` for a MIN(...) query, `max_ts` for a
    MAX(...) query."""
    def __init__(self, *, min_ts=None, max_ts=None):
        self._min, self._max = min_ts, max_ts
        self._last = None

    def execute(self, sql, *args):
        self._last = "min" if "min(" in sql.lower() else "max" if "max(" in sql.lower() else None
        return self

    def fetchone(self):
        return [self._min if self._last == "min" else self._max]


def _run(*, incremental: bool, full_refresh: bool, watermark, lookback: int, enabled=None, cap: int = 0,
         con=None, pin_hi=True):
    """Drive incremental_window with the module globals set exactly as the env would set them, _CURRENT_HI
    pinned (as run_job does) unless pin_hi=False, and read_watermark stubbed to `watermark`. `enabled`
    overrides the tier gate (None → SILVER_INCREMENTAL; the Gold tier passes enabled=GOLD_INCREMENTAL);
    `cap` sets WATERMARK_MAX_SLICE_SECONDS. Returns (lo, hi); read _base._CURRENT_HI afterward to assert the
    watermark-advance bound."""
    _base.INCREMENTAL = incremental
    _base.FULL_REFRESH = full_refresh
    _base.LOOKBACK_SECONDS = lookback
    _base.WATERMARK_MAX_SLICE_SECONDS = cap
    _base._CURRENT_HI = HI if pin_hi else None
    orig = _base.read_watermark
    _base.read_watermark = lambda con, job: watermark
    try:
        return _base.incremental_window(con, "job-x", "src.tbl", ts_col="kafka_timestamp", enabled=enabled)
    finally:
        _base.read_watermark = orig
        _base.WATERMARK_MAX_SLICE_SECONDS = 0


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


def test_slice_cap_off_by_default_preserves_full_scan_bootstrap():
    # cap=0 (the shipped default) keeps the exact prior contract: first run with no watermark → full scan.
    lo, hi = _run(incremental=True, full_refresh=False, watermark=None, lookback=600, cap=0)
    assert lo is None and hi is None, "cap OFF → first run is still a full-scan bootstrap (byte-parity)"


def test_slice_cap_clamps_established_watermark_to_wm_plus_slice():
    # HI is watermark + 300s; a 120s cap must clamp hi to watermark + 120s (bounded catch-up after a gap).
    lo, hi = _run(incremental=True, full_refresh=False, watermark=WATERMARK, lookback=600, cap=120)
    assert lo == WATERMARK - timedelta(seconds=600), "lo still applies the trailing lookback"
    assert hi == WATERMARK + timedelta(seconds=120), "hi clamped to watermark + slice, not the batch max"
    # run_job must advance the watermark to the SAME capped hi it read up to — else the walk skips rows.
    assert _base._CURRENT_HI == WATERMARK + timedelta(seconds=120), "_CURRENT_HI overwritten to capped hi"


def test_slice_cap_noop_when_batch_smaller_than_slice():
    # Steady state: the batch (wm → HI = +300s) is smaller than a 3600s slice → min() == HI, no clamping.
    lo, hi = _run(incremental=True, full_refresh=False, watermark=WATERMARK, lookback=600, cap=3600)
    assert hi == HI, "a slice wider than the batch is a no-op (steady-state ticks are unaffected)"


def test_slice_cap_bootstrap_walks_from_oldest():
    # First run WITH a cap: no watermark → bootstrap from min(ts_col), window [oldest, oldest+slice].
    oldest = datetime(2026, 7, 16, 2, 0, 0)          # 8h before HI — a big backlog
    con = _FakeCon(min_ts=oldest, max_ts=HI)
    lo, hi = _run(incremental=True, full_refresh=False, watermark=None, lookback=600, cap=7200, con=con,
                  pin_hi=False)
    assert lo == oldest, "bootstrap lo is the OLDEST source row (no lookback applied at the floor)"
    assert hi == oldest + timedelta(seconds=7200), "bootstrap hi = oldest + slice (2h chunk, not full scan)"
    assert _base._CURRENT_HI == oldest + timedelta(seconds=7200), "_CURRENT_HI = capped hi for the advance"


def test_slice_cap_tz_mixed_watermark_and_hi_no_typeerror():
    # Real prod shape: silver_job_watermark stores a NAIVE timestamp, but max(ts_col) on a timestamptz
    # source column is tz-AWARE. The cap's min(hi, wm+slice) must align awareness, not raise
    # "can't compare offset-naive and offset-aware datetimes" (caught by local cold-start repro 2026-07-18).
    from datetime import timezone
    aware_hi = datetime(2026, 7, 16, 10, 5, 0, tzinfo=timezone.utc)
    naive_wm = datetime(2026, 7, 16, 10, 0, 0)  # 300s before hi; a 120s cap clamps to wm + 120s
    _base.INCREMENTAL = True
    _base.FULL_REFRESH = False
    _base.LOOKBACK_SECONDS = 600
    _base.WATERMARK_MAX_SLICE_SECONDS = 120
    _base._CURRENT_HI = aware_hi
    orig = _base.read_watermark
    _base.read_watermark = lambda con, job: naive_wm
    try:
        lo, hi = _base.incremental_window(None, "job-x", "src.tbl", ts_col="kafka_timestamp")
    finally:
        _base.read_watermark = orig
        _base.WATERMARK_MAX_SLICE_SECONDS = 0
        _base._CURRENT_HI = None
    assert hi == datetime(2026, 7, 16, 10, 2, 0, tzinfo=timezone.utc), "clamp to wm+slice across tz-awareness"
    assert lo == naive_wm - timedelta(seconds=600), "lo keeps the naive watermark minus lookback"


if __name__ == "__main__":
    test_default_off_is_full_scan()
    test_on_first_run_no_watermark_is_full_scan()
    test_on_with_watermark_applies_lookback()
    test_full_refresh_forces_full_scan_even_when_on()
    test_zero_lookback_is_strict_half_open()
    test_gold_tier_gate_is_independent_of_silver()
    test_slice_cap_off_by_default_preserves_full_scan_bootstrap()
    test_slice_cap_clamps_established_watermark_to_wm_plus_slice()
    test_slice_cap_noop_when_batch_smaller_than_slice()
    test_slice_cap_bootstrap_walks_from_oldest()
    test_slice_cap_tz_mixed_watermark_and_hi_no_typeerror()
    print("PASS: incremental_window window arithmetic (11/11)")
