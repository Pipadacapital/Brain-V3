"""
journey_events_guard_test.py — pure (no Spark) CI guard for the versioned event-sourced journey
ledger brain_gold.journey_events (spec gap G4 re-ratified) — gate_admission_guard_test.py style.

WHY THIS EXISTS
  journey_events is an EVENT-SOURCED ledger: identity merges must append data_version+1 copies and
  flip is_current — never rewrite history — and money must stay bigint MINOR units + a sibling
  currency_code. These invariants live in SQL strings inside the two Spark jobs, so nothing else in
  CI would catch a drive-by edit that, say, turned revenue_minor into a DOUBLE or dropped the
  is_current flip from the reversion MERGE.

WHAT THIS GUARD ASSERTS (all static — the jobs are AST-parsed, never imported, so no pyspark needed)
  1. COLUMN CONTRACT — gold_journey_events._COLUMNS: brand_id is the FIRST column; the versioning
     pair data_version (int NOT NULL) + is_current (boolean NOT NULL) is present; money is
     revenue_minor (bigint) with the sibling currency_code (string); NO float/double/decimal money
     column anywhere (identity_confidence double is a score, not money).
  2. REVERSION SEMANTICS — gold_journey_events_reversion.py contains the is_current=false flip
     (the ONLY permitted in-place mutation) and the data_version + 1 bump on the inserted copies.
  3. REGISTRY — _gold_registry has ONE enabled spec 'journey_events' (1-spec-per-TABLE; the
     reversion job is a companion on the same table) with the right pk / mv_name / money column,
     and the module + serving-view files exist on disk.

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions).
Run: python3 db/iceberg/spark/gold/journey_events_guard_test.py
"""
from __future__ import annotations

import ast
import os
import re
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
GOLD_DIR = _THIS.parent                                    # db/iceberg/spark/gold
PROJECT_ROOT = GOLD_DIR.parents[3]                         # gold -> spark -> iceberg -> db -> root
CONSTRUCTION_FILE = GOLD_DIR / "gold_journey_events.py"
REVERSION_FILE = GOLD_DIR / "gold_journey_events_reversion.py"
VIEW_FILE = PROJECT_ROOT / "db" / "trino" / "views" / "mv_journey_events_current.sql"

# Make _gold_registry importable (pure dataclasses — no Spark dependency).
sys.path.insert(0, str(GOLD_DIR))


# ── Static extraction helpers (AST — never import the Spark jobs) ─────────────────────────────────
def _extract_str_assign(path: Path, name: str) -> str:
    """Return the string literal assigned to `name` in `path` (handles the `\"\"\"…\"\"\".strip()` shape)."""
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id == name:
                    v = node.value
                    # unwrap `"...".strip("\n")` / method-call chains down to the string constant
                    while isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute):
                        v = v.func.value
                    if isinstance(v, ast.Constant) and isinstance(v.value, str):
                        return v.value
    raise AssertionError(f"could not find a string assignment `{name}` in {path}")


def _parse_columns(columns_sql: str) -> list:
    """[(name, type_upper)] — mirrors iceberg_base._parse_column_defs (one column per NEWLINE;
    trailing comma + NOT NULL stripped)."""
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
    """name → the raw (uppercased) column line, for NOT NULL presence checks."""
    out = {}
    for raw in columns_sql.splitlines():
        line = raw.strip().rstrip(",").strip()
        if line:
            out[line.split(None, 1)[0]] = line.upper()
    return out


