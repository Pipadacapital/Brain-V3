# SPEC: A.2.4 (WA-19)
"""
gold_journey_events_reversion_unmerge_test.py — the UNMERGE un-reversion pass of the journey ledger.

Two layers, both Spark-free (pure helpers + static source guards — same style as
a12_identify_consent_denied_test.py / gate_admission_guard_test.py):
  1. derive_unmerge_pairs — the pure (brand, survivor→FROM, absorbed→TO) transfer-pair derivation from
     silver_identity_unmerge rows (skip no-survivor / self-pair; de-dup; order-stable).
  2. static guards that gold_journey_events_reversion.py actually WIRES the un-reversion pass: build()
     calls both passes, _apply_unmerge reads silver_identity_unmerge via the sanctioned helpers, uses a
     SEPARATE watermark, and its AFFECTED join keys on the IMMEDIATELY-PRIOR version's ownership
     (prev.data_version = je.data_version - 1 AND prev.brain_id = m.new_brain_id) — the exact inverse of
     the merge transfer, crash-safe (latest-version-ownership keyed, no is_current filter).

Run:  python3 -m pytest db/iceberg/spark/gold/gold_journey_events_reversion_unmerge_test.py -q
  or: python3 db/iceberg/spark/gold/gold_journey_events_reversion_unmerge_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import the PySpark-FREE helper module directly (the job imports pyspark at module top, so we never
# import the job itself in a Spark-less test — the same posture as a12 importing _silver_technical).
from _journey_reversion_pure import derive_unmerge_pairs  # noqa: E402

JOB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold_journey_events_reversion.py")


def _row(brand, survivor, absorbed):
    return {"brand_id": brand, "survivor_brain_id": survivor, "absorbed_brain_id": absorbed}


# ── 1. pure derive_unmerge_pairs ─────────────────────────────────────────────────────────────────

def test_a24_derive_basic_survivor_from_absorbed_to():
    # old_brain_id = survivor (current owner, FROM); new_brain_id = absorbed (restored, TO).
    pairs = derive_unmerge_pairs([_row("brandX", "survivor-1", "absorbed-1")])
    assert pairs == [("brandX", "survivor-1", "absorbed-1")]


def test_a24_derive_skips_null_survivor():
    # A legacy/incomplete UnmergeEvent with no survivor cannot address a transfer → skipped.
    assert derive_unmerge_pairs([_row("b", None, "absorbed-1")]) == []


def test_a24_derive_skips_self_pair():
    assert derive_unmerge_pairs([_row("b", "same", "same")]) == []


def test_a24_derive_skips_null_brand_or_absorbed():
    assert derive_unmerge_pairs([_row(None, "s", "a")]) == []
    assert derive_unmerge_pairs([{"brand_id": "b", "survivor_brain_id": "s"}]) == []


def test_a24_derive_dedups_and_is_order_stable():
    rows = [
        _row("b", "s1", "a1"),
        _row("b", "s1", "a1"),  # dup
        _row("b", "s2", "a2"),
    ]
    assert derive_unmerge_pairs(rows) == [("b", "s1", "a1"), ("b", "s2", "a2")]


def test_a24_derive_is_tenant_scoped_same_ids_different_brand_are_distinct():
    rows = [_row("b1", "s", "a"), _row("b2", "s", "a")]
    assert derive_unmerge_pairs(rows) == [("b1", "s", "a"), ("b2", "s", "a")]


# ── 2. static guards — the job WIRES the un-reversion pass ────────────────────────────────────────

def _src():
    with open(JOB_FILE, "r", encoding="utf-8") as f:
        return f.read()


def test_a24_build_runs_both_merge_and_unmerge_passes():
    src = _src()
    assert "_apply_merge(spark, fqtn)" in src, "build() must run the merge pass"
    assert "_apply_unmerge(spark, fqtn)" in src, "build() must run the unmerge un-reversion pass"


def test_a24_unmerge_pass_reads_the_unmerge_ledger_via_sanctioned_helpers():
    src = _src()
    assert 'UNMERGE_SOURCE_TABLE = "silver_identity_unmerge"' in src
    assert "silver_exists(spark, UNMERGE_SOURCE_TABLE)" in src, "must no-op when the ledger is absent"
    assert "spark.table(silver(UNMERGE_SOURCE_TABLE))" in src, "must read via the silver() helper"


def test_a24_unmerge_pass_uses_a_separate_watermark():
    src = _src()
    assert 'UNMERGE_JOB_NAME = "gold_journey_events_reversion_unmerge"' in src
    assert "read_job_watermark(spark, UNMERGE_JOB_NAME)" in src
    assert "write_job_watermark(spark, UNMERGE_JOB_NAME, new_wm)" in src


def test_a24_unmerge_affected_keys_on_prior_version_ownership():
    src = _src()
    # The inverse-of-merge detection: current row owned by survivor whose IMMEDIATELY-PRIOR version was
    # owned by the absorbed id — exactly the rows the merge transferred. Crash-safe (latest-version keyed).
    assert "prev.data_version = je.data_version - 1" in src
    assert "prev.brain_id = m.new_brain_id" in src


def test_a24_unmerge_uses_the_pure_derivation_helper():
    src = _src()
    assert "from _journey_reversion_pure import derive_unmerge_pairs" in src
    assert "derive_unmerge_pairs(" in src, "the pass must derive pairs through the unit-tested helper"


def test_a24_unmerge_reuses_the_versioned_copy_machinery():
    src = _src()
    # Un-reversion must go through the SAME flip-then-copy (data_version + 1, is_current flip) as merge —
    # additive, event-sourced, never a destructive edit.
    assert "_flip_and_copy(spark, fqtn)" in src
    assert "data_version + 1" in src  # the version bump in _copies_sql


if __name__ == "__main__":
    import subprocess

    raise SystemExit(subprocess.call([sys.executable, "-m", "pytest", os.path.abspath(__file__), "-q"]))
