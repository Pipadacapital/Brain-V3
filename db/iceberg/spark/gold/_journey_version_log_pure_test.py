# SPEC: B.2 (WB-B2, AMD-11)
"""
_journey_version_log_pure_test.py — pure-python tests for the journey_version_log VERSION-BUMP helper.

Locks the journey-level version bump to AMD-11 R1 (a re-version pass rebuilds a journey as EXACTLY N+1)
and the TypeScript twin (apps/stream-worker/src/domain/journey/JourneyReversionDirty.ts). No pyspark / no
Spark runtime needed.

Run: `python3 db/iceberg/spark/gold/_journey_version_log_pure_test.py` (no pytest needed).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _journey_version_log_pure import (  # noqa: E402
    next_journey_version,
    version_log_rows,
)

BRAND_A = "aaaa1111-0000-4000-8000-aaaaaaaaaaaa"
BRAIN_CANON = "cccc3333-0000-4000-8000-cccccccccccc"
BRAIN_MERGED = "dddd4444-0000-4000-8000-dddddddddddd"


def test_next_version_bumps_by_one():
    assert next_journey_version(0) == 1
    assert next_journey_version(6) == 7


def test_next_version_rejects_negative_and_bool():
    for bad in (-1, True, 1.5, "3", None):
        try:
            next_journey_version(bad)
        except ValueError:
            continue
        raise AssertionError("next_journey_version accepted invalid input {0!r}".format(bad))


def test_version_log_rows_merge_bumps_from_N_to_N_plus_1():
    # A merge that transferred the absorbed brain's rows: its journey-level max data_version was 6.
    rows = version_log_rows(
        [{"brand_id": BRAND_A, "brain_id": BRAIN_CANON, "from_version": 6}],
        cause="merge",
        at="2026-07-07T00:00:00Z",
    )
    assert rows == [
        {
            "brand_id": BRAND_A,
            "brain_id": BRAIN_CANON,
            "from_version": 6,
            "to_version": 7,     # the N -> N+1 bump (AMD-11)
            "cause": "merge",
            "at": "2026-07-07T00:00:00Z",
        }
    ]


def test_version_log_rows_carries_cause_and_is_order_stable():
    agg = [
        {"brand_id": BRAND_A, "brain_id": BRAIN_CANON, "from_version": 1},
        {"brand_id": BRAND_A, "brain_id": BRAIN_MERGED, "from_version": 3},
    ]
    rows = version_log_rows(agg, cause="unmerge", at="t")
    assert [r["brain_id"] for r in rows] == [BRAIN_CANON, BRAIN_MERGED]   # input order preserved
    assert all(r["cause"] == "unmerge" for r in rows)
    assert [r["to_version"] for r in rows] == [2, 4]


def test_version_log_rows_skips_incomplete_rows():
    agg = [
        {"brand_id": BRAND_A, "brain_id": None, "from_version": 1},   # missing brain
        {"brand_id": None, "brain_id": BRAIN_CANON, "from_version": 1},  # missing brand
        {"brand_id": BRAND_A, "brain_id": BRAIN_CANON},                # missing from_version
        {"brand_id": BRAND_A, "brain_id": BRAIN_MERGED, "from_version": 0},  # valid
    ]
    rows = version_log_rows(agg, cause="restitch", at="t")
    assert len(rows) == 1
    assert rows[0]["brain_id"] == BRAIN_MERGED and rows[0]["to_version"] == 1


def test_version_log_rows_rejects_unknown_cause():
    try:
        version_log_rows([], cause="bogus", at="t")
    except ValueError:
        return
    raise AssertionError("version_log_rows accepted an unknown cause")


def _main():
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("PASS  {0}".format(name))
            except Exception as exc:  # noqa: BLE001 — test harness
                failures += 1
                print("FAIL  {0}: {1}".format(name, exc))
    if failures:
        sys.exit(1)
    print("all _journey_version_log_pure tests passed")


if __name__ == "__main__":
    _main()
