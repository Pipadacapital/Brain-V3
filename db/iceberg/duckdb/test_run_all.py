"""test_run_all.py — the Phase 1d single-process runner's connection-sharing hygiene.

Proves the _SharedConn proxy (the one behavior a shared connection changes):
  1. forwards arbitrary methods to the real connection,
  2. no-ops per-job close() (so a job's `con.close()` doesn't tear down the shared connection),
  3. makes create_function IDEMPOTENT (a job re-registering a UDF on pass 2 — or a name shared across
     jobs — would otherwise raise "already exists" on the shared connection),
  4. _real_close() actually closes.
Plus a sanity check on the tier job-discovery config (required files exist; expected job counts).
Run: python -m pytest db/iceberg/duckdb/test_run_all.py  (or `python db/iceberg/duckdb/test_run_all.py`).
"""
from __future__ import annotations

import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import run_all  # noqa: E402


class _FakeCon:
    def __init__(self):
        self.closed = False
        self.executed = []
        self._fns = set()

    def execute(self, q):
        self.executed.append(q)
        return "RESULT"

    def close(self):
        self.closed = True

    def create_function(self, name, *_a, **_k):
        if name in self._fns:
            # DuckDB's REAL duplicate-UDF message (captured from prod 2026-07-16) — says "already
            # CREATED", not "already exists". The first test used an invented "already exists" message,
            # which let a wrong string-match ship and fail live on silver_touchpoint. Test the real text.
            raise RuntimeError(
                f"Not implemented Error: A function by the name of '{name}' is already created, "
                "creating multiple functions with the same name is not supported yet, "
                "please remove it first"
            )
        self._fns.add(name)


def test_proxy_forwards_methods():
    s = run_all._SharedConn(_FakeCon())
    assert s.execute("SELECT 1") == "RESULT"


def test_per_job_close_is_a_noop():
    fc = _FakeCon()
    s = run_all._SharedConn(fc)
    s.close()  # a job's con.close()
    assert fc.closed is False, "per-job close() must NOT tear down the shared connection"


def test_create_function_is_idempotent():
    fc = _FakeCon()
    s = run_all._SharedConn(fc)
    s.create_function("sr_murmur_hash3_32")  # first registration (job A, e.g. silver_sessions)
    # Second registration (job B, e.g. silver_touchpoint / pass 2) must NOT raise — this is the exact
    # prod failure of 2026-07-16. With the set pre-check this short-circuits before touching DuckDB.
    s.create_function("sr_murmur_hash3_32")
    assert "sr_murmur_hash3_32" in fc._fns


def test_create_function_message_fallback_on_real_duckdb_text():
    # Force the EXCEPTION path (bypass the set pre-check) by pre-populating the fake's registry —
    # the proxy has never seen the name, DuckDB raises the real "is already created" message, and the
    # proxy must swallow it (the exact string that slipped past the first "already exists" match).
    fc = _FakeCon()
    fc._fns.add("sce_event_category")
    s = run_all._SharedConn(fc)
    s.create_function("sce_event_category")  # must not raise
    # And it must now be memoized so repeats short-circuit.
    s.create_function("sce_event_category")


def test_create_function_still_raises_non_duplicate_errors():
    class _BadCon(_FakeCon):
        def create_function(self, name, *_a, **_k):
            raise RuntimeError("some OTHER duckdb error")

    s = run_all._SharedConn(_BadCon())
    try:
        s.create_function("x")
    except RuntimeError as e:
        assert "OTHER" in str(e)
    else:
        raise AssertionError("a non-'already exists' error must propagate")


def test_real_close_closes():
    fc = _FakeCon()
    s = run_all._SharedConn(fc)
    s._real_close()
    assert fc.closed is True


def test_tier_config_files_exist():
    here = os.path.dirname(os.path.abspath(__file__))
    for tier, (subdir, pattern, required, ordered, passes) in run_all.TIERS.items():
        d = os.path.join(here, subdir)
        for r in required + ordered:
            assert os.path.exists(os.path.join(d, r)), f"{tier}: required job {r} missing"
        rest = [
            b for b in (os.path.basename(p) for p in glob.glob(os.path.join(d, pattern)))
            if b not in set(required) | set(ordered) and not b.startswith("_")
        ]
        assert len(rest) > 0, f"{tier}: no rest jobs discovered"


if __name__ == "__main__":
    test_proxy_forwards_methods()
    test_per_job_close_is_a_noop()
    test_create_function_is_idempotent()
    test_create_function_message_fallback_on_real_duckdb_text()
    test_create_function_still_raises_non_duplicate_errors()
    test_real_close_closes()
    test_tier_config_files_exist()
    print("PASS: run_all single-process runner hygiene (7/7)")
