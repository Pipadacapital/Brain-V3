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
