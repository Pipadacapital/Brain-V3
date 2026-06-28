"""
_gold_registry_test.py — pure (no Spark) self-test for _gold_registry.py.

Asserts that the registry is internally consistent AND that every enabled spec is backed
by actual on-disk artifacts so the registry never drifts silently from the codebase.

CHECKS:
  1. No duplicate mart names in _GOLD_MARTS.
  2. Expected total count: 29 enabled (26 Gold + 3 Silver-snap) + 2 disabled.
  3. brand_id is pk[0] on every spec (V4 tenant-key invariant).
  4. money_columns entries have non-empty minor_col + non-empty currency_code_col.
  5. Disabled specs carry a not_implemented_reason starting with "NotImplementedYet",
     and have module=None + mv_name=None.
  6. Every enabled spec's module file EXISTS on disk in db/iceberg/spark/gold/.
  7. Every spec with a non-None mv_name has a matching db/trino/views/<mv>.sql file
     (V4 serving = Trino views over Iceberg; StarRocks removed).
  8. Every spec has a phase in VALID_PHASES ('identity' | 'bi').

Run: python3 db/iceberg/spark/gold/_gold_registry_test.py
Exit 0 = all green, exit 1 = one or more failures.
"""
from __future__ import annotations

import os
import sys

# ── Path setup ──────────────────────────────────────────────────────────────────
# Resolve dirs before any import so the registry can import without a Spark session.
_GOLD_DIR = os.path.dirname(os.path.abspath(__file__))   # db/iceberg/spark/gold/
# Project root: 4 dirname steps up from the gold/ directory.
#   gold/ -> spark/ -> iceberg/ -> db/ -> project root (Brain V3/)
_PROJECT_ROOT = os.path.dirname(
    os.path.dirname(
        os.path.dirname(
            os.path.dirname(_GOLD_DIR)
        )
    )
)
# V4 serving = Trino views over Iceberg (StarRocks removed). brain_serving.mv_* are Trino views.
_MV_DIR = os.path.join(_PROJECT_ROOT, "db", "trino", "views")

# Make _gold_registry importable (no Spark dependency — pure dataclasses).
sys.path.insert(0, _GOLD_DIR)

from _gold_registry import (  # noqa: E402
    _GOLD_MARTS,
    GOLD_MART_REGISTRY,
    VALID_PHASES,
    disabled_marts,
    enabled_marts,
)

# ── Helpers ─────────────────────────────────────────────────────────────────────

_FAILURES: list[str] = []


def _record_fail(test: str, msg: str) -> None:
    _FAILURES.append(f"[{test}] {msg}")
    print(f"  FAIL ({test}): {msg}", file=sys.stderr)


def _pass(test: str, detail: str) -> None:
    print(f"  PASS ({test}): {detail}")


# ── Individual tests ─────────────────────────────────────────────────────────────

def test_no_duplicate_names() -> None:
    """_GOLD_MARTS must have no duplicate name entries (silent dict overwrite = data loss)."""
    seen: set[str] = set()
    dupes: list[str] = []
    for spec in _GOLD_MARTS:
        if spec.name in seen:
            dupes.append(spec.name)
        seen.add(spec.name)
    if dupes:
        _record_fail("no_duplicate_names", f"duplicate names: {dupes}")
    else:
        _pass("no_duplicate_names", f"{len(_GOLD_MARTS)} specs — no duplicates")


def test_expected_counts() -> None:
    """Verify the expected enabled (28) + disabled (2) counts."""
    n_enabled = len(list(enabled_marts()))
    n_disabled = len(list(disabled_marts()))
    EXPECTED_ENABLED = 32   # 29 gold_* (+gold_journey_paths/repeat_latency/campaign_attribution, IA #32) + 3 snap_* (Silver-snapshot)
    EXPECTED_DISABLED = 2   # predictive_ltv + predictive_health

    if n_enabled != EXPECTED_ENABLED:
        _record_fail(
            "expected_counts",
            f"expected {EXPECTED_ENABLED} enabled marts, found {n_enabled}. "
            f"Update EXPECTED_ENABLED in this test when adding a new mart.",
        )
    else:
        _pass("expected_counts", f"{n_enabled} enabled marts (26 gold + 3 snap)")

    if n_disabled != EXPECTED_DISABLED:
        _record_fail(
            "expected_counts",
            f"expected {EXPECTED_DISABLED} disabled marts, found {n_disabled}.",
        )
    else:
        _pass("expected_counts", f"{n_disabled} disabled marts (predictive_ltv + predictive_health)")


def test_brand_id_first_in_pk() -> None:
    """brand_id must be pk[0] on every spec (V4 tenant-key invariant)."""
    bad = [
        f"{s.name}: pk[0]='{s.pk[0]}' (must be 'brand_id')"
        for s in GOLD_MART_REGISTRY.values()
        if not s.pk or s.pk[0] != "brand_id"
    ]
    if bad:
        for b in bad:
            _record_fail("brand_id_first", b)
    else:
        _pass("brand_id_first", f"{len(GOLD_MART_REGISTRY)} specs — brand_id is pk[0] on all")


def test_money_columns_well_formed() -> None:
    """money_columns entries must have non-empty minor_col + non-empty currency_code_col."""
    bad: list[str] = []
    for spec in GOLD_MART_REGISTRY.values():
        for mc in spec.money_columns:
            if not mc.minor_col or not isinstance(mc.minor_col, str):
                bad.append(f"{spec.name}: MoneyColumn.minor_col empty/non-str: {mc!r}")
            if not mc.currency_code_col or not isinstance(mc.currency_code_col, str):
                bad.append(f"{spec.name}: MoneyColumn.currency_code_col empty/non-str: {mc!r}")
    if bad:
        for b in bad:
            _record_fail("money_columns_well_formed", b)
    else:
        total = sum(len(s.money_columns) for s in GOLD_MART_REGISTRY.values())
        _pass("money_columns_well_formed", f"{total} money column entries — all well-formed")