# ── The checks ────────────────────────────────────────────────────────────────────────────────────
def check_columns_contract():
    cols_sql = _extract_str_assign(CONSTRUCTION_FILE, "_COLUMNS")
    cols = _parse_columns(cols_sql)
    names = [n for n, _ in cols]
    types = dict(cols)
    raw = _raw_lines(cols_sql)

    assert names, "no columns parsed from _COLUMNS"
    assert names[0] == "brand_id", f"brand_id must be the FIRST column (tenant key), got '{names[0]}'"

    # versioning pair (the event-sourced spine)
    assert "data_version" in types, "_COLUMNS must carry data_version"
    assert types["data_version"] == "INT", f"data_version must be int, got {types['data_version']}"
    assert "NOT NULL" in raw["data_version"], "data_version must be NOT NULL"
    assert "is_current" in types, "_COLUMNS must carry is_current"
    assert types["is_current"] == "BOOLEAN", f"is_current must be boolean, got {types['is_current']}"
    assert "NOT NULL" in raw["is_current"], "is_current must be NOT NULL"

    # money rule: bigint MINOR units + sibling currency_code — never a float/DECIMAL
    assert types.get("revenue_minor") == "BIGINT", (
        f"revenue_minor must be bigint minor units, got {types.get('revenue_minor')}"
    )
    assert types.get("currency_code") == "STRING", (
        f"currency_code sibling must be present as string, got {types.get('currency_code')}"
    )
    money_like = re.compile(r"(_minor$|revenue|amount|price|_value$)", re.IGNORECASE)
    for name, col_type in cols:
        if money_like.search(name):
            assert col_type == "BIGINT", (
                f"money-like column '{name}' must be bigint minor units (never float/decimal), got {col_type}"
            )
    banned = {"FLOAT", "DECIMAL"}
    for name, col_type in cols:
        base = col_type.split("(")[0].split("<")[0].strip()
        assert base not in banned, f"column '{name}' uses banned type {col_type} (money rule / no floats)"
    # double is allowed ONLY for the identity-confidence scores (probabilities, not money):
    # identity_confidence (current) + identity_confidence_asof (DG-2 point-in-time)
    doubles = set(n for n, t in cols if t == "DOUBLE")
    allowed_doubles = {"identity_confidence", "identity_confidence_asof"}
    assert doubles <= allowed_doubles, (
        f"only {sorted(allowed_doubles)} may be double (scores, not money) — found: {sorted(doubles)}"
    )


def check_reversion_semantics():
    text = REVERSION_FILE.read_text()
    flat = re.sub(r"\s+", " ", text).lower()
    # (a) the is_current flip — the ONLY in-place mutation the ledger permits
    assert re.search(r"update\s+set\s+t\.is_current\s*=\s*false", flat), (
        "reversion job must MERGE-UPDATE the superseded rows to is_current = false"
    )
    # (b) the version bump on the inserted copies
    assert re.search(r"data_version\s*\+\s*1", flat), (
        "reversion job must insert copies with data_version = old + 1"
    )
    # (c) copies are inserted as the new current version under the canonical owner
    assert re.search(r"true\s+as\s+is_current", flat), (
        "reversion copies must be staged with is_current = true"
    )
    assert re.search(r"new_brain_id\s+as\s+brain_id", flat), (
        "reversion copies must be re-keyed to the canonical (new) brain_id"
    )
    # (d) it checkpoints on the shared watermark side-table
    assert "read_job_watermark" in text and "write_job_watermark" in text, (
        "reversion job must checkpoint via the silver_job_watermark side-table helpers"
    )


def check_registry_and_artifacts():
    from _gold_registry import GOLD_MART_REGISTRY  # noqa: PLC0415 — path set up above

    spec = GOLD_MART_REGISTRY.get("journey_events")
    assert spec is not None, "registry must carry the 'journey_events' spec (1-spec-per-TABLE)"
    assert spec.enabled, "journey_events spec must be enabled"
    assert spec.pk == ["brand_id", "touchpoint_id", "data_version"], (
        f"journey_events pk must be [brand_id, touchpoint_id, data_version], got {spec.pk}"
    )
    assert spec.module == "gold_journey_events.py", f"unexpected module {spec.module}"
    assert spec.mv_name == "brain_serving.mv_journey_events_current", f"unexpected mv_name {spec.mv_name}"
    minors = [m.minor_col for m in spec.money_columns]
    assert minors == ["revenue_minor"], f"money_columns must be exactly [revenue_minor], got {minors}"
    assert all(m.currency_code_col == "currency_code" for m in spec.money_columns), (
        "revenue_minor must pair with the sibling currency_code"
    )
    # the reversion COMPANION carries no separate spec (same table) but its job file must exist
    assert CONSTRUCTION_FILE.is_file(), f"missing {CONSTRUCTION_FILE}"
    assert REVERSION_FILE.is_file(), f"missing companion job {REVERSION_FILE}"
    assert VIEW_FILE.is_file(), f"missing serving view {VIEW_FILE}"
    view_sql = VIEW_FILE.read_text()
    assert "iceberg.brain_serving.mv_journey_events_current" in view_sql, (
        "serving view must use the 3-part iceberg.brain_serving.* name (naming guard)"
    )
    assert "iceberg.brain_gold.journey_events" in view_sql, (
        "serving view must project the 3-part iceberg.brain_gold.journey_events table"
    )
    assert re.search(r"where\s+is_current\s*=\s*true", view_sql, re.IGNORECASE), (
        "serving view must filter WHERE is_current = true (current versions only)"
    )


