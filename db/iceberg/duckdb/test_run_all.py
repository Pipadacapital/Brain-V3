"""test_run_all.py — the Phase 1d single-process runner's connection-sharing hygiene + the ADR-0016
P2.2 resident warm-worker control loop.

Proves the _SharedConn proxy (the one behavior a shared connection changes):
  1. forwards arbitrary methods to the real connection,
  2. no-ops per-job close() (so a job's `con.close()` doesn't tear down the shared connection),
  3. makes create_function IDEMPOTENT (a job re-registering a UDF on pass 2 — or a name shared across
     jobs — would otherwise raise "already exists" on the shared connection),
  4. _real_close() actually closes.
Plus a sanity check on the tier job-discovery config (required files exist; expected job counts).

RESIDENT WORKER (pure-logic, no duckdb/psycopg/PG):
  5. the tick loop drains on SIGTERM (a signal set mid-loop exits after the in-flight tick),
  6. the leader lock GATES a tick (non-leader ticks skip run_one_tick; leader ticks run + release),
  7. create_function idempotency HOLDS across simulated ticks on the SAME warm _SharedConn,
  8. the /healthz state machine (alive → 200, stopping/dead → 503).
Run: python -m pytest db/iceberg/duckdb/test_run_all.py  (or `python db/iceberg/duckdb/test_run_all.py`).
"""
from __future__ import annotations

import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "silver"))

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


# ══════════════════════════════════════════════════════════════════════════════════════════════════
# ADR-0016 P2.2 — resident warm micro-batch worker: pure-logic control-loop tests
# ══════════════════════════════════════════════════════════════════════════════════════════════════


class _FakeLeader:
    """Stand-in for _LeaderLock — scripts a fixed sequence of leader/non-leader tick outcomes and
    records acquire/release calls so we can assert the loop only releases when it acquired."""

    def __init__(self, outcomes):
        self._outcomes = list(outcomes)
        self.acquires = 0
        self.releases = 0
        self.closed = False

    def try_acquire(self):
        self.acquires += 1
        return self._outcomes.pop(0) if self._outcomes else False

    def release(self):
        self.releases += 1

    def close(self):
        self.closed = True


class _NoopHttpd:
    def shutdown(self):
        pass


def _drive_loop(monkeypatch, *, leader, stop_after_iters, run_one_tick=None):
    """Run run_resident() with the real loop but every external seam faked: no DuckDB attach, no PG,
    no HTTP server, no real sleep. `stop_after_iters` trips the SIGTERM path after N loop iterations
    (counting BOTH leader and non-leader ticks) so the loop always terminates. Returns the captured
    _LoopState + tick/freshness call counts."""
    tick_calls = {"n": 0}
    freshness_calls = {"n": 0}
    box = {}

    def _capture(state, port):
        box["state"] = state
        return _NoopHttpd()

    def _guarded_acquire():
        # Once the budget is spent, trip the stop and return False (non-leader) for THIS iteration so no
        # extra tick runs — the loop then breaks on should_stop(). Deterministic, no real signal needed.
        if leader.acquires >= stop_after_iters and box.get("state") is not None:
            box["state"].request_stop()
            leader.acquires += 1
            return False
        leader.acquires += 1
        return leader._outcomes.pop(0) if leader._outcomes else False

    def _default_tick(shared):
        tick_calls["n"] += 1
        return 0

    monkeypatch.setattr(run_all, "TRANSFORM_TICK_MS", 1)
    monkeypatch.setattr(run_all._catalog, "connect", lambda: _FakeCon())
    monkeypatch.setattr(run_all, "_patch_connect", lambda shared: None)
    monkeypatch.setattr(run_all, "_LeaderLock", lambda key: leader)
    monkeypatch.setattr(run_all, "_start_health_server", _capture)
    monkeypatch.setattr(run_all, "_emit_freshness",
                        lambda shared, dt: freshness_calls.__setitem__("n", freshness_calls["n"] + 1))
    monkeypatch.setattr(run_all.time, "sleep", lambda _s: None)  # no real waiting
    monkeypatch.setattr(leader, "try_acquire", _guarded_acquire)
    monkeypatch.setattr(run_all, "run_one_tick", run_one_tick or _default_tick)

    run_all.run_resident()
    return box.get("state"), tick_calls["n"], freshness_calls["n"]


def test_loop_state_stop_and_liveness():
    st = run_all._LoopState()
    assert st.is_alive() and not st.should_stop()
    st.request_stop()
    assert st.should_stop()
    st.mark_dead()
    assert not st.is_alive()


def test_sigterm_drains_then_exits(monkeypatch):
    # Leader on every tick; the stop is tripped just before the 3rd acquire → exactly 2 ticks run, the
    # in-flight one is never interrupted, and the loop marks itself dead + closes the lock on exit.
    leader = _FakeLeader([True] * 10)
    state, ticks, _fresh = _drive_loop(monkeypatch, leader=leader, stop_after_iters=2)
    assert ticks == 2, f"loop must drain the in-flight tick then stop (ran {ticks})"
    assert state is not None and not state.is_alive(), "loop must mark itself dead on exit"
    assert leader.closed, "leader lock connection must be closed on shutdown"


