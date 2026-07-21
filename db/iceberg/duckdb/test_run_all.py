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
    monkeypatch.setenv("TRANSFORM_PREFLIGHT", "0")  # DR-007: loop test, not a dependency test
    # Leader on every tick; the stop is tripped just before the 3rd acquire → exactly 2 ticks run, the
    # in-flight one is never interrupted, and the loop marks itself dead + closes the lock on exit.
    leader = _FakeLeader([True] * 10)
    state, ticks, _fresh = _drive_loop(monkeypatch, leader=leader, stop_after_iters=2)
    assert ticks == 2, f"loop must drain the in-flight tick then stop (ran {ticks})"
    assert state is not None and not state.is_alive(), "loop must mark itself dead on exit"
    assert leader.closed, "leader lock connection must be closed on shutdown"


def test_leader_lock_gates_a_tick(monkeypatch):
    monkeypatch.setenv("TRANSFORM_PREFLIGHT", "0")  # DR-007: loop test, not a dependency test
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


def test_refresh_shared_swaps_connection_and_resets_udfs(monkeypatch):
    # Wave 3: _refresh_shared must swap a FRESH connection under the same proxy, close the old one, and
    # reset the UDF registry (a fresh connection has no registered functions) — so the next tick reads
    # current Iceberg metadata and re-registers cleanly. The proxy IDENTITY is preserved (so
    # _patch_connect's closure keeps returning the same object without re-patching).
    old = _FakeCon()
    shared = run_all._SharedConn(old)
    shared.create_function("sr_murmur_hash3_32")
    assert "sr_murmur_hash3_32" in object.__getattribute__(shared, "_registered")

    fresh = _FakeCon()
    monkeypatch.setattr(run_all._catalog, "connect", lambda: fresh)
    run_all._refresh_shared(shared)

    assert object.__getattribute__(shared, "_con") is fresh          # swapped to the new connection
    assert old.closed is True                                        # old connection closed
    assert object.__getattribute__(shared, "_registered") == set()   # UDF registry reset for the fresh con
    # the proxy re-registers on the fresh connection without raising
    shared.create_function("sr_murmur_hash3_32")
    assert "sr_murmur_hash3_32" in fresh._fns


def test_refresh_shared_keeps_live_con_when_old_close_errors(monkeypatch):
    # A stale-connection close error must NOT strand the tick — the fresh connection is already swapped in.
    class _BadCloseCon(_FakeCon):
        def close(self):
            raise RuntimeError("stale handle")

    shared = run_all._SharedConn(_BadCloseCon())
    fresh = _FakeCon()
    monkeypatch.setattr(run_all._catalog, "connect", lambda: fresh)
    run_all._refresh_shared(shared)  # must not raise
    assert object.__getattribute__(shared, "_con") is fresh


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


# ── DR-007 P1: boot-time preflight (pure-logic — probes stubbed, no live deps) ──────────────────────

def test_preflight_aggregates_all_failures(monkeypatch):
    """Every broken dependency lands in ONE report (the 2026-07-19 serial-discovery fix)."""
    import run_all
    monkeypatch.setenv("TRANSFORM_PREFLIGHT", "1")
    monkeypatch.delenv("TRANSFORM_PREFLIGHT_SKIP", raising=False)
    monkeypatch.setattr(run_all, "_probe_env", lambda: ["env: broken"])
    monkeypatch.setattr(run_all, "_probe_pg", lambda: ["pg: broken"])
    monkeypatch.setattr(run_all, "_probe_rest", lambda: ["rest: broken"])
    monkeypatch.setattr(run_all, "_probe_warehouse", lambda shared: ["warehouse: broken"])
    assert run_all._run_preflight(shared=object()) == 4


def test_preflight_skip_flags(monkeypatch):
    """TRANSFORM_PREFLIGHT_SKIP skips individual probes; TRANSFORM_PREFLIGHT=0 skips everything."""
    import run_all
    monkeypatch.setenv("TRANSFORM_PREFLIGHT_SKIP", "pg,warehouse")
    monkeypatch.setattr(run_all, "_probe_env", lambda: [])
    monkeypatch.setattr(run_all, "_probe_rest", lambda: [])
    monkeypatch.setattr(run_all, "_probe_pg", lambda: (_ for _ in ()).throw(AssertionError("must be skipped")))
    monkeypatch.setattr(run_all, "_probe_warehouse",
                        lambda shared: (_ for _ in ()).throw(AssertionError("must be skipped")))
    assert run_all._run_preflight(shared=object()) == 0
    monkeypatch.setenv("TRANSFORM_PREFLIGHT", "0")
    monkeypatch.setattr(run_all, "_probe_env", lambda: ["env: broken"])
    assert run_all._run_preflight(shared=object()) == 0


