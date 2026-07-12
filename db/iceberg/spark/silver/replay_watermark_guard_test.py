"""
replay_watermark_guard_test.py — pure (no Spark) CI guard for the Wave-2 replay/backfill fixes on the
Silver tier: AUD-IMPL-011 (staleness guard on the windowed merge_on_pk) and AUD-IMPL-014 (stitch v2
watermark on the INGEST axis, not event time) — gate_admission_guard_test.py style.

WHY THIS EXISTS
  AUD-IMPL-011: _silver_base.merge_on_pk carried an UNCONDITIONAL `WHEN MATCHED THEN UPDATE SET *`.
  Normal incremental runs are safe (windows ascend from the watermark), but a bounded HISTORICAL replay
  (targeted backfill, partial reprocess after a quarantine release) stages an ingested_at slice that can
  hold a version of a PK OLDER than the target's current row — and the unconditional update regressed
  the entity to stale data. The fix guards the windowed-mode UPDATE on the recency axis
  (order_by_desc[0]) — and MUST stay windowed-only: a full / ENTITY-incremental pass stages a
  FULL-history refold whose recency column may legitimately regress (RTBF erasure removed the newest
  event) and must overwrite unconditionally.
  AUD-IMPL-014: silver_session_identity's incremental universe filtered on `occurred_at` (EVENT time)
  and advanced its watermark to max(occurred_at) — so a late-arriving/backfilled touch
  (order.backfill.v1, delayed webhook) whose occurred_at predates the watermark was NEVER stitched
  (the restitch drain fires only on identity-map mutations, not late arrival) → backfilled history was
  systematically under-attributed. The fix moves both the filter and the watermark advance to
  `updated_at` (silver_touchpoint's fold/ingest axis) and re-folds any touched session over its FULL
  touch set (semi-join at the session grain, so session_start stays min over the whole session).

WHAT THIS GUARD ASSERTS
  1. BEHAVIORAL (the pure _staleness_guard helper is AST-extracted and exec'd — no pyspark import):
     no guard on a full pass; a NULL-safe `s.<c0> >= t.<c0>` guard in windowed mode, keyed on
     order_by_desc[0].
  2. WIRING — merge_on_pk interpolates the guard into the WHEN MATCHED branch and derives windowed-ness
     from _CURRENT_WINDOW (the run_job windowed-batch seam).
  3. STITCH AXIS — silver_session_identity._session_map filters on updated_at (never `occurred_at >=`
     against the watermark), semi-joins the FULL touch set of the selected sessions, and the watermark
     advance reads max(updated_at) (never max(occurred_at)).

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions).
Run: python3 db/iceberg/spark/silver/replay_watermark_guard_test.py
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
SILVER_DIR = _THIS.parent                                  # db/iceberg/spark/silver
BASE_FILE = SILVER_DIR / "_silver_base.py"
STITCH_FILE = SILVER_DIR / "silver_session_identity.py"


def _extract_function(path: Path, name: str):
    """AST-extract ONE top-level function from a Spark job module and exec it in isolation — the module
    itself imports pyspark, which CI does not have; the helper under test is pure Python."""
    tree = ast.parse(path.read_text())
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            mod = ast.Module(body=[node], type_ignores=[])
            ns: dict = {}
            exec(compile(mod, filename=str(path), mode="exec"), ns)  # noqa: S102 — own repo source
            return ns[name]
    raise AssertionError(f"{path.name}: function {name} not found")


def _function_source(path: Path, name: str) -> str:
    tree = ast.parse(path.read_text())
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return ast.get_source_segment(path.read_text(), node) or ""
    raise AssertionError(f"{path.name}: function {name} not found")


# ── 1. AUD-IMPL-011 behavioral: the pure staleness-guard helper ────────────────────────────────────
def check_staleness_guard_behavior():
    guard = _extract_function(BASE_FILE, "_staleness_guard")

    # Full / entity-incremental pass (not windowed) → NO guard: a full-history refold may legitimately
    # regress the recency column (erasure) and must overwrite unconditionally.
    assert guard(["ingested_at", "occurred_at"], False) == "", (
        "AUD-IMPL-011: the staleness guard must NOT apply on a full/entity-incremental pass "
        "(a full-history refold is authoritative even when its recency column regressed)"
    )

    # Windowed mode → NULL-safe same-or-newer guard on the FIRST order_by_desc column.
    g = guard(["ingested_at", "occurred_at"], True)
    assert "s.ingested_at >= t.ingested_at" in g, (
        f"AUD-IMPL-011: windowed guard must compare s.ingested_at >= t.ingested_at, got: {g!r}"
    )
    assert "t.ingested_at IS NULL" in g, f"AUD-IMPL-011: windowed guard must be NULL-safe, got: {g!r}"
    assert "occurred_at" not in g, (
        "AUD-IMPL-011: the guard keys on order_by_desc[0] ONLY (the recency axis), not the tiebreakers"
    )
    assert g.startswith(" AND "), "guard must extend the WHEN MATCHED condition (leading ' AND ')"

    # A different recency axis (fold-grain jobs order by updated_at / last_seen_at) follows the caller.
    g2 = guard(["updated_at"], True)
    assert "s.updated_at >= t.updated_at" in g2


# ── 2. AUD-IMPL-011 wiring: guard interpolated into the MERGE, driven by _CURRENT_WINDOW ───────────
def check_staleness_guard_wired():
    src = _function_source(BASE_FILE, "merge_on_pk")
    assert re.search(r"_staleness_guard\(\s*order_by_desc\s*,\s*windowed\s*=\s*_CURRENT_WINDOW is not None", src), (
        "AUD-IMPL-011: merge_on_pk must derive windowed-ness from _CURRENT_WINDOW (the run_job "
        "windowed-batch seam) — nothing else distinguishes a bounded slice from a full pass"
    )
    assert "WHEN MATCHED{guard} THEN UPDATE SET *" in src, (
        "AUD-IMPL-011: the guard must extend the WHEN MATCHED UPDATE branch of the MERGE"
    )
    assert "WHEN NOT MATCHED THEN INSERT *" in src, "merge_on_pk INSERT branch must be unchanged"


# ── 3. AUD-IMPL-014: stitch v2 incremental axis = updated_at (ingest), not occurred_at (event) ─────
def check_stitch_watermark_axis():
    src = _function_source(STITCH_FILE, "_session_map")
    assert 'F.col("updated_at") >=' in src, (
        "AUD-IMPL-014: _session_map must select sessions by the touchpoint fold axis updated_at — "
        "event-time (occurred_at) filtering skips late-arriving/backfilled touches forever"
    )
    assert 'F.col("occurred_at") >= (F.lit(wm)' not in src, (
        "AUD-IMPL-014 REGRESSION: _session_map filters the watermark on occurred_at (event time) again"
    )
    assert '"left_semi"' in src, (
        "AUD-IMPL-014: a touched session must be re-folded over its FULL touch set (semi-join at the "
        "session grain) so session_start = min(occurred_at) stays correct across the watermark boundary"
    )

    build_src = _function_source(STITCH_FILE, "build")
    assert "max(updated_at) AS m" in build_src, (
        "AUD-IMPL-014: the watermark advance must read max(updated_at) — the same axis _session_map "
        "filters on"
    )
    assert "max(occurred_at) AS m" not in build_src, (
        "AUD-IMPL-014 REGRESSION: the watermark advance reads max(occurred_at) (event time) again"
    )


# ── pytest bindings ─────────────────────────────────────────────────────────────────────────────────
def test_staleness_guard_behavior():
    check_staleness_guard_behavior()


def test_staleness_guard_wired():
    check_staleness_guard_wired()


def test_stitch_watermark_axis():
    check_stitch_watermark_axis()


if __name__ == "__main__":
    failed = False
    for fn in (check_staleness_guard_behavior, check_staleness_guard_wired, check_stitch_watermark_axis):
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as exc:
            failed = True
            print(f"FAIL {fn.__name__}: {exc}", file=sys.stderr)
    sys.exit(1 if failed else 0)