def test_disabled_specs_shape() -> None:
    """Disabled specs: not_implemented_reason starts with 'NotImplementedYet'; module=mv_name=None."""
    bad: list[str] = []
    for spec in disabled_marts():
        if not spec.not_implemented_reason:
            bad.append(f"{spec.name}: not_implemented_reason is None/empty")
        elif not spec.not_implemented_reason.startswith("NotImplementedYet"):
            bad.append(
                f"{spec.name}: not_implemented_reason must start with 'NotImplementedYet' — "
                f"got: '{spec.not_implemented_reason[:70]}'"
            )
        if spec.module is not None:
            bad.append(f"{spec.name}: disabled spec must have module=None, got '{spec.module}'")
        if spec.mv_name is not None:
            bad.append(f"{spec.name}: disabled spec must have mv_name=None, got '{spec.mv_name}'")
    if bad:
        for b in bad:
            _record_fail("disabled_specs_shape", b)
    else:
        names = [s.name for s in disabled_marts()]
        _pass("disabled_specs_shape", f"{len(names)} disabled specs with NotImplementedYet markers: {names}")


def test_enabled_module_files_exist() -> None:
    """Every enabled spec's module file must exist at db/iceberg/spark/gold/<module>."""
    bad: list[str] = []
    for spec in enabled_marts():
        if spec.module is None:
            bad.append(f"{spec.name}: enabled=True but module=None")
            continue
        path = os.path.join(_GOLD_DIR, spec.module)
        if not os.path.isfile(path):
            bad.append(f"{spec.name}: '{spec.module}' not found at {path}")
    if bad:
        for b in bad:
            _record_fail("module_files_exist", b)
    else:
        n = len(list(enabled_marts()))
        _pass("module_files_exist", f"{n} enabled specs — all module .py files found on disk")


def test_mv_sql_files_exist() -> None:
    """Every spec with mv_name set must have a matching db/trino/views/<mv>.sql file."""
    bad: list[str] = []
    for spec in GOLD_MART_REGISTRY.values():
        if spec.mv_name is None:
            continue
        # "brain_serving.mv_gold_abandoned_cart" -> "mv_gold_abandoned_cart.sql"
        mv_file = spec.mv_name.split(".")[-1] + ".sql"
        path = os.path.join(_MV_DIR, mv_file)
        if not os.path.isfile(path):
            bad.append(
                f"{spec.name}: mv_name='{spec.mv_name}' -> file '{mv_file}' "
                f"NOT FOUND at {path} (gap: mv_*.sql missing — next wave)"
            )
    if bad:
        for b in bad:
            _record_fail("mv_sql_files_exist", b)
    else:
        served = sum(1 for s in GOLD_MART_REGISTRY.values() if s.mv_name is not None)
        _pass("mv_sql_files_exist", f"{served} specs with mv_name — all mv_*.sql files found on disk")


def test_phase_valid() -> None:
    """Every spec must carry a phase in VALID_PHASES ('identity' | 'bi')."""
    bad = [
        f"{s.name}: phase={s.phase!r} not in {sorted(VALID_PHASES)}"
        for s in GOLD_MART_REGISTRY.values()
        if s.phase not in VALID_PHASES
    ]
    if bad:
        for b in bad:
            _record_fail("phase_valid", b)
    else:
        n_identity = sum(1 for s in GOLD_MART_REGISTRY.values() if s.phase == "identity")
        n_bi = sum(1 for s in GOLD_MART_REGISTRY.values() if s.phase == "bi")
        _pass("phase_valid", f"{len(GOLD_MART_REGISTRY)} specs — all phases valid ({n_identity} identity, {n_bi} bi)")


def test_registry_dict_keys_match_names() -> None:
    """GOLD_MART_REGISTRY dict key must equal spec.name (no silent mismatch)."""
    bad = [
        f"key='{k}' != spec.name='{v.name}'"
        for k, v in GOLD_MART_REGISTRY.items()
        if k != v.name
    ]
    if bad:
        for b in bad:
            _record_fail("registry_keys_match", b)
    else:
        _pass("registry_keys_match", f"{len(GOLD_MART_REGISTRY)} entries — all keys match spec.name")


# ── Runner ───────────────────────────────────────────────────────────────────────

def run_all() -> None:
    tests = [
        test_no_duplicate_names,
        test_expected_counts,
        test_brand_id_first_in_pk,
        test_money_columns_well_formed,
        test_disabled_specs_shape,
        test_enabled_module_files_exist,
        test_mv_sql_files_exist,
        test_phase_valid,
        test_registry_dict_keys_match_names,
    ]

    print(f"\n[gold-registry-test] project_root={_PROJECT_ROOT}")
    print(f"[gold-registry-test] gold_dir   ={_GOLD_DIR}")
    print(f"[gold-registry-test] mv_dir     ={_MV_DIR}")
    print(f"[gold-registry-test] running {len(tests)} assertions\n")

    passed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as exc:  # noqa: BLE001 — test runner must never crash silently
            _record_fail(t.__name__, f"unexpected exception: {exc}")

    failed = len(_FAILURES)
    print(f"\n[gold-registry-test] {passed}/{len(tests)} passed", end="")
    if failed:
        print(f", {failed} FAILED", file=sys.stderr)
        sys.exit(1)
    else:
        print(" — all green")
        sys.exit(0)


if __name__ == "__main__":
    run_all()
