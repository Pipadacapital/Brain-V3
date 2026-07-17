"""
test_bronze_dedup_units.py — pure-logic tests for the Bronze compaction-dedup job (no catalog).

Same posture as test_maintenance_units.py: the stack-dependent behaviours (COW overwrite, commit
retry, arrow cast) are gated by maintenance_capability_probe.py against the real REST catalog;
these tests pin the in-process logic — the duplicate-detection / survivor SQL shapes (NULL-key
guard, keep-latest ordering, JSON key lift) and the day-aligned span math the overwrite filter is
built from.

Run: pytest db/iceberg/duckdb/maintenance/test_bronze_dedup_units.py
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import bronze_dedup as bd  # noqa: E402


# ── Day-aligned rewrite span (must cover every copy, half-open, UTC) ─────────────────────────────


def test_day_span_floors_and_extends_one_day():
    start, end = bd.day_span(
        datetime(2026, 7, 1, 13, 45, tzinfo=timezone.utc),
        datetime(2026, 7, 3, 0, 0, 1, tzinfo=timezone.utc),
    )
    assert start == datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert end == datetime(2026, 7, 4, tzinfo=timezone.utc)  # half-open: max's day fully included


def test_day_span_single_instant_covers_its_day():
    ts = datetime(2026, 7, 2, 23, 59, 59, tzinfo=timezone.utc)
    start, end = bd.day_span(ts, ts)
    assert start == datetime(2026, 7, 2, tzinfo=timezone.utc)
    assert end == datetime(2026, 7, 3, tzinfo=timezone.utc)


def test_day_span_accepts_naive_timestamps():
    # DuckDB hands back naive datetimes for a TIMESTAMP-typed kafka_timestamp — treated as UTC.
    start, end = bd.day_span(datetime(2026, 7, 1, 5, 0), datetime(2026, 7, 1, 6, 0))
    assert start == datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert end == datetime(2026, 7, 2, tzinfo=timezone.utc)


# ── SQL shapes (the correctness-bearing clauses must be present verbatim) ────────────────────────


def test_dup_span_sql_lifts_key_from_payload_and_excludes_nulls():
    sql = bd.dup_span_sql("rest.brain_bronze.collector_events_connect")
    # The key is LIFTED from the verbatim envelope payload — same paths the Silver keystone lifts.
    assert "json_extract_string(payload, '$.brand_id')" in sql
    assert "json_extract_string(payload, '$.event_id')" in sql
    # NULL-keyed / NULL-timestamp rows are never dedup candidates.
    assert "IS NOT NULL" in sql
    assert "kafka_timestamp IS NOT NULL" in sql
    assert "HAVING count(*) > 1" in sql


def test_survivors_sql_keep_latest_ordering_and_null_guard():
    sql = bd.survivors_sql("rest.brain_bronze.collector_events_connect", "TRUE")
    # Keep-latest: highest (kafka_timestamp, kafka_offset, kafka_partition) copy survives.
    assert "ORDER BY kafka_timestamp DESC, kafka_offset DESC, kafka_partition DESC" in sql
    # NULL-keyed rows short-circuit the QUALIFY guard — passed through verbatim, never collapsed.
    assert f"{bd.BRAND_EXPR} IS NULL OR {bd.EVENT_EXPR} IS NULL OR kafka_timestamp IS NULL" in sql
    # Exactly one survivor per duplicated key.
    assert ") = 1" in sql.replace("\n", " ")


def test_survivors_sql_embeds_span_predicate():
    pred = "kafka_timestamp >= TIMESTAMPTZ '2026-07-01T00:00:00+00:00'"
    sql = bd.survivors_sql("t", pred)
    assert pred in sql


# ── Span-bytes partition-value normalization (int days-since-epoch AND date shapes) ──────────────


class _FakeFiles:
    def __init__(self, rows):
        self._rows = rows

    def to_pylist(self):
        return self._rows


class _FakeInspect:
    def __init__(self, rows):
        self._rows = rows

    def files(self):
        return _FakeFiles(self._rows)


class _FakeTable:
    def __init__(self, rows):
        self.inspect = _FakeInspect(rows)


def test_span_bytes_counts_only_in_span_data_files():
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    in_day = (datetime(2026, 7, 2, tzinfo=timezone.utc) - epoch).days
    out_day = (datetime(2026, 6, 1, tzinfo=timezone.utc) - epoch).days
    rows = [
        {"content": 0, "file_size_in_bytes": 100, "partition": {"kafka_timestamp_day": in_day}},
        {"content": 0, "file_size_in_bytes": 40, "partition": {"kafka_timestamp_day": out_day}},
        # date-object partition value (the other inspect.files() rendering)
        {"content": 0, "file_size_in_bytes": 7, "partition": {"kafka_timestamp_day": datetime(2026, 7, 3, tzinfo=timezone.utc).date()}},
        # delete-content file — never counted
        {"content": 1, "file_size_in_bytes": 999, "partition": {"kafka_timestamp_day": in_day}},
        # unpartitioned file — counted conservatively (assumed in-span)
        {"content": 0, "file_size_in_bytes": 3, "partition": {}},
    ]
    start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    end = datetime(2026, 7, 4, tzinfo=timezone.utc)
    assert bd.span_bytes(_FakeTable(rows), start, end) == 100 + 7 + 3
