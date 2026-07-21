"""test_engine.py — statement guard (pure unit) + epoch lifecycle (live, auto-skipped).

The guard tests are the serving tier's write-defense contract: only ONE bare SELECT/WITH is
ever executed (string-literal/comment aware — a ';' or '--' inside a literal is data). The
live tests build a REAL epoch against the Iceberg REST catalog (read-only attach + cursor
query + rotation) and SKIP when the stack is unreachable, so the suite is green on any dev
machine and exercises the full path when `pnpm dev:up` is running.

Live-test env: defaults target the local compose stack from the HOST (localhost:8181 /
localhost:9000) — set BEFORE the engine import because _catalog.py reads env at import time.
Run: python -m pytest db/iceberg/duckdb/serving/test_engine.py
"""
from __future__ import annotations

import os
import sys
import urllib.request

# Host-side defaults for the live tests (in-cluster DNS names don't resolve from the host).
# setdefault — an explicitly-configured environment always wins.
os.environ.setdefault("ICEBERG_CATALOG", "iceberg")
os.environ.setdefault("ICEBERG_REST_URI", "http://localhost:8181")
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "brain")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "brainbrain")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

import engine  # noqa: E402
from engine import QueryRejected, guard_statement  # noqa: E402


def _stack_reachable() -> bool:
    try:
        with urllib.request.urlopen(f"{os.environ['ICEBERG_REST_URI']}/v1/config", timeout=3) as resp:
            return resp.status == 200
    except Exception:  # noqa: BLE001 — any failure = no stack
        return False


STACK = _stack_reachable()
needs_stack = pytest.mark.skipif(not STACK, reason="Iceberg REST catalog unreachable (ICEBERG_REST_URI)")


# ── the SELECT/WITH-only guard (pure unit) ─────────────────────────────────────────────────────


# ── epoch pre-warm list parsing (pure unit) ────────────────────────────────────────────────────


def test_parse_prewarm_tables():
    assert engine.parse_prewarm_tables("") == []
    assert engine.parse_prewarm_tables(" , ,") == []
    assert engine.parse_prewarm_tables(
        "brain_serving.mv_silver_collector_event, brain_serving.mv_silver_touchpoint"
    ) == ["brain_serving.mv_silver_collector_event", "brain_serving.mv_silver_touchpoint"]


# ── the per-request timeout clamp (pure unit) ──────────────────────────────────────────────────


def test_clamp_timeout_defaults_when_absent_or_invalid():
    # Absent / invalid / non-positive → the OLTP default, never a disabled watchdog.
    assert engine.clamp_timeout_ms(None) == engine.STATEMENT_TIMEOUT_MS
    assert engine.clamp_timeout_ms("nope") == engine.STATEMENT_TIMEOUT_MS  # type: ignore[arg-type]
    assert engine.clamp_timeout_ms(0) == engine.STATEMENT_TIMEOUT_MS
    assert engine.clamp_timeout_ms(-5_000) == engine.STATEMENT_TIMEOUT_MS


def test_clamp_timeout_honors_raise_within_cap():
    # A batch caller may raise its budget (silver-identity keystone reads)…
    assert engine.clamp_timeout_ms(120_000) == 120_000
    # …the floor keeps a pathological tiny budget sane…
    assert engine.clamp_timeout_ms(1) == 1_000
    # …and the STATEMENT_TIMEOUT_MAX_MS cap is the single-query-ceiling backstop.
    assert engine.clamp_timeout_ms(10**9) == engine.STATEMENT_TIMEOUT_MAX_MS


def test_guard_accepts_select_and_with():
    guard_statement("SELECT 1")
    guard_statement("  select brand_id FROM brain_serving.mv_gold_revenue_ledger WHERE brand_id = ?")
    guard_statement("WITH x AS (SELECT 1) SELECT * FROM x")
    guard_statement("SELECT 1;")           # trailing semicolon tolerated
    guard_statement("SELECT 1 ;  ; ")      # even several trailing ones


def test_guard_accepts_comment_led_select():
    guard_statement("-- serving read\nSELECT 1")
    guard_statement("/* block */ SELECT 1")


