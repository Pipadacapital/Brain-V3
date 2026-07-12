# AUD-IMPL-015 — probabilistic-stitch MERGE-key regression guard.
"""
probabilistic_merge_key_guard_test.py — locks the AUD-IMPL-015 fix: the logical key of
brain_silver.silver_probabilistic_stitch is ONE best match per (brand_id, session_id,
model_version). The pre-fix MERGE key additionally included probabilistic_brain_id, so a
later run whose best match was a DIFFERENT customer INSERTed a second row instead of
replacing the first — a flag-ON brand's estimated view could show one session linked to
two customers. This guard asserts, statically (no Spark needed, CI-safe):

  K1  the MERGE ON clause matches on brand_id + session_id + model_version and does NOT
      match on probabilistic_brain_id (matching on it re-opens the accumulation bug);
  K2  WHEN MATCHED THEN UPDATE is present (re-scored sessions refresh in place);
  K3  the stale-alternate DELETE (self-heal for a re-scored session whose best-match
      brain_id changed, and for pre-fix duplicates) runs against the target table.

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions), and is
picked up by tools/lint/spark-guard-suite.sh like every db/iceberg/spark/**/*_test.py:
  python3 db/iceberg/spark/silver/probabilistic_merge_key_guard_test.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

JOB_FILE = Path(__file__).resolve().parent / "silver_probabilistic_stitch.py"


def _merge_on_clause(src: str) -> str:
    """The ON … clause of the MERGE INTO statement (up to WHEN)."""
    m = re.search(r"MERGE INTO.*?\bON\b(.*?)\bWHEN\b", src, re.S)
    assert m, "MERGE INTO … ON … WHEN not found in silver_probabilistic_stitch.py"
    return m.group(1)


def test_merge_key_is_brand_session_model() -> None:
    """K1: MERGE key = (brand_id, session_id, model_version); NEVER probabilistic_brain_id."""
    src = JOB_FILE.read_text()
    on = _merge_on_clause(src)
    for col in ("brand_id", "session_id", "model_version"):
        assert re.search(rf"t\.{col}\s*=\s*s\.{col}", on), f"MERGE ON must match on {col}: {on!r}"
    assert "probabilistic_brain_id" not in on, (
        "AUD-IMPL-015 REGRESSION: MERGE ON matches probabilistic_brain_id — a later run's "
        "different best match would INSERT a second row per session instead of replacing."
    )


def test_matched_rows_update_in_place() -> None:
    """K2: re-scored sessions UPDATE the existing row (confidence/features/scored_at refresh)."""
    src = JOB_FILE.read_text()
    assert re.search(r"WHEN MATCHED THEN UPDATE", src), "MERGE must UPDATE matched rows in place"


def test_stale_alternate_delete_present() -> None:
    """K3: the pre-MERGE DELETE purges a re-scored session's row for a DIFFERENT brain_id."""
    src = JOB_FILE.read_text()
    m = re.search(r"DELETE FROM \{fqtn\}.*?probabilistic_brain_id\s*<>\s*t\.probabilistic_brain_id", src, re.S)
    assert m, (
        "stale-alternate DELETE missing: re-scored sessions whose best match changed must "
        "drop the old row (also self-heals pre-fix duplicates)"
    )


if __name__ == "__main__":
    failures = 0
    for fn in (test_merge_key_is_brand_session_model, test_matched_rows_update_in_place,
               test_stale_alternate_delete_present):
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as exc:
            print(f"FAIL {fn.__name__}: {exc}", file=sys.stderr)
            failures += 1
    sys.exit(1 if failures else 0)