def test_preflight_warehouse_tolerates_absent_table():
    """A fresh env's absent probe table is a PASS (the catalog answered); auth errors are failures."""
    import run_all

    class _AbsentConn:
        def execute(self, _sql):
            raise RuntimeError("Catalog Error: Table collector_events_connect does not exist")

    class _ForbiddenConn:
        def execute(self, _sql):
            raise RuntimeError("HTTP Error: HTTP GET error (HTTP 403)")

    assert run_all._probe_warehouse(_AbsentConn()) == []
    assert len(run_all._probe_warehouse(_ForbiddenConn())) == 1


def test_preflight_env_probe(monkeypatch):
    import run_all
    for var in ("ICEBERG_REST_URI", "SILVER_PG_JDBC_URL", "DATABASE_URL", "DATABASE_URL_DIRECT"):
        monkeypatch.delenv(var, raising=False)
    fails = run_all._probe_env()
    assert len(fails) == 2  # no catalog URI + no PG source
    monkeypatch.setenv("ICEBERG_REST_URI", "http://iceberg-rest:8181")
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@h:5432/brain")
    assert run_all._probe_env() == []


# ── Wave 2a: hot-table maintenance folded into the transform tick ────────────────────────────────────


def test_tick_maint_tables_empty_is_noop(monkeypatch):
    # DEFAULT (unset / empty) → no tables → the hook is a pure no-op (the safe default the task requires).
    monkeypatch.delenv("TICK_MAINT_TABLES", raising=False)
    assert run_all._tick_maint_tables() == []
    monkeypatch.setenv("TICK_MAINT_TABLES", "   ")
    assert run_all._tick_maint_tables() == []


def test_tick_maint_tables_parses_bare_names(monkeypatch):
    # Bare names resolve against TICK_MAINT_NAMESPACE (default = the Silver namespace). Whitespace and
    # empty entries (trailing comma) are tolerated.
    monkeypatch.delenv("TICK_MAINT_NAMESPACE", raising=False)
    monkeypatch.setenv("TICK_MAINT_TABLES", "silver_collector_event, silver_touchpoint ,")
    assert run_all._tick_maint_tables() == [
        (run_all._catalog.SILVER_NAMESPACE, "silver_collector_event"),
        (run_all._catalog.SILVER_NAMESPACE, "silver_touchpoint"),
    ]


def test_tick_maint_tables_ns_qualified_and_override(monkeypatch):
    # `ns:table` overrides the default namespace per-token; TICK_MAINT_NAMESPACE overrides the default
    # for bare names — so a Gold hot table can be mixed in later.
    monkeypatch.setenv("TICK_MAINT_NAMESPACE", "brain_silver")
    monkeypatch.setenv("TICK_MAINT_TABLES", "silver_collector_event,brain_gold:gold_customer_360")
    assert run_all._tick_maint_tables() == [
        ("brain_silver", "silver_collector_event"),
        ("brain_gold", "gold_customer_360"),
    ]


def test_run_tick_maintenance_noop_when_unset(monkeypatch):
    # With no tables configured the hook must NOT even import/connect the maintenance client. We assert
    # it returns None and never touched pyiceberg_catalog by making an import failure fatal if reached.
    monkeypatch.delenv("TICK_MAINT_TABLES", raising=False)
    called = {"n": 0}
    monkeypatch.setattr(run_all, "_tick_maint_tables", lambda: (called.__setitem__("n", called["n"] + 1) or []))
    assert run_all._run_tick_maintenance() is None
    assert called["n"] == 1  # parsed once, then short-circuited (no catalog connect)


def _install_fake_mb(monkeypatch, *, optimize, expire=None):
    """Register a fake `_maintenance_base` module under the maintenance dir so the hook's lazy
    `import _maintenance_base as mb` resolves to it. Returns the recorded call log."""
    import types

    calls = {"optimize": [], "expire": []}
    fake = types.ModuleType("_maintenance_base")
    fake.pyiceberg_catalog = lambda: "CATALOG"

    def _optimize(cat, ns, tbl, *a, **k):
        calls["optimize"].append((cat, ns, tbl))
        return optimize(cat, ns, tbl)

    def _expire(cat, ns, tbl, ttl_ms):
        calls["expire"].append((cat, ns, tbl, ttl_ms))
        if expire:
            expire(cat, ns, tbl, ttl_ms)

    fake.optimize = _optimize
    fake.expire = _expire
    monkeypatch.setitem(sys.modules, "_maintenance_base", fake)
    return calls