def test_leader_lock_gates_a_tick(monkeypatch):
    # Iter 1: NOT leader (skip — no tick, no release). Iter 2: leader (run + release). Then stop.
    leader = _FakeLeader([False, True])
    _state, ticks, _fresh = _drive_loop(monkeypatch, leader=leader, stop_after_iters=2)
    assert ticks == 1, "run_one_tick must run ONLY on the leader tick (non-leader ticks skip)"
    assert leader.acquires >= 2, "each iteration attempts to acquire the lock"
    assert leader.releases == 1, "release ONLY after a leader tick (never when acquire was lost)"


def test_create_function_idempotent_across_ticks():
    # A UDF registered on tick 1 must NOT raise when a later tick re-registers it on the SAME warm
    # _SharedConn — the resident worker reuses one connection across ticks, so this is the resident
    # analogue of the pass-1/pass-2 idempotency the single-shot path relies on.
    fc = _FakeCon()
    shared = run_all._SharedConn(fc)
    for _tick in range(3):
        shared.create_function("sr_murmur_hash3_32")  # re-registered every tick
    assert "sr_murmur_hash3_32" in fc._fns


def test_healthz_handler_state_machine():
    # The /healthz endpoint returns 200 while alive+running, 503 once stopping or dead. We exercise the
    # decision the handler makes without binding a real socket.
    st = run_all._LoopState()
    assert st.is_alive() and not st.should_stop()  # → 200
    st.request_stop()
    assert not (st.is_alive() and not st.should_stop())  # draining → 503
    st2 = run_all._LoopState()
    st2.mark_dead()
    assert not (st2.is_alive() and not st2.should_stop())  # dead → 503


def test_run_one_tick_ordering(monkeypatch):
    # run_one_tick must call: silver tier → node identity subprocess → map re-project → gold tier, in
    # that order (the cross-language chain). We record the sequence via fakes.
    seq = []
    monkeypatch.setattr(run_all, "run_tier", lambda shared, tier: seq.append(f"tier:{tier}") or 0)
    monkeypatch.setattr(run_all, "_run_identity_subprocess", lambda: seq.append("identity") or 0)
    monkeypatch.setattr(run_all, "_run_job_file", lambda path: seq.append(f"job:{os.path.basename(path)}"))
    fails = run_all.run_one_tick(run_all._SharedConn(_FakeCon()))
    assert seq == ["tier:silver", "identity", "job:silver_identity_map.py", "tier:gold"], seq
    assert fails == 0


def test_identity_subprocess_counts_failure(monkeypatch):
    # A non-zero identity subprocess (or map failure) must be COUNTED but never abort the tick.
    monkeypatch.setattr(run_all, "run_tier", lambda shared, tier: 0)
    monkeypatch.setattr(run_all, "_run_identity_subprocess", lambda: 1)  # node job failed
    monkeypatch.setattr(run_all, "_run_job_file", lambda path: None)
    fails = run_all.run_one_tick(run_all._SharedConn(_FakeCon()))
    assert fails == 1, "a failed identity subprocess counts 1 failure but the tick still runs gold"


def _dsn_with_env(**env):
    saved = {k: os.environ.get(k) for k in env}
    try:
        for k, v in env.items():
            os.environ[k] = v
        return run_all._LeaderLock(910005)._dsn()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_leader_lock_dsn_from_jdbc_env():
    # _LeaderLock._dsn must convert SILVER_PG_JDBC_URL → a libpq DSN with the derived host/port/db and
    # the SILVER_PG_USER/PASSWORD (the same env the transforms read). No PG connection is opened.
    dsn = _dsn_with_env(
        SILVER_PG_JDBC_URL="jdbc:postgresql://aurora-host:6543/braindb?sslmode=require",
        SILVER_PG_USER="brain_app",
        SILVER_PG_PASSWORD="s3cr3t",
    )
    assert "host=aurora-host" in dsn
    assert "port=6543" in dsn
    assert "dbname=braindb" in dsn  # ?sslmode stripped for libpq
    assert "user=brain_app" in dsn
    assert "password=s3cr3t" in dsn


def test_leader_lock_dsn_from_jdbc_env_smoke():
    test_leader_lock_dsn_from_jdbc_env()


if __name__ == "__main__":
    # The monkeypatch-driven loop tests (SIGTERM drain, leader-lock gate, ordering) run under pytest;
    # this bare-invocation path exercises the seam-free unit tests as a quick smoke check.
    test_proxy_forwards_methods()
    test_per_job_close_is_a_noop()
    test_create_function_is_idempotent()
    test_create_function_message_fallback_on_real_duckdb_text()
    test_create_function_still_raises_non_duplicate_errors()
    test_real_close_closes()
    test_tier_config_files_exist()
    test_loop_state_stop_and_liveness()
    test_create_function_idempotent_across_ticks()
    test_healthz_handler_state_machine()
    test_leader_lock_dsn_from_jdbc_env_smoke()
    print("PASS: run_all runner hygiene + resident control loop (seam-free subset)")