def test_guard_rejects_writes_and_ddl():
    for sql in (
        "INSERT INTO t VALUES (1)",
        "CREATE TABLE t (a INT)",
        "CREATE OR REPLACE VIEW v AS SELECT 1",
        "DROP TABLE t",
        "DELETE FROM t",
        "UPDATE t SET a = 1",
        "MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN UPDATE SET a = 1",
        "ATTACH 'x' AS y",
        "PRAGMA database_list",
        "SET memory_limit='100TB'",
        "COPY t TO '/tmp/x.csv'",
        "CALL some_proc()",
    ):
        with pytest.raises(QueryRejected):
            guard_statement(sql)


def test_guard_rejects_multi_statement_chains():
    with pytest.raises(QueryRejected):
        guard_statement("SELECT 1; SELECT 2")
    with pytest.raises(QueryRejected):
        guard_statement("SELECT 1; DROP TABLE t")


def test_guard_rejects_empty_and_comment_only():
    for sql in ("", "   ", ";", "-- nothing here", "/* nothing */"):
        with pytest.raises(QueryRejected):
            guard_statement(sql)


def test_guard_string_literal_awareness():
    # ';' and '--' INSIDE a literal are data, not statement separators/comments.
    guard_statement("SELECT 'a;b' AS x")
    guard_statement("SELECT 'not -- a comment' AS x")
    guard_statement("SELECT 'it''s fine; really' AS x")
    # …but a real second statement after a literal is still caught.
    with pytest.raises(QueryRejected):
        guard_statement("SELECT 'a;b' AS x; DROP TABLE t")


def test_guard_rejects_unterminated_block_comment():
    with pytest.raises(QueryRejected):
        guard_statement("SELECT 1 /* runaway")


# ── epoch lifecycle against the live stack (auto-skipped without it) ───────────────────────────


@needs_stack
def test_epoch_build_query_and_rotation(tmp_path):
    eng = engine.Engine(views_dir=str(tmp_path))  # empty views dir → 0 applied, still ready
    try:
        eng.rotate_once()
        status = eng.status()
        assert status["ready"] is True
        assert status["views_applied"] == 0
        assert status["views_skipped"] == []

        description, rows = eng.query("SELECT 1 AS x, 'y' AS s")
        assert [d[0] for d in description] == ["x", "s"]
        assert rows == [(1, "y")]

        # Rotation swaps epochs (monotonic index) and the new epoch serves immediately.
        eng.rotate_once()
        assert eng.status()["epoch"] == 2
        _, rows2 = eng.query("SELECT 2 AS x")
        assert rows2 == [(2,)]
    finally:
        eng.stop()


@needs_stack
def test_cursor_sessions_are_utc(tmp_path):
    # REGRESSION (smoke run, 2026-07-16): cursors do NOT inherit a session-local SET TimeZone —
    # without the epoch's SET GLOBAL, a request cursor parsed TIMESTAMPTZ literals in the HOST
    # timezone and shifted every timestamptz comparison/rendering (spike gate e holds only
    # under UTC). Assert through the full engine path (guard → semaphore → cursor → watchdog).
    eng = engine.Engine(views_dir=str(tmp_path))
    try:
        eng.rotate_once()
        _, rows = eng.query("SELECT current_setting('TimeZone') AS tz")
        assert rows == [("UTC",)]
        _, rows = eng.query("SELECT TIMESTAMPTZ '2026-07-16 10:00:00.5' AS at_ts")
        assert rows[0][0].utcoffset().total_seconds() == 0
        assert rows[0][0].hour == 10  # parsed AS UTC, not shifted from the host TZ
    finally:
        eng.stop()


@needs_stack
def test_read_only_attach_rejects_catalog_writes(tmp_path):
    # Defense-in-depth UNDER the guard: even a raw write on the connection fails (spike gate c).
    eng = engine.Engine(views_dir=str(tmp_path))
    try:
        eng.rotate_once()
        with eng._epoch_lock:
            con = eng._epoch.con
        with pytest.raises(Exception):
            con.execute(f"CREATE TABLE {os.environ['ICEBERG_CATALOG']}.brain_serving.__guard_probe (a INT)")
    finally:
        eng.stop()


@needs_stack
def test_not_ready_engine_returns_engine_not_ready(tmp_path):
    eng = engine.Engine(views_dir=str(tmp_path))  # never rotated → no epoch
    with pytest.raises(engine.EngineNotReady):
        eng.query("SELECT 1")


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
