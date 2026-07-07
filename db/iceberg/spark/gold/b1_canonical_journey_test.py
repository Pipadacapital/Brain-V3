# SPEC: B.1 — Canonical Journey Generation (Wave B).
"""
b1_canonical_journey_test.py — pure (no Spark) CI guard for WB-B1: the ADDITIVE journey.engine
extension of the versioned event-sourced journey ledger brain_gold.journey_events. Mirrors the
journey_events_guard_test.py static-AST style (the jobs are parsed, never imported → no pyspark).

WHAT THIS GUARD ASSERTS (all static):
  1. ADDITIVE COLUMNS — gold_journey_events._COLUMNS carries `matched_via array<string>` and
     `identity_basis string`, BOTH nullable (additive, §0.5 — never a NOT NULL add on a live table),
     and the MERGE PK is UNCHANGED [brand_id, touchpoint_id, data_version] (AMD-11 R1 — no PK rewrite).
  2. FLAG GATE — the construction job reads the PER-BRAND `journey.engine` flag (is_flag_enabled +
     FLAG_JOURNEY_ENGINE) driver-side; the identity-resolution input is switched behind it (fob join),
     defaulting to the legacy silver_touchpoint.stitched_brain_id (byte-identical pre-wave).
  3. IDENTITY-INPUT SWITCH (AMD-13 R1) — flag ON resolves brain_id from silver_session_identity (the
     Wave-A v2 stitch), joined on the session key concat(brain_anon_id,':',session_id_raw); matched_via
     ON = the stitch's matched_via[], OFF = derived from the map's identifier_type set.
  4. TIE-BREAK — sequence_number (journey_seq) tie-break is flag-switched: ON adds session_id before
     touch_seq (spec (session_id, event_seq)); OFF keeps (occurred_at, touch_seq) unreordered.
  5. DETERMINISTIC-ONLY (§1.4) — identity_basis is the constant 'deterministic' on every canonical row.
  6. RE-VERSION CARRY — the reversion companion carries matched_via + identity_basis VERBATIM so a merge
     re-version never drops the provenance (and the MERGE column arity matches the widened table).
  7. SERVING VIEW — mv_journey_events_current projects both new columns for the B.3 journey APIs.

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions).
Run: python3 db/iceberg/spark/gold/b1_canonical_journey_test.py
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
GOLD_DIR = _THIS.parent
PROJECT_ROOT = GOLD_DIR.parents[3]
CONSTRUCTION_FILE = GOLD_DIR / "gold_journey_events.py"
REVERSION_FILE = GOLD_DIR / "gold_journey_events_reversion.py"
VIEW_FILE = PROJECT_ROOT / "db" / "trino" / "views" / "mv_journey_events_current.sql"
FLAGS_FILE = GOLD_DIR.parent / "_platform_flags.py"


def _extract_str_assign(path: Path, name: str) -> str:
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id == name:
                    v = node.value
                    while isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute):
                        v = v.func.value
                    if isinstance(v, ast.Constant) and isinstance(v.value, str):
                        return v.value
    raise AssertionError(f"could not find a string assignment `{name}` in {path}")


def _parse_columns(columns_sql: str) -> list:
    out = []
    for raw in columns_sql.splitlines():
        line = raw.strip().rstrip(",").strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        name, rest = parts[0], parts[1]
        col_type = rest.upper().replace("NOT NULL", "").strip().rstrip(",").strip()
        if name and col_type:
            out.append((name, col_type))
    return out


def _raw_lines(columns_sql: str) -> dict:
    out = {}
    for raw in columns_sql.splitlines():
        line = raw.strip().rstrip(",").strip()
        if line:
            out[line.split(None, 1)[0]] = line.upper()
    return out


# ── The checks ──────────────────────────────────────────────────────────────────────────────────────
def check_additive_columns_and_pk():
    cols_sql = _extract_str_assign(CONSTRUCTION_FILE, "_COLUMNS")
    types = dict(_parse_columns(cols_sql))
    raw = _raw_lines(cols_sql)

    assert types.get("matched_via") == "ARRAY<STRING>", (
        f"_COLUMNS must carry matched_via array<string> (B.1), got {types.get('matched_via')}"
    )
    assert types.get("identity_basis") == "STRING", (
        f"_COLUMNS must carry identity_basis string (B.1), got {types.get('identity_basis')}"
    )
    # additive/nullable — never a NOT NULL add on a live/populated table (§0.5)
    for c in ("matched_via", "identity_basis"):
        assert "NOT NULL" not in raw[c], f"additive column '{c}' must stay nullable (§0.5)"

    # AMD-11 R1: the MERGE PK is UNCHANGED — no per-journey journey_version PK rewrite.
    pk = _extract_pk_list()
    assert pk == ["brand_id", "touchpoint_id", "data_version"], (
        f"PK must stay [brand_id, touchpoint_id, data_version] (AMD-11 R1), got {pk}"
    )


def _extract_pk_list() -> list:
    tree = ast.parse(CONSTRUCTION_FILE.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id == "PK":
                    if isinstance(node.value, ast.List):
                        return [e.value for e in node.value.elts if isinstance(e, ast.Constant)]
    raise AssertionError("could not find the PK list in gold_journey_events.py")


def check_flag_gate_and_input_switch():
    text = CONSTRUCTION_FILE.read_text()
    flat = re.sub(r"\s+", " ", text).lower()

    # (a) per-brand journey.engine flag, driver-side, fail-closed default OFF
    assert "flag_journey_engine" in flat and "is_flag_enabled" in flat, (
        "construction must gate on the per-brand journey.engine flag (is_flag_enabled + FLAG_JOURNEY_ENGINE)"
    )
    assert "from _platform_flags import" in text, "must import the platform-flags Python twin"

    # (b) AMD-13 R1 identity-input switch: flag ON → silver_session_identity.brain_id, OFF → legacy
    assert "silver_session_identity" in flat, (
        "flag-ON path must read the Wave-A v2 stitch silver_session_identity (AMD-13 R1)"
    )
    assert "ssi.v2_brain_id else tp.stitched_brain_id" in flat, (
        "brain_id resolution must switch ssi.v2_brain_id (ON) vs tp.stitched_brain_id (OFF)"
    )
    # anonymous_ placeholder still terminates the coalesce (unstitched → journey-eligible post re-stitch)
    assert "concat('anonymous_', tp.brain_anon_id)" in flat, (
        "unstitched rows must still fall to the anonymous_ placeholder"
    )
    # (c) session key = concat(brain_anon_id, ':', session_id_raw) — the join back to the stitch table
    assert "concat_ws(':', tp.brain_anon_id, tp.session_id_raw)" in flat, (
        "flag-ON join must key on the session id concat(brain_anon_id,':',session_id_raw)"
    )


def check_tiebreak_and_basis():
    flat = re.sub(r"\s+", " ", CONSTRUCTION_FILE.read_text()).lower()

    # (a) sequence_number tie-break switches with the flag: ON injects session_id before touch_seq.
    assert re.search(
        r"order by e\.occurred_at asc,\s*case when e\.journey_engine_on then e\.session_id end asc,\s*e\.touch_seq asc",
        flat,
    ), (
        "sequence_number ORDER BY must be (occurred_at, CASE journey_engine_on→session_id, touch_seq) — "
        "spec (session_id, event_seq) tie-break ON; unreordered legacy OFF"
    )

    # (b) matched_via: ON = stitch matched_via[], OFF = derived identifier_type set; empty (not NULL).
    assert "e.v2_matched_via" in flat and "c.matched_via_derived" in flat, (
        "matched_via must be the stitch matched_via[] (ON) or the map identifier_type set (OFF)"
    )

    # (c) §1.4 — identity_basis is the constant 'deterministic' (canonical ledger is deterministic-only).
    assert re.search(r"'deterministic' as string\) as identity_basis", flat) or \
           "'deterministic' as identity_basis" in flat, (
        "identity_basis must be the constant 'deterministic' (§1.4 deterministic-only canonical ledger)"
    )


def check_reversion_carries_new_columns():
    rev = re.sub(r"\s+", " ", REVERSION_FILE.read_text()).lower()
    for c in ("a.matched_via", "a.identity_basis"):
        assert c in rev, (
            f"reversion copies must carry {c} VERBATIM (a merge moves ownership, never provenance; "
            "and the widened table needs matching MERGE column arity)"
        )


def check_serving_view_projection():
    view_sql = VIEW_FILE.read_text()
    for c in ("matched_via", "identity_basis"):
        assert re.search(rf"^\s*{c}\s*$|^\s*{c}\s*,", view_sql, re.MULTILINE), (
            f"serving view mv_journey_events_current must project the B.1 column '{c}'"
        )


def check_flag_registered():
    flags = FLAGS_FILE.read_text()
    assert 'FLAG_JOURNEY_ENGINE = "journey.engine"' in flags, (
        "the Python flag twin must register FLAG_JOURNEY_ENGINE = 'journey.engine'"
    )


_CHECKS = [
    ("additive_columns_and_pk", check_additive_columns_and_pk),
    ("flag_gate_and_input_switch", check_flag_gate_and_input_switch),
    ("tiebreak_and_basis", check_tiebreak_and_basis),
    ("reversion_carries_new_columns", check_reversion_carries_new_columns),
    ("serving_view_projection", check_serving_view_projection),
    ("flag_registered", check_flag_registered),
]


def test_additive_columns_and_pk():
    check_additive_columns_and_pk()


def test_flag_gate_and_input_switch():
    check_flag_gate_and_input_switch()


def test_tiebreak_and_basis():
    check_tiebreak_and_basis()


def test_reversion_carries_new_columns():
    check_reversion_carries_new_columns()


def test_serving_view_projection():
    check_serving_view_projection()


def test_flag_registered():
    check_flag_registered()


def main() -> int:
    failures = []
    for name, fn in _CHECKS:
        try:
            fn()
            print(f"[b1-canonical-journey] PASS  {name}")
        except AssertionError as exc:
            failures.append(name)
            print(f"[b1-canonical-journey] FAIL  {name}\n{exc}\n")
    if failures:
        print(f"[b1-canonical-journey] FAILED ({len(failures)}): {', '.join(failures)}")
        return 1
    print("[b1-canonical-journey] OK — B.1 additive journey.engine extension intact.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
