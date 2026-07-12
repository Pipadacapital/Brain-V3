"""
snap_identity_link_asof_test.py — PURE proof of the AS-OF (point-in-time) identity-link read seam.

Proves that selecting WHERE snapshot_date <= D and taking the latest row per identifier returns the
HISTORICAL identity-link version as-of D — the brain_id/is_active the identifier resolved to on that
day — NOT today's current state. This is the whole value of snap_identity_link: deterministic
time-travel over the identity graph.

It seeds THREE snapshot dates for ONE identifier whose (brain_id, is_active) changed across days, plus
a second identifier (to prove the per-identifier partition), then asserts the as-of query returns the
right version for several dates D. The canonical seam SQL (db/.../_snap_as_of.py:as_of_sql) is executed
two ways, both PURE (no external service):
  1. against an in-memory sqlite DB — runs the ACTUAL SQL string the readers use (proof the SQL is
     correct, not just a hand-rolled reference);
  2. via the pure-Python reference resolver (_snap_as_of.resolve_as_of) — proof the reference agrees.

Run: python3 db/iceberg/spark/gold/snap_identity_link_asof_test.py
Exit 0 = all green, exit 1 = one or more failures.
"""
from __future__ import annotations

import os
import sqlite3
import sys

_GOLD_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _GOLD_DIR)

from _snap_as_of import as_of_sql, resolve_as_of  # noqa: E402

# ── The PK (without snapshot_date) the snapshot is keyed per-entity on ────────────
ENTITY_KEY = ["brand_id", "identifier_type", "identifier_value"]

# ── Seed: ONE brand, ONE identifier (email hash 'aaa') whose link mutates across 3 days ──
#   2026-06-10  email aaa → brain-1, active        (first identified)
#   2026-06-15  email aaa → brain-2, active        (customer merged into brain-2)
#   2026-06-20  email aaa → brain-2, INACTIVE      (edge tombstoned, e.g. GDPR erase)
# Plus a second identifier (phone hash 'bbb') on its own day, to prove the per-identifier partition
# (the as-of query must resolve each identifier independently, not bleed across them).
_BRAND = "brand_x"
_SEED = [
    {"brand_id": _BRAND, "identifier_type": "email", "identifier_value": "aaa",
     "snapshot_date": "2026-06-10", "brain_id": "brain-1", "is_active": 1},
    {"brand_id": _BRAND, "identifier_type": "email", "identifier_value": "aaa",
     "snapshot_date": "2026-06-15", "brain_id": "brain-2", "is_active": 1},
    {"brand_id": _BRAND, "identifier_type": "email", "identifier_value": "aaa",
     "snapshot_date": "2026-06-20", "brain_id": "brain-2", "is_active": 0},
    {"brand_id": _BRAND, "identifier_type": "phone", "identifier_value": "bbb",
     "snapshot_date": "2026-06-12", "brain_id": "brain-9", "is_active": 1},
]

# Expected AS-OF result per identifier for a set of probe dates.
#   key = (as_of_date) -> { (brand,type,value): (brain_id, is_active) or None-if-absent }
_A = (_BRAND, "email", "aaa")
_B = (_BRAND, "phone", "bbb")
_EXPECTED = {
    "2026-06-09": {_A: None, _B: None},                       # before any slice — nothing as-of
    "2026-06-10": {_A: ("brain-1", 1), _B: None},             # A's first slice; B not yet
    "2026-06-14": {_A: ("brain-1", 1), _B: ("brain-9", 1)},   # A STILL brain-1 (NOT brain-2) — historical!
    "2026-06-15": {_A: ("brain-2", 1), _B: ("brain-9", 1)},   # A merges to brain-2 on this exact day
    "2026-06-18": {_A: ("brain-2", 1), _B: ("brain-9", 1)},   # A active brain-2 (NOT yet inactive)
    "2026-06-20": {_A: ("brain-2", 0), _B: ("brain-9", 1)},   # A tombstoned (inactive) on this day
    "2026-06-25": {_A: ("brain-2", 0), _B: ("brain-9", 1)},   # current state == latest slice
}

_FAILURES: list[str] = []


def _fail(test: str, msg: str) -> None:
    _FAILURES.append(f"[{test}] {msg}")
    print(f"  FAIL ({test}): {msg}", file=sys.stderr)


def _pass(test: str, detail: str) -> None:
    print(f"  PASS ({test}): {detail}")


# ── 1. Execute the CANONICAL seam SQL against in-memory sqlite ────────────────────