def check_asof_identity():
    """DG-2 POINT-IN-TIME (AS-OF) identity resolution — additive columns + the canonical
    interval-covering predicate (the SAME AS-OF shape _snap_as_of/snap_identity_link prove):
      effective_from <= occurred_at AND (effective_to IS NULL OR occurred_at < effective_to)
    A drive-by edit that flips a bound to inclusive/exclusive the wrong way (>= / <=) would
    silently corrupt every historical resolution, so the predicate shape is pinned here."""
    # (a) both ADDITIVE columns are in the construction contract, with the right types
    cols_sql = _extract_str_assign(CONSTRUCTION_FILE, "_COLUMNS")
    types = dict(_parse_columns(cols_sql))
    raw = _raw_lines(cols_sql)
    assert types.get("brain_id_asof") == "STRING", (
        f"_COLUMNS must carry brain_id_asof string (DG-2), got {types.get('brain_id_asof')}"
    )
    assert types.get("identity_confidence_asof") == "DOUBLE", (
        f"_COLUMNS must carry identity_confidence_asof double (DG-2), got {types.get('identity_confidence_asof')}"
    )
    # additive/nullable: neither AS-OF column may be NOT NULL (old rows + anonymous ids stay NULL)
    for c in ("brain_id_asof", "identity_confidence_asof"):
        assert "NOT NULL" not in raw[c], f"AS-OF column '{c}' must stay nullable (additive DG-2 contract)"

    # (b) the interval-covering predicate shape in the construction SQL
    text = CONSTRUCTION_FILE.read_text()
    flat = re.sub(r"\s+", " ", text).lower()
    assert re.search(
        r"m\.effective_from\s*<=\s*e2\.occurred_at\s+and\s+"
        r"\(\s*m\.effective_to\s+is\s+null\s+or\s+e2\.occurred_at\s*<\s*m\.effective_to\s*\)",
        flat,
    ), (
        "construction must AS-OF join with the canonical interval predicate: "
        "effective_from <= occurred_at AND (effective_to IS NULL OR occurred_at < effective_to)"
    )
    # deterministic tiebreak across multiple covering identifier types
    assert re.search(r"max\(m\.confidence\)\s+as\s+identity_confidence_asof", flat), (
        "identity_confidence_asof must be max(confidence) across covering rows (deterministic tiebreak)"
    )

    # (c) the serving view projects both AS-OF columns
    view_sql = VIEW_FILE.read_text()
    for c in ("brain_id_asof", "identity_confidence_asof"):
        assert re.search(rf"^\s*{c}\s*,", view_sql, re.MULTILINE), (
            f"serving view mv_journey_events_current must project the DG-2 column '{c}'"
        )

    # (d) the reversion copies carry the AS-OF pair verbatim (its INSERT column list is explicit)
    rev = re.sub(r"\s+", " ", REVERSION_FILE.read_text()).lower()
    for c in ("a.brain_id_asof", "a.identity_confidence_asof"):
        assert c in rev, f"reversion copies must carry {c} (explicit column list — verbatim on merge)"


_CHECKS = [
    ("columns_contract", check_columns_contract),
    ("reversion_semantics", check_reversion_semantics),
    ("registry_and_artifacts", check_registry_and_artifacts),
    ("asof_identity", check_asof_identity),
]


# pytest entrypoints (one test per check, for granular CI output)
def test_columns_contract():
    check_columns_contract()


def test_reversion_semantics():
    check_reversion_semantics()


def test_registry_and_artifacts():
    check_registry_and_artifacts()


def test_asof_identity():
    check_asof_identity()


def main() -> int:
    failures = []
    for name, fn in _CHECKS:
        try:
            fn()
            print(f"[journey-events-guard] PASS  {name}")
        except AssertionError as exc:
            failures.append(name)
            print(f"[journey-events-guard] FAIL  {name}\n{exc}\n")
    if failures:
        print(f"[journey-events-guard] FAILED ({len(failures)}): {', '.join(failures)}")
        return 1
    print("[journey-events-guard] OK — versioned journey_events ledger invariants intact.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
