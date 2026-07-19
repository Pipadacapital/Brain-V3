"""
test_run_tier_counting.py — run_all.run_tier counts ONLY final-pass failures.

The silver tier runs the rest jobs twice so a job that reads a not-yet-produced sibling on pass 1 converges
on pass 2. A cold/post-flush rebuild fails pass 1 on siblings not yet created (silver_touchpoint,
silver_touchpoint, …). Summing the transient pass-1 failures made a fully-converged run exit non-zero,
which failed the tier and BLOCKED the downstream gold tier (prod 2026-07-18). run_tier must count a soft
job as failed only if it still fails on the FINAL (authoritative) pass.

Self-contained: _run_job_file / glob.glob / TIERS are monkeypatched, so no catalog or job files are needed.
Run:  python -m pytest db/iceberg/duckdb/test_run_tier_counting.py
      (or plain `python db/iceberg/duckdb/test_run_tier_counting.py`)
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import run_all  # noqa: E402


def _drive(tier_spec, job_files, behavior):
    """Run run_tier with _run_job_file/glob/TIERS stubbed. `behavior(name, call_n)` returns True to succeed,
    False to raise (simulating a job failure on that invocation). Returns run_tier's fail count."""
    calls: dict[str, int] = {}
    orig_run, orig_glob, orig_tiers = run_all._run_job_file, run_all.glob.glob, run_all.TIERS

    def fake_run(path):
        name = os.path.basename(path)
        calls[name] = calls.get(name, 0) + 1
        if not behavior(name, calls[name]):
            raise RuntimeError(f"{name} failed on call {calls[name]}")

    run_all._run_job_file = fake_run
    run_all.glob.glob = lambda _pattern: list(job_files)
    run_all.TIERS = {"silver": tier_spec}
    try:
        return run_all.run_tier(None, "silver")
    finally:
        run_all._run_job_file, run_all.glob.glob, run_all.TIERS = orig_run, orig_glob, orig_tiers


SPEC = ("silver", "silver_*.py", ["silver_keystone.py"], [], 2)  # 1 required, 2 passes, no ordered
FILES = ["/j/silver_keystone.py", "/j/silver_converges.py", "/j/silver_broken.py"]


def test_pass1_only_failure_converges_and_is_not_counted():
    # silver_converges fails on its FIRST run (pass 1: sibling absent), succeeds on pass 2 → 0 fails.
    fails = _drive(SPEC, ["/j/silver_keystone.py", "/j/silver_converges.py"],
                   lambda name, n: not (name == "silver_converges.py" and n == 1))
    assert fails == 0, "a job that fails pass 1 but converges on pass 2 must NOT count (gold stays unblocked)"


def test_final_pass_failure_is_counted():
    # silver_broken fails on EVERY pass → a real unconverged failure, counted.
    fails = _drive(SPEC, FILES,
                   lambda name, n: name != "silver_broken.py")
    assert fails == 1, "a job that still fails on the final pass is a real failure and must be counted"


def test_clean_run_is_zero():
    fails = _drive(SPEC, FILES, lambda name, n: True)
    assert fails == 0, "all jobs succeed → 0"


def test_ordered_failure_always_counts():
    # An ordered (single-run) job failure counts regardless of the rest-pass reset.
    spec = ("silver", "silver_*.py", ["silver_keystone.py"], ["silver_ordered.py"], 2)
    fails = _drive(spec, ["/j/silver_keystone.py", "/j/silver_ordered.py", "/j/silver_ok.py"],
                   lambda name, n: name != "silver_ordered.py")
    assert fails == 1, "ordered-job failures are counted independently of the final-pass rest tally"


if __name__ == "__main__":
    test_pass1_only_failure_converges_and_is_not_counted()
    test_final_pass_failure_is_counted()
    test_clean_run_is_zero()
    test_ordered_failure_always_counts()
    print("PASS: run_tier final-pass failure counting (4/4)")
