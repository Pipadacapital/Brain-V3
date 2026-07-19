"""
test_core_only.py — TRANSFORM_CORE_ONLY excludes the v4-identity-owned jobs from the CORE writer.

CORE↔IDENTITY re-split (2026-07-19): identity was decoupled onto its OWN v4-identity cron. When
TRANSFORM_CORE_ONLY is set the CORE writer (resident loop + the single-shot `silver` tier the v4-medallion
cron runs) must NEVER touch an identity-owned Iceberg table — the v4-identity lane is its sole writer.
This proves the two exclusion points:

  1. run_tier('silver') EXCLUDES IDENTITY_OWNED_JOBS from the glob when the flag is on (and INCLUDES them
     when off — today's fully-reversible behaviour).
  2. run_one_tick SKIPS the node identity subprocess AND the explicit silver_identity_map re-projection
     when the flag is on (and runs both when off).

TRANSFORM_CORE_ONLY is read at IMPORT time into run_all.TRANSFORM_CORE_ONLY, so the tests flip the module
attribute directly (monkeypatch) rather than re-importing — same technique as the sibling run_all tests.
Self-contained: _run_job_file / glob.glob / TIERS / _run_identity_subprocess are stubbed, so no catalog,
no DuckDB connection, and no node runtime are needed.

Run:  python -m pytest db/iceberg/duckdb/test_core_only.py
      (or plain `python db/iceberg/duckdb/test_core_only.py`)
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import run_all  # noqa: E402


# The full silver glob the stub returns: the two required spine jobs + a plain core job + the four
# identity-owned jobs. run_tier's `rest` set is everything minus required/ordered (minus identity when
# the flag is on).
SILVER_FILES = [
    "/j/silver_collector_event.py",   # required
    "/j/silver_order_state.py",       # required
    "/j/silver_touchpoint.py",        # plain core job
    "/j/silver_session_identity.py",  # core-owned (reads the map read-only; NOT identity-owned)
    "/j/silver_identity_map.py",      # identity-owned
    "/j/silver_identity_alias.py",    # identity-owned
    "/j/silver_customer_identity.py", # identity-owned
    "/j/silver_identity_unmerge.py",  # identity-owned
    "/j/_normalize_base.py",          # underscore-prefixed → always excluded
]

SILVER_SPEC = ("silver", "silver_*.py",
               ["silver_collector_event.py", "silver_order_state.py"], [], 1)  # 1 pass keeps the tally simple


def _run_silver_collecting(core_only: bool):
    """Run run_tier('silver') with the job runner + glob + TIERS stubbed and TRANSFORM_CORE_ONLY forced.
    Returns the SET of basenames that were actually executed (the `rest` jobs; required run too)."""
    executed: set[str] = set()
    orig_run, orig_glob, orig_tiers, orig_flag = (
        run_all._run_job_file, run_all.glob.glob, run_all.TIERS, run_all.TRANSFORM_CORE_ONLY,
    )

    def fake_run(path):
        executed.add(os.path.basename(path))

    run_all._run_job_file = fake_run
    run_all.glob.glob = lambda _pattern: list(SILVER_FILES)
    run_all.TIERS = {"silver": SILVER_SPEC}
    run_all.TRANSFORM_CORE_ONLY = core_only
    try:
        run_all.run_tier(None, "silver")
        return executed
    finally:
        run_all._run_job_file, run_all.glob.glob = orig_run, orig_glob
        run_all.TIERS, run_all.TRANSFORM_CORE_ONLY = orig_tiers, orig_flag


IDENTITY_JOBS = {
    "silver_identity_map.py", "silver_identity_alias.py",
    "silver_customer_identity.py", "silver_identity_unmerge.py",
}


def test_core_only_excludes_identity_owned_jobs_from_silver():
    executed = _run_silver_collecting(core_only=True)
    leaked = executed & IDENTITY_JOBS
    assert not leaked, f"CORE-ONLY silver must NOT run identity-owned jobs, but ran: {sorted(leaked)}"
    # Core jobs (spine + plain + session-identity) STILL run — core-only excludes only the identity set.
    assert "silver_collector_event.py" in executed  # required spine
    assert "silver_touchpoint.py" in executed
    assert "silver_session_identity.py" in executed, "session-identity is core-owned (reads map read-only)"


def test_flag_off_runs_identity_owned_jobs_reversible():
    # Reversibility contract: flag OFF = today's behaviour — the identity-owned jobs DO run in core silver.
    executed = _run_silver_collecting(core_only=False)
    assert IDENTITY_JOBS <= executed, (
        "flag OFF must preserve pre-flag behaviour (identity jobs run in the silver tier)"
    )


def test_identity_owned_set_matches_module_constant():
    # Guard: the test's expected set is the module's declared IDENTITY_OWNED_JOBS (drift tripwire).
    assert set(run_all.IDENTITY_OWNED_JOBS) == IDENTITY_JOBS


def _run_one_tick_collecting(core_only: bool):
    """Drive run_one_tick with run_tier / _run_identity_subprocess / _run_job_file stubbed and the flag
    forced. Returns (tiers_run, identity_subprocess_called, map_reprojection_called)."""
    tiers: list[str] = []
    calls = {"subprocess": 0, "map": 0}
    orig_tier, orig_sub, orig_run, orig_flag = (
        run_all.run_tier, run_all._run_identity_subprocess, run_all._run_job_file,
        run_all.TRANSFORM_CORE_ONLY,
    )

    def fake_tier(_shared, tier):
        tiers.append(tier)
        return 0

    def fake_sub():
        calls["subprocess"] += 1
        return 0

    def fake_run(path):
        if os.path.basename(path) == "silver_identity_map.py":
            calls["map"] += 1

    run_all.run_tier = fake_tier
    run_all._run_identity_subprocess = fake_sub
    run_all._run_job_file = fake_run
    run_all.TRANSFORM_CORE_ONLY = core_only
    try:
        run_all.run_one_tick(None)
        return tiers, calls["subprocess"], calls["map"]
    finally:
        run_all.run_tier, run_all._run_identity_subprocess = orig_tier, orig_sub
        run_all._run_job_file, run_all.TRANSFORM_CORE_ONLY = orig_run, orig_flag


def test_core_only_tick_skips_identity_subprocess_and_map_reprojection():
    tiers, subprocess_calls, map_calls = _run_one_tick_collecting(core_only=True)
    assert tiers == ["silver", "gold"], "core tick is still silver → gold"
    assert subprocess_calls == 0, "CORE-ONLY must NOT run the node identity subprocess"
    assert map_calls == 0, "CORE-ONLY must NOT re-project silver_identity_map (v4-identity owns it)"


def test_flag_off_tick_runs_identity_subprocess_and_map_reprojection():
    tiers, subprocess_calls, map_calls = _run_one_tick_collecting(core_only=False)
    assert tiers == ["silver", "gold"]
    assert subprocess_calls == 1, "flag OFF preserves the in-process identity subprocess"
    assert map_calls == 1, "flag OFF preserves the silver_identity_map re-projection"


if __name__ == "__main__":
    test_core_only_excludes_identity_owned_jobs_from_silver()
    test_flag_off_runs_identity_owned_jobs_reversible()
    test_identity_owned_set_matches_module_constant()
    test_core_only_tick_skips_identity_subprocess_and_map_reprojection()
    test_flag_off_tick_runs_identity_subprocess_and_map_reprojection()
    print("PASS: TRANSFORM_CORE_ONLY core-only exclusion (5/5)")
