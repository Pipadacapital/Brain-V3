"""
test_maintenance_units.py — pure-logic tests for the PyIceberg maintenance seam (no catalog needed).

The stack-dependent behaviours (COW delete/rewrite, expire + physical sweep, commit-conflict retry)
are gated by maintenance_capability_probe.py against the real REST catalog; these tests pin the
in-process logic that probe can't isolate: retention-window conversion, rewrite-unit coalescing
(merge contiguous ranges, respect gaps and the byte cap), and the erasure input validators.

Run: pytest db/iceberg/duckdb/maintenance/test_maintenance_units.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import _maintenance_base as mb  # noqa: E402
import bronze_raw_retention as brr  # noqa: E402
import erasure_raw_delete as erd  # noqa: E402


# ── Retention-window conversion (exact Spark/Trino window parity) ─────────────────────────────────


def test_ms_to_cutoff_seven_days():
    cutoff = mb.ms_to_cutoff(604_800_000)
    expect = datetime.now(timezone.utc) - timedelta(days=7)
    assert abs((cutoff - expect).total_seconds()) < 5


def test_ms_to_cutoff_zero_is_now():
    # ttl 0 → cutoff = now: the RTBF immediate-purge shape (no Trino min-retention floor to lower).
    assert abs((mb.ms_to_cutoff(0) - datetime.now(timezone.utc)).total_seconds()) < 5


def test_hours_to_cutoff_retention_window():
    cutoff = mb.hours_to_cutoff(168)
    expect = datetime.now(timezone.utc) - timedelta(hours=168)
    assert abs((cutoff - expect).total_seconds()) < 5


# ── Collector-lane retention (ADR-0015 D7: 15-day replay buffer, 14d durable window nested) ──────


def test_collector_retention_hours_default_and_env_parse(monkeypatch):
    import importlib

    monkeypatch.delenv("COLLECTOR_RETENTION_HOURS", raising=False)
    monkeypatch.delenv("DURABLE_SNAPSHOT_TTL_MS", raising=False)
    importlib.reload(brr)
    assert brr.COLLECTOR_RETENTION_HOURS == 360  # 15 days (ADR-0015 D7)
    assert brr.DURABLE_SNAPSHOT_TTL_MS == 1_209_600_000  # 14 days (AUD-OPS-015, same as bronze_maintenance)
    monkeypatch.setenv("COLLECTOR_RETENTION_HOURS", "720")
    importlib.reload(brr)
    assert brr.COLLECTOR_RETENTION_HOURS == 720
    monkeypatch.delenv("COLLECTOR_RETENTION_HOURS")
    importlib.reload(brr)  # restore module defaults for the other tests


def test_lanes_include_collector_on_its_own_window():
    assert brr.COLLECTOR_TABLE == "collector_events_connect"
    assert brr.COLLECTOR_TABLE not in brr.RAW_TABLES  # never double-swept on the raw window
    by_table = {t: (hours, ttl_ms) for t, hours, ttl_ms in brr._lanes()}
    for t in brr.RAW_TABLES:
        # Raw lanes: snapshot-expiry window == row-TTL window (D4).
        assert by_table[t] == (brr.RAW_RETENTION_HOURS, brr.RAW_RETENTION_HOURS * 3_600_000)
    hours, ttl_ms = by_table[brr.COLLECTOR_TABLE]
    assert hours == brr.COLLECTOR_RETENTION_HOURS
    assert ttl_ms == brr.collector_expire_ttl_ms(brr.COLLECTOR_RETENTION_HOURS, brr.DURABLE_SNAPSHOT_TTL_MS)


def test_collector_expiry_never_shrinks_durable_window():
    durable = 1_209_600_000  # 14 days
    # Defaults: 15d row TTL ⊃ 14d durable window → the row-TTL window wins.
    assert brr.collector_expire_ttl_ms(360, durable) == 360 * 3_600_000
    # Row TTL tightened BELOW the durable window → clamped: the 14d rollback window is never shrunk.
    assert brr.collector_expire_ttl_ms(24, durable) == durable
    # Exactly equal windows (336h == 14d) are a no-op clamp.
    assert brr.collector_expire_ttl_ms(336, durable) == durable == 336 * 3_600_000


# ── Rewrite-unit coalescing ───────────────────────────────────────────────────────────────────────


def _day_unit(day: int, n_files: int = 2, n_bytes: int = 1000, kind: str = "tstz"):
    start = datetime(2026, 7, day, tzinfo=timezone.utc)
    return mb._temporal_unit("occurred_at", start, start + timedelta(days=1), n_files, n_bytes, kind)


def test_coalesce_merges_contiguous_days():
    merged = mb._coalesce_temporal([_day_unit(1), _day_unit(2), _day_unit(3)])
    assert len(merged) == 1
    _, _, duck_pred, n_files, n_bytes, span = merged[0]
    assert span == (
        "occurred_at",
        datetime(2026, 7, 1, tzinfo=timezone.utc),
        datetime(2026, 7, 4, tzinfo=timezone.utc),
        "tstz",
    )
    assert n_files == 6 and n_bytes == 3000
    assert "2026-07-01" in duck_pred and "2026-07-04" in duck_pred


def test_coalesce_respects_gaps():
    # A gap day was skipped as already-compacted — merging across it would re-rewrite it.
    merged = mb._coalesce_temporal([_day_unit(1), _day_unit(2), _day_unit(7)])
    assert len(merged) == 2
    assert merged[0][5][2] == datetime(2026, 7, 3, tzinfo=timezone.utc)
    assert merged[1][5][1] == datetime(2026, 7, 7, tzinfo=timezone.utc)


def test_temporal_unit_literal_kinds():
    # The three source-type families the live medallion partitions day() over — each needs its own
    # literal shape (date / naive timestamp / offset timestamp) in BOTH predicates.
    start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    assert "DATE '2026-07-01'" in mb._temporal_unit("d", start, end, 1, 1, "date")[2]
    assert "TIMESTAMP '2026-07-01T00:00:00'" in mb._temporal_unit("t", start, end, 1, 1, "ts")[2]
    assert "TIMESTAMPTZ '2026-07-01T00:00:00+00:00'" in mb._temporal_unit("z", start, end, 1, 1, "tstz")[2]


def test_coalesce_respects_byte_cap():
    # Combined size above OPTIMIZE_MAX_REWRITE_BYTES must not merge (the COW memory valve).
    big = mb.OPTIMIZE_MAX_REWRITE_BYTES
    merged = mb._coalesce_temporal([_day_unit(1, n_bytes=big // 2 + 1), _day_unit(2, n_bytes=big // 2 + 1)])
    assert len(merged) == 2


def test_coalesce_passes_non_temporal_units_through():
    from pyiceberg.expressions import AlwaysTrue

    whole = ("whole-table", AlwaysTrue(), "TRUE", 3, 500, None)
    merged = mb._coalesce_temporal([whole, _day_unit(1), _day_unit(2)])
    assert whole in merged and len(merged) == 2


# ── Erasure input validation (fail-safe: nothing unsafe reaches a predicate) ─────────────────────


def test_brand_id_must_be_uuid():
    with pytest.raises(ValueError):
        erd._validate_brand_id("not-a-uuid'; DROP TABLE x; --")
    assert erd._validate_brand_id("00000000-0000-4000-8000-000000000000")


def test_identifier_hash_must_be_hex64():
    with pytest.raises(ValueError):
        erd._validate_identifier_hash("abc")
    assert erd._validate_identifier_hash("A" * 64) == "a" * 64  # lowercased


def test_raw_ids_sanitized_not_interpolated():
    ids = erd._sanitize_raw_ids(["ok-id_1", "bad'id", "with space", "", "ok-id_1"], "ANON_IDS")
    assert ids == ["ok-id_1"]  # quotes/whitespace dropped, de-duped