def test_run_tick_maintenance_compacts_configured_tables(monkeypatch):
    monkeypatch.setenv("TICK_MAINT_TABLES", "silver_collector_event,silver_touchpoint")
    monkeypatch.delenv("TICK_MAINT_NAMESPACE", raising=False)
    monkeypatch.delenv("SNAPSHOT_TTL_MS", raising=False)
    calls = _install_fake_mb(monkeypatch, optimize=lambda *_: None)
    assert run_all._run_tick_maintenance() is None
    ns = run_all._catalog.SILVER_NAMESPACE
    assert [(c[1], c[2]) for c in calls["optimize"]] == [(ns, "silver_collector_event"), (ns, "silver_touchpoint")]
    # expire always follows optimize with the 7-day default TTL.
    assert [(c[1], c[2], c[3]) for c in calls["expire"]] == [
        (ns, "silver_collector_event", 604_800_000),
        (ns, "silver_touchpoint", 604_800_000),
    ]


def test_run_tick_maintenance_isolates_a_failing_optimize(monkeypatch):
    # A raising optimize on ONE table must NOT propagate and must NOT stop the OTHER table — mirroring
    # medallion_maintenance.maintain's per-table try/except. This is the mandatory failure-isolation
    # requirement: the hook always returns None.
    monkeypatch.setenv("TICK_MAINT_TABLES", "silver_collector_event,silver_touchpoint")
    monkeypatch.delenv("TICK_MAINT_NAMESPACE", raising=False)

    def _optimize(cat, ns, tbl):
        if tbl == "silver_collector_event":
            raise RuntimeError("CommitFailedException: boom")

    calls = _install_fake_mb(monkeypatch, optimize=_optimize)
    # Must not raise, must return None.
    assert run_all._run_tick_maintenance() is None
    # The SECOND table still got optimized+expired despite the first table blowing up.
    assert (run_all._catalog.SILVER_NAMESPACE, "silver_touchpoint") in [(c[1], c[2]) for c in calls["optimize"]]
    assert (run_all._catalog.SILVER_NAMESPACE, "silver_touchpoint") in [(c[1], c[2]) for c in calls["expire"]]


def test_run_tick_maintenance_never_fails_the_run_on_catalog_error(monkeypatch):
    # If even pyiceberg_catalog() blows up (catalog unreachable), the ENTIRE hook is swallowed — the
    # transform run's exit code must be unaffected. We prove _run_tick_maintenance returns None.
    import types

    monkeypatch.setenv("TICK_MAINT_TABLES", "silver_collector_event")
    fake = types.ModuleType("_maintenance_base")

    def _boom():
        raise RuntimeError("REST catalog unreachable")

    fake.pyiceberg_catalog = _boom
    fake.optimize = lambda *a, **k: None
    fake.expire = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, "_maintenance_base", fake)
    assert run_all._run_tick_maintenance() is None


def test_main_gold_calls_hook_and_tier_failure_alone_sets_exit(monkeypatch):
    # End-to-end at the gold call site: main('gold') runs the gold tier then the hook. The hook is invoked
    # exactly once AFTER the tier, and main's return code reflects ONLY the tier's failure tally — the hook
    # (best-effort) never contributes to it. Here the tier is CLEAN (0) so main returns 0 even though the
    # hook ran. This is the single-shot cron path a compaction conflict must never fail.
    seq = []
    monkeypatch.setattr(run_all._catalog, "connect", lambda: _FakeCon())
    monkeypatch.setattr(run_all, "_patch_connect", lambda shared: None)
    monkeypatch.setattr(run_all, "run_tier", lambda shared, tier: seq.append(f"tier:{tier}") or 0)
    monkeypatch.setattr(run_all, "_run_tick_maintenance", lambda: seq.append("hook"))
    monkeypatch.setattr(sys, "argv", ["run_all.py", "gold"])
    assert run_all.main() == 0
    assert seq == ["tier:gold", "hook"], seq  # hook runs AFTER the tier, in-process


def test_run_tick_maintenance_is_exception_walled_end_to_end(monkeypatch):
    # The hook OWNS a total exception wall: even a mid-loop RuntimeError in mb.expire is swallowed and the
    # function returns None. (The per-table wall is tested above; this pins the OUTER wall around the whole
    # thing — the contract that main's exit code can never be moved by the hook.)
    monkeypatch.setenv("TICK_MAINT_TABLES", "silver_collector_event")
    monkeypatch.delenv("TICK_MAINT_NAMESPACE", raising=False)
    _install_fake_mb(
        monkeypatch,
        optimize=lambda *_: None,
        expire=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("expire exploded")),
    )
    assert run_all._run_tick_maintenance() is None
