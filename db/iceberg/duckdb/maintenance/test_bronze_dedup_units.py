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

from datetime import datetime, timezone  # noqa: E402

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


# ── D1 month-partition scoping (ADR-0018) ────────────────────────────────────────────────────────


def test_month_scoped_sql_carries_month_predicate_in_count_and_losers():
    # The month predicate must ride BOTH the recheck (dup_count_sql) and the delete plan (losers_sql),
    # AND-ed onto the shared candidacy guard — or a committed month's checkpoint could disagree with
    # what the recheck counts.
    month_pred = "kafka_timestamp >= TIMESTAMPTZ '2026-07-01T00:00:00+00:00' AND kafka_timestamp < TIMESTAMPTZ '2026-08-01T00:00:00+00:00'"
    cnt = bd.dup_count_sql("t", month_pred)
    los = bd.losers_sql("t", month_pred)
    assert month_pred in cnt and month_pred in los
    # Candidacy guard is still present (the month predicate is ADDED, not a replacement).
    assert bd.CANDIDATE_GUARD in cnt and bd.CANDIDATE_GUARD in los


def test_unscoped_sql_is_byte_identical_to_no_month_predicate():
    # PARTITION_SCOPED=0 (month_pred=None) path must produce EXACTLY the pre-D1 whole-table SQL.
    assert bd.dup_count_sql("t", None) == bd.dup_count_sql("t")
    assert bd.losers_sql("t", None) == bd.losers_sql("t")
    # And no TIMESTAMPTZ range leaks in on the whole-table path.
    assert "TIMESTAMPTZ" not in bd.dup_count_sql("t")
    assert "TIMESTAMPTZ" not in bd.losers_sql("t")


def test_month_start_from_epoch_int_and_date_object():
    # inspect.files() renders a month() partition value as an int (months since 1970-01) OR a date obj.
    assert bd._month_start(678) == datetime(2026, 7, 1, tzinfo=timezone.utc)   # 1970 + 56y6m = 2026-07

    class _D:
        year, month = 2026, 3

    assert bd._month_start(_D()) == datetime(2026, 3, 1, tzinfo=timezone.utc)


def test_month_end_rolls_year_boundary():
    assert bd._month_end(datetime(2026, 7, 1, tzinfo=timezone.utc)) == datetime(2026, 8, 1, tzinfo=timezone.utc)
    assert bd._month_end(datetime(2026, 12, 1, tzinfo=timezone.utc)) == datetime(2027, 1, 1, tzinfo=timezone.utc)


def _month_file(months_since_epoch, pf_name="kafka_timestamp_month", content=0):
    return {"content": content, "file_size_in_bytes": 1, "partition": {pf_name: months_since_epoch}}


def test_month_partitions_distinct_ascending_data_files_only():
    # 678 = 2026-07, 677 = 2026-06; a delete-content file and a duplicate month are ignored.
    rows = [
        _month_file(678),
        _month_file(677),
        _month_file(678),                 # duplicate month → deduped
        _month_file(678, content=1),      # delete-content → skipped
    ]
    months = bd.month_partitions(_FakeTable(rows))
    assert months == [datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)]


def test_newest_months_takes_tail_ascending():
    rows = [_month_file(676), _month_file(677), _month_file(678)]  # May, Jun, Jul 2026
    # MONTHS_BACK=1 → just the newest (Jul); the checkpoint still marches oldest→newest so a >1
    # window leaves earlier months durable on a kill.
    assert bd.newest_months(_FakeTable(rows), 1) == [datetime(2026, 7, 1, tzinfo=timezone.utc)]
    assert bd.newest_months(_FakeTable(rows), 2) == [
        datetime(2026, 6, 1, tzinfo=timezone.utc),
        datetime(2026, 7, 1, tzinfo=timezone.utc),
    ]


def test_newest_months_empty_when_unpartitioned():
    # A table whose files carry no month partition value (unpartitioned / bucket) → [] → caller falls
    # back to the whole-table scope (no crash, no silent no-op).
    rows = [{"content": 0, "file_size_in_bytes": 1, "partition": {}}]
    assert bd.month_partitions(_FakeTable(rows)) == []
    assert bd.newest_months(_FakeTable(rows), 1) == []


def test_month_pred_and_range_expr_share_half_open_bounds():
    start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    end = datetime(2026, 8, 1, tzinfo=timezone.utc)
    pred = bd.month_pred_sql("kafka_timestamp", start, end)
    assert ">= TIMESTAMPTZ '2026-07-01T00:00:00+00:00'" in pred
    assert "< TIMESTAMPTZ '2026-08-01T00:00:00+00:00'" in pred
    from pyiceberg.expressions import And, GreaterThanOrEqual, LessThan

    expr = bd.month_range_expr("kafka_timestamp", start, end)
    assert isinstance(expr, And)
    assert isinstance(expr.left, GreaterThanOrEqual) and isinstance(expr.right, LessThan)


