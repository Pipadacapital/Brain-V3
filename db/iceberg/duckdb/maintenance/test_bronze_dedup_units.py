"""
test_bronze_dedup_units.py — pure-logic tests for the Bronze compaction-dedup job (no catalog).

Same posture as test_maintenance_units.py: the stack-dependent behaviours (COW delete, commit
retry) are gated by maintenance_capability_probe.py against the real REST catalog; these tests pin
the in-process logic — the duplicate-detection / loser-selection SQL shapes (NULL-key +
NULL-coordinate guard, keep-latest ordering, JSON key lift), the partition/In-list delete batching
and predicate shape, and the loser-file-bytes valve accounting (2026-07-18 targeted-delete rework:
whole-day COW overwrite → coordinate-targeted COW deletes).

Run: pytest db/iceberg/duckdb/maintenance/test_bronze_dedup_units.py
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # parent dir: _catalog.py (the DuckDB attach seam)

import bronze_dedup as bd  # noqa: E402


# ── SQL shapes (the correctness-bearing clauses must be present verbatim) ────────────────────────


def test_dup_count_sql_lifts_key_from_payload_and_excludes_nulls():
    sql = bd.dup_count_sql("rest.brain_bronze.collector_events_connect")
    # The key is LIFTED from the verbatim envelope payload — same paths the Silver keystone lifts.
    assert "json_extract_string(payload, '$.brand_id')" in sql
    assert "json_extract_string(payload, '$.event_id')" in sql
    # NULL-keyed / NULL-timestamp / NULL-coordinate rows are never dedup candidates.
    assert "IS NOT NULL" in sql
    assert "kafka_timestamp IS NOT NULL" in sql
    assert "kafka_partition IS NOT NULL AND kafka_offset IS NOT NULL" in sql
    assert "HAVING count(*) > 1" in sql


def test_losers_sql_keep_latest_ordering_and_null_guard():
    sql = bd.losers_sql("rest.brain_bronze.collector_events_connect")
    # Keep-latest tie-break UNCHANGED: highest (kafka_timestamp, kafka_offset, kafka_partition)
    # copy wins; everything numbered past it is a loser.
    assert "ORDER BY kafka_timestamp DESC, kafka_offset DESC, kafka_partition DESC" in sql
    # Losers are the NON-winning copies of keys with >1 candidate copy.
    assert "copies > 1 AND rn > 1" in sql
    # Only candidate rows participate — NULL-keyed/-coordinate rows can never be selected/deleted.
    assert bd.CANDIDATE_GUARD in sql
    # The plan yields physical delete coordinates, nothing else.
    assert "SELECT kafka_partition, kafka_offset FROM" in sql


def test_candidate_guard_shared_between_count_and_losers():
    # The recheck (dup_count_sql) and the delete plan (losers_sql) MUST agree on candidacy, or a
    # row could count as a dupe yet be untargetable (post-delete recheck would then always fail).
    assert bd.CANDIDATE_GUARD in bd.dup_count_sql("t")
    assert bd.CANDIDATE_GUARD in bd.losers_sql("t")


# ── Delete batching (partition-grouped offset In-lists — never per-pair OR-chains) ───────────────


def test_batch_losers_groups_by_partition_and_chunks_offsets():
    coords = [(1, 30), (0, 10), (1, 20), (0, 5), (0, 7), (2, 100)]
    batches = bd.batch_losers(coords, batch_size=2)
    assert batches == [
        (0, [5, 7]),
        (0, [10]),
        (1, [20, 30]),
        (2, [100]),
    ]


def test_batch_losers_is_deterministic_and_complete():
    coords = [(3, 9), (3, 1), (3, 5)]
    a = bd.batch_losers(coords, batch_size=10)
    b = bd.batch_losers(list(reversed(coords)), batch_size=10)
    assert a == b == [(3, [1, 5, 9])]
    # Every coordinate appears in exactly one batch.
    flattened = [(p, o) for p, offs in a for o in offs]
    assert sorted(flattened) == sorted(coords)


def test_delete_expr_shape_partition_eq_and_offset_in():
    expr = bd.delete_expr(2, [10, 11])
    s = str(expr)
    assert "kafka_partition" in s and "kafka_offset" in s
    # And(EqualTo(partition), In(offsets)) — the batched shape, not an OR-chain of pairs.
    from pyiceberg.expressions import And, EqualTo, In

    assert isinstance(expr, And)
    assert isinstance(expr.left, EqualTo)
    assert isinstance(expr.right, In)


# ── Loser-file-bytes valve (affected files only, conservative without metrics) ───────────────────


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


def _file(size, part_bounds=None, off_bounds=None, content=0):
    metrics = {}
    if part_bounds is not None:
        metrics["kafka_partition"] = {"lower_bound": part_bounds[0], "upper_bound": part_bounds[1]}
    if off_bounds is not None:
        metrics["kafka_offset"] = {"lower_bound": off_bounds[0], "upper_bound": off_bounds[1]}
    return {"content": content, "file_size_in_bytes": size, "readable_metrics": metrics}


def test_loser_file_bytes_counts_only_files_whose_bounds_contain_a_loser():
    rows = [
        _file(100, part_bounds=(0, 0), off_bounds=(0, 50)),      # contains (0, 10) → counted
        _file(40, part_bounds=(0, 0), off_bounds=(100, 200)),    # offset range misses → skipped
        _file(7, part_bounds=(1, 1), off_bounds=(0, 50)),        # partition misses → skipped
        _file(999, part_bounds=(0, 0), off_bounds=(0, 50), content=1),  # delete-content → skipped
        _file(3),                                                # no metrics → conservative
    ]
    assert bd.loser_file_bytes(_FakeTable(rows), [(0, 10)]) == 100 + 3


def test_loser_file_bytes_multi_partition_coords():
    rows = [
        _file(10, part_bounds=(0, 0), off_bounds=(5, 6)),
        _file(20, part_bounds=(1, 1), off_bounds=(7, 9)),
        _file(40, part_bounds=(2, 2), off_bounds=(0, 1000)),
    ]
    # Losers in partitions 0 and 1 only — partition 2's file is never counted.
    assert bd.loser_file_bytes(_FakeTable(rows), [(0, 5), (1, 8)]) == 10 + 20


def test_loser_file_bytes_missing_one_bound_is_conservative():
    rows = [_file(55, part_bounds=(0, 0))]  # kafka_offset metrics absent
    assert bd.loser_file_bytes(_FakeTable(rows), [(9, 9)]) == 55