def _sqlite_supports_windows(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("SELECT ROW_NUMBER() OVER (ORDER BY 1)").fetchone()
        return True
    except sqlite3.OperationalError:
        return False


def test_asof_sql_sqlite() -> None:
    """Run the ACTUAL as_of_sql() string in sqlite and assert the historical version per date."""
    conn = sqlite3.connect(":memory:")
    if not _sqlite_supports_windows(conn):
        # Loud skip — NOT a silent green. The pure-Python reference test below still proves correctness.
        print(
            f"  [SKIP] test_asof_sql_sqlite: sqlite {sqlite3.sqlite_version} lacks window functions "
            "(needs >= 3.25). The pure-Python reference proof (test_asof_reference) still runs.",
            file=sys.stderr,
        )
        return
    conn.execute(
        "CREATE TABLE snap_identity_link ("
        "brand_id TEXT, identifier_type TEXT, identifier_value TEXT, "
        "snapshot_date TEXT, brain_id TEXT, is_active INTEGER, computed_at TEXT)"
    )
    conn.executemany(
        "INSERT INTO snap_identity_link "
        "(brand_id, identifier_type, identifier_value, snapshot_date, brain_id, is_active, computed_at) "
        "VALUES (:brand_id, :identifier_type, :identifier_value, :snapshot_date, :brain_id, :is_active, '')",
        _SEED,
    )

    sql = as_of_sql("snap_identity_link", ENTITY_KEY, as_of_param=":as_of")
    bad = 0
    for as_of, expected in _EXPECTED.items():
        cur = conn.execute(sql, {"as_of": as_of})
        cols = [d[0] for d in cur.description]
        got = {
            (r[cols.index("brand_id")], r[cols.index("identifier_type")], r[cols.index("identifier_value")]):
            (r[cols.index("brain_id")], r[cols.index("is_active")])
            for r in cur.fetchall()
        }
        for ident, exp in expected.items():
            actual = got.get(ident)
            if exp is None:
                if actual is not None:
                    bad += 1
                    _fail("asof_sql_sqlite", f"as-of {as_of} {ident}: expected ABSENT, got {actual}")
            elif actual != exp:
                bad += 1
                _fail("asof_sql_sqlite", f"as-of {as_of} {ident}: expected {exp}, got {actual}")
    conn.close()
    if bad == 0:
        _pass(
            "asof_sql_sqlite",
            "canonical seam SQL returns the HISTORICAL link version per date across 7 probe dates "
            "(as-of 2026-06-14 → brain-1, NOT current brain-2/inactive)",
        )


# ── 2. Pure-Python reference resolver agrees (no DB at all) ───────────────────────

def test_asof_reference() -> None:
    """The pure-Python reference resolver returns the same historical version per date."""
    bad = 0
    for as_of, expected in _EXPECTED.items():
        resolved = resolve_as_of(_SEED, ENTITY_KEY, as_of)
        got = {k: (v["brain_id"], v["is_active"]) for k, v in resolved.items()}
        for ident, exp in expected.items():
            actual = got.get(ident)
            if exp is None:
                if actual is not None:
                    bad += 1
                    _fail("asof_reference", f"as-of {as_of} {ident}: expected ABSENT, got {actual}")
            elif actual != exp:
                bad += 1
                _fail("asof_reference", f"as-of {as_of} {ident}: expected {exp}, got {actual}")
    if bad == 0:
        _pass("asof_reference", "pure-Python resolver matches the as-of expectation on all 7 dates")


# ── 3. Explicit "not current state" proof ────────────────────────────────────────

def test_asof_is_not_current_state() -> None:
    """As-of a PAST date must differ from current state when the link changed — the core guarantee."""
    current = resolve_as_of(_SEED, ENTITY_KEY, "2026-06-25")[_A]
    historical = resolve_as_of(_SEED, ENTITY_KEY, "2026-06-14")[_A]
    cur_v = (current["brain_id"], current["is_active"])
    hist_v = (historical["brain_id"], historical["is_active"])
    if cur_v == hist_v:
        _fail(
            "asof_not_current",
            f"as-of 2026-06-14 == current {cur_v}; the snapshot is not time-traveling",
        )
    elif hist_v != ("brain-1", 1) or cur_v != ("brain-2", 0):
        _fail("asof_not_current", f"unexpected versions: historical={hist_v}, current={cur_v}")
    else:
        _pass(
            "asof_not_current",
            f"as-of 2026-06-14 → {hist_v} (historical) ≠ current {cur_v} — time-travel proven",
        )


# (A fourth, LIVE StarRocks variant of this test was removed in the Wave-3 cleanup —
# AUD-IMPL-021: StarRocks is retired, so the SNAP_ASOF_STARROCKS_DSN leg was permanently
# skipped and unrunnable. Serving-side AS-OF coverage lives in the Trino live suites.)


# ── Runner ────────────────────────────────────────────────────────────────────────

def run_all() -> None:
    tests = [
        test_asof_sql_sqlite,
        test_asof_reference,
        test_asof_is_not_current_state,
    ]
    print(f"\n[snap-identity-link-asof-test] running {len(tests)} assertions\n")
    passed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as exc:  # noqa: BLE001
            _fail(t.__name__, f"unexpected exception: {exc}")

    failed = len(_FAILURES)
    print(f"\n[snap-identity-link-asof-test] {passed}/{len(tests)} ran", end="")
    if failed:
        print(f", {failed} FAILED", file=sys.stderr)
        sys.exit(1)
    else:
        print(" — all green")
        sys.exit(0)


if __name__ == "__main__":
    run_all()