def test_delete_expr_wraps_month_range_when_supplied():
    from pyiceberg.expressions import And, EqualTo, In

    start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    end = datetime(2026, 8, 1, tzinfo=timezone.utc)
    month_expr = bd.month_range_expr("kafka_timestamp", start, end)
    scoped = bd.delete_expr(2, [10, 11], month_expr)
    # And(monthRange, And(EqualTo(partition), In(offsets))) — the month range bounds the COW rewrite.
    assert isinstance(scoped, And)
    assert scoped.left is month_expr
    assert isinstance(scoped.right, And)
    assert isinstance(scoped.right.left, EqualTo) and isinstance(scoped.right.right, In)
    # Unscoped (month_expr=None) is byte-identical to the pre-D1 coordinate-only expression.
    plain = bd.delete_expr(2, [10, 11])
    assert isinstance(plain, And) and isinstance(plain.left, EqualTo) and isinstance(plain.right, In)


def test_dedup_scope_checkpoints_each_month_before_next(monkeypatch):
    """The core D1 guarantee: dedup_scope RECHECKS-AND-COMMITS one scope; the main() loop over months
    calls it oldest→newest so a raised failure in a LATER month leaves the EARLIER month's committed
    deletes in place (the checkpoint). Simulate: month K raises; assert month <K's deletes ran and
    were rechecked, and the failure propagates (so the run is loud + a re-run resumes)."""
    calls = {"deletes": [], "rechecks": []}

    # A fake DuckDB connection: dup_count returns >0 first (there ARE dupes), 0 on the recheck; the
    # loser plan returns one coordinate. Keyed off the SQL text to tell count vs losers apart.
    class _FakeCon:
        def __init__(self):
            self._recheck_of = {}

        def execute(self, sql):
            self._last = sql
            return self

        def fetchone(self):
            if "row_number()" in self._last:
                return None  # not used for fetchone
            # dup_count_sql: first call per month → 5 dupes; a recheck (after deletes) → 0.
            month = _month_of(self._last)
            self._recheck_of[month] = self._recheck_of.get(month, 0) + 1
            if self._recheck_of[month] == 1:
                return (5,)
            calls["rechecks"].append(month)
            return (0,)

        def fetchall(self):
            return [(0, 100)]  # one loser coordinate

    def _month_of(sql):
        # The month predicate is `col >= TIMESTAMPTZ '<start>' AND col < TIMESTAMPTZ '<end>'` — key on
        # the START (>=) literal, since June's END bound is the July start (ambiguous by substring).
        start = sql.split(">=", 1)[1].split("AND", 1)[0] if ">=" in sql else ""
        if "2026-07-01" in start:
            return "2026-07"
        if "2026-06-01" in start:
            return "2026-06"
        return "whole"

    def fake_delete(cat, ns, tbl, expr):
        # record which month this delete belongs to via its START bound (GreaterThanOrEqual). Keying
        # on a bare substring is ambiguous — June's [2026-06-01, 2026-07-01) range CONTAINS the July
        # start literal in its END bound — so match the >= bound only.
        s = str(expr)
        calls["deletes"].append(s)
        # month K (July, the NEWEST → processed LAST) OOMs mid-delete. Its START bound is 2026-07-01.
        if "GreaterThanOrEqual" in s and "2026-07-01" in s.split("LessThan")[0]:
            raise SystemExit("[bronze-dedup] simulated OOM in July")

    monkeypatch.setattr(bd.mb, "delete", fake_delete)
    monkeypatch.setattr(bd, "loser_file_bytes", lambda tbl, coords: 1)

    con = _FakeCon()
    # June scope commits cleanly; July raises inside dedup_scope.
    bd.dedup_scope(None, con, None, "t", "2026-06",
                   bd.month_pred_sql("kafka_timestamp", datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)),
                   bd.month_range_expr("kafka_timestamp", datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)))
    assert "2026-06" in calls["rechecks"]  # June was rechecked-and-committed (the checkpoint)

    import pytest

    with pytest.raises(SystemExit):
        bd.dedup_scope(None, con, None, "t", "2026-07",
                       bd.month_pred_sql("kafka_timestamp", datetime(2026, 7, 1, tzinfo=timezone.utc), datetime(2026, 8, 1, tzinfo=timezone.utc)),
                       bd.month_range_expr("kafka_timestamp", datetime(2026, 7, 1, tzinfo=timezone.utc), datetime(2026, 8, 1, tzinfo=timezone.utc)))
    # July's delete was attempted (and raised); June stayed committed (never re-touched by the failure).
    def _starts_july(d):
        return "GreaterThanOrEqual" in d and "2026-07-01" in d.split("LessThan")[0]

    assert any(_starts_july(d) for d in calls["deletes"])
    assert "2026-07" not in calls["rechecks"]  # July never reached its recheck (durable-partial)
