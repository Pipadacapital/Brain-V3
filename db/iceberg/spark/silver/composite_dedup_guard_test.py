"""
composite_dedup_guard_test.py — Brain V4 CI guard: the G5 CROSS-SOURCE COMPOSITE DEDUP rule in
silver_touchpoint.py keeps its invariants (the pre-declared PR #338 follow-up).

WHY THIS EXISTS
  A pixel purchase-class touchpoint matched to the SAME connector order (silver_order_state) within
  60s is FLAGGED (is_composite + composite_order_key) — never removed. The rule is safe only while
  four invariants hold, and each has a failure mode worth a regression net:
    1. TENANT ISOLATION — the join MUST carry t.brand_id = o.brand_id (a cross-brand order match
       would leak one tenant's order ids into another's touchpoints).
    2. EXPLICIT ORDER KEY, NO AMOUNT FALLBACK — pixel purchase touchpoints carry NO revenue and NO
       checkout_token, so the ONLY accepted key is $.properties.order_id. Any amount/money-based
       fallback (order_value_minor / currency_code) is ambiguous matching — worse than no flag.
    3. TRANSACTION CLASS + ≤60s WINDOW — only transaction-class events are joined (the SAME shared
       TRANSACTION_EVENT_RLIKE as the same-source lag rule — one definition, so the two classes can
       never drift), inside a symmetric abs(...) <= 60 window.
    4. FLAG-ONLY (LEFT JOIN) + MERGE PARITY — no row removal, and the staged frame (final_sql)
       projects EVERY _COLUMNS column so MERGE `UPDATE SET *` / `INSERT *` (name-resolved) binds.

WHAT THIS GUARD ASSERTS (all static — no Spark/Trino/pyspark needed, runnable in CI; the target
module imports pyspark so we read its SOURCE, gate_admission_guard_test.py style).

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions):
  python3 db/iceberg/spark/silver/composite_dedup_guard_test.py
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

# ── Locate the sources (repo-root-relative, robust to cwd) ────────────────────────────────────────
_THIS = Path(__file__).resolve()
SILVER_DIR = _THIS.parent                                   # db/iceberg/spark/silver
TOUCHPOINT_FILE = SILVER_DIR / "silver_touchpoint.py"
TRINO_VIEW_FILE = (
    SILVER_DIR.parents[2] / "trino" / "views" / "mv_silver_touchpoint.sql"
)  # db/trino/views/mv_silver_touchpoint.sql

_SRC = TOUCHPOINT_FILE.read_text()


# ── AST extraction of module constants (handles both `X = "…"` and `X = """…""".strip("\n")`) ─────
def _extract_constant(name: str):
    tree = ast.parse(_SRC)
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id == name:
                    v = node.value
                    if isinstance(v, ast.Constant):
                        return v.value
                    # """…""".strip("\n") — a Call on a Constant receiver (the _COLUMNS pattern)
                    if (
                        isinstance(v, ast.Call)
                        and isinstance(v.func, ast.Attribute)
                        and isinstance(v.func.value, ast.Constant)
                    ):
                        return v.func.value.value
    raise AssertionError(f"could not find a plain-constant assignment `{name}` in {TOUCHPOINT_FILE}")


def _extract_fstring_block(name: str) -> str:
    """Return the RAW source text of a triple-quoted (f-)string assignment/statement region."""
    m = re.search(rf'{name}\s*=\s*f?"""(.*?)"""', _SRC, re.DOTALL)
    assert m, f"could not find triple-quoted assignment `{name}` in {TOUCHPOINT_FILE}"
    return m.group(1)


# ── The checks ────────────────────────────────────────────────────────────────────────────────────
def check_transaction_class_is_single_shared_definition():
    """One TRANSACTION_EVENT_RLIKE, interpolated into BOTH composite rules — the classes cannot drift."""
    rlike = _extract_constant("TRANSACTION_EVENT_RLIKE")
    for member in ("^order[._]", "order_placed", "purchase", "checkout.completed", "payment.(succeeded|captured)"):
        assert member in rlike, f"TRANSACTION_EVENT_RLIKE lost its `{member}` class member: {rlike}"
    uses = _SRC.count("rlike '{TRANSACTION_EVENT_RLIKE}'")
    assert uses >= 2, (
        "TRANSACTION_EVENT_RLIKE must be interpolated into BOTH the same-source lag rule "
        f"(sessionized_sql) AND the cross-source order join (COMPOSITE_ORDER_JOIN); found {uses} use(s)."
    )
    # No stray inline copy of the class left behind (drift risk): the literal lives ONLY in the constant.
    assert _SRC.count("order_placed") == 1, (
        "the transaction class appears inlined outside TRANSACTION_EVENT_RLIKE — collapse it onto the constant"
    )


def check_window_is_60_seconds():
    assert _extract_constant("COMPOSITE_ORDER_WINDOW_SECONDS") == 60, (
        "COMPOSITE_ORDER_WINDOW_SECONDS must be 60 (the G5 pixel↔connector match window)"
    )
    join = _extract_fstring_block("COMPOSITE_ORDER_JOIN")
    assert "<= {COMPOSITE_ORDER_WINDOW_SECONDS}" in join, (
        "COMPOSITE_ORDER_JOIN must bound the match with `<= {COMPOSITE_ORDER_WINDOW_SECONDS}`"
    )
    assert "abs(unix_timestamp(t.occurred_at)" in join, (
        "the window must be SYMMETRIC: abs(unix_timestamp(t.occurred_at) - …) — not a one-sided lag"
    )
    assert "coalesce(o.state_effective_at, o.first_event_at)" in join, (
        "the connector-side anchor must be coalesce(o.state_effective_at, o.first_event_at)"
    )


def check_join_is_tenant_isolated_and_keyed_on_order_id():
    join = _extract_fstring_block("COMPOSITE_ORDER_JOIN")
    assert "t.brand_id = o.brand_id" in join, (
        "TENANT ISOLATION — COMPOSITE_ORDER_JOIN lost the brand_id equi-key (cross-brand order leak)"
    )
    assert "t.tp_order_id = o.order_id" in join, (
        "COMPOSITE_ORDER_JOIN must key on the explicit pixel order reference (t.tp_order_id = o.order_id)"
    )
    assert "rlike '{TRANSACTION_EVENT_RLIKE}'" in join, (
        "COMPOSITE_ORDER_JOIN must restrict to the shared transaction-class rlike"
    )
    assert join.lstrip().lower().startswith("left join"), (
        "COMPOSITE_ORDER_JOIN must be a LEFT JOIN — the rule is FLAG-ONLY, never row removal"
    )


def check_no_amount_fallback():
    """NO MONEY in this mart and NO amount-based matching: pixel purchase touchpoints carry no revenue,
    so an amount match would be ambiguous — the guard pins that no money column is ever read/joined."""
    for money_col in ("order_value_minor", "currency_code"):
        assert money_col not in _SRC, (
            f"silver_touchpoint.py references `{money_col}` — an amount/money fallback crept into the "
            "composite match (forbidden: ambiguous matching is worse than no flag; touchpoints carry NO money)"
        )
    # The order_state_one view reads ONLY the join/anchor columns.
    m = re.search(r"spark\.read\.table\(ORDER_STATE_TABLE\)\.selectExpr\((.*?)\)", _SRC, re.DOTALL)
    assert m, "order_state_one registration (spark.read.table(ORDER_STATE_TABLE).selectExpr(…)) not found"
    cols = set(re.findall(r'"([^"]+)"', m.group(1)))
    assert cols == {"brand_id", "order_id", "state_effective_at", "first_event_at"}, (
        f"order_state_one must read ONLY brand_id/order_id/state_effective_at/first_event_at; got {sorted(cols)}"
    )


def check_columns_contract_and_serving_projection():
    columns = _extract_constant("_COLUMNS")
    names = [line.split()[0] for line in columns.splitlines() if line.strip()]
    assert "composite_order_key" in names, "_COLUMNS lost composite_order_key"
    assert names.index("composite_order_key") == names.index("is_composite") + 1, (
        "composite_order_key must sit immediately after is_composite in _COLUMNS"
    )
    # Nullable (additive): the reconciler ALTER-adds it, and you cannot add NOT NULL to a live table.
    col_line = next(line for line in columns.splitlines() if line.split() and line.split()[0] == "composite_order_key")
    assert "NOT NULL" not in col_line and "string" in col_line, (
        f"composite_order_key must be a NULLABLE string (additive evolution): `{col_line.strip()}`"
    )
    # tp_order_id is INTERNAL-ONLY — never a table column.
    assert "tp_order_id" not in names, "tp_order_id is an internal join key and must NOT be a table column"
    # The Trino serving view stays thin but projects the new column.
    view = TRINO_VIEW_FILE.read_text()
    assert re.search(r"^\s*composite_order_key,\s*$", view, re.MULTILINE), (
        f"mv_silver_touchpoint.sql must project composite_order_key ({TRINO_VIEW_FILE})"
    )


def check_merge_staged_frame_projects_every_column():
    """MERGE `UPDATE SET *` / `INSERT *` resolves by NAME — every _COLUMNS column must be projected by
    final_sql (as `t.<col>` or `… as <col>`), or the MERGE dies with UNRESOLVED_COLUMN."""
    columns = _extract_constant("_COLUMNS")
    names = [line.split()[0] for line in columns.splitlines() if line.strip()]
    final_sql = _extract_fstring_block("final_sql")
    missing = [
        c for c in names
        if not re.search(rf"(\bas\s+{re.escape(c)}\b|\bt\.{re.escape(c)}\b)", final_sql, re.IGNORECASE)
    ]
    assert not missing, (
        f"final_sql (the MERGE-staged frame) does not project _COLUMNS column(s) {missing} — "
        "UPDATE SET * / INSERT * would fail to bind"
    )
    # The composite projections specifically ride the parameter seam (null fallback when order_state absent).
    assert "{composite_flag} as is_composite" in final_sql, "final_sql must project {composite_flag} as is_composite"
    assert "{composite_key} as composite_order_key" in final_sql, (
        "final_sql must project {composite_key} as composite_order_key"
    )
    assert "{order_join}" in final_sql, "final_sql must splice {order_join} (the LEFT JOIN seam)"
    # Reverse parity: the INTERNAL join key must never leak into the staged frame — an extra source
    # column (tp_order_id) not present on the target would break INSERT * just as a missing one would.
    assert "tp_order_id" not in final_sql, (
        "final_sql projects tp_order_id — it is an internal join key, not a table column (INSERT * would break)"
    )
    # The is_composite widening keeps the same-source flag and ORs the cross-source match — never narrows.
    assert '"(t.is_composite OR o.order_id IS NOT NULL)"' in _SRC, (
        "build() must widen the flag as (t.is_composite OR o.order_id IS NOT NULL) — additive, never narrowing"
    )


def check_tp_order_id_is_threaded_to_the_join():
    """The pixel order reference must be extracted from the payload and survive every intermediate
    projection (dedup → ordered → sessionized) so the final_sql join can see t.tp_order_id."""
    assert "'$.properties.order_id'" in _SRC and "as tp_order_id" in _SRC, (
        "source select must extract get_json_object(pj, '$.properties.order_id') AS tp_order_id"
    )
    # It must appear in the dedup list, the ordered CTE list, and the sessionized final list (3 SQL
    # projections) in addition to the source extraction — count word occurrences as a cheap proxy.
    occurrences = len(re.findall(r"\btp_order_id\b", _SRC))
    assert occurrences >= 5, (
        f"tp_order_id appears only {occurrences}x — it must be threaded through EVERY intermediate "
        "projection (source, dedup, ordered, sessionized select, join) or the LEFT JOIN cannot resolve it"
    )


_CHECKS = [
    ("transaction_class_is_single_shared_definition", check_transaction_class_is_single_shared_definition),
    ("window_is_60_seconds", check_window_is_60_seconds),
    ("join_is_tenant_isolated_and_keyed_on_order_id", check_join_is_tenant_isolated_and_keyed_on_order_id),
    ("no_amount_fallback", check_no_amount_fallback),
    ("columns_contract_and_serving_projection", check_columns_contract_and_serving_projection),
    ("merge_staged_frame_projects_every_column", check_merge_staged_frame_projects_every_column),
    ("tp_order_id_is_threaded_to_the_join", check_tp_order_id_is_threaded_to_the_join),
]


# pytest entrypoints (one test per check, for granular CI output)
def test_transaction_class_is_single_shared_definition():
    check_transaction_class_is_single_shared_definition()


def test_window_is_60_seconds():
    check_window_is_60_seconds()


def test_join_is_tenant_isolated_and_keyed_on_order_id():
    check_join_is_tenant_isolated_and_keyed_on_order_id()


def test_no_amount_fallback():
    check_no_amount_fallback()


def test_columns_contract_and_serving_projection():
    check_columns_contract_and_serving_projection()


def test_merge_staged_frame_projects_every_column():
    check_merge_staged_frame_projects_every_column()


def test_tp_order_id_is_threaded_to_the_join():
    check_tp_order_id_is_threaded_to_the_join()


def main() -> int:
    failures = []
    for name, fn in _CHECKS:
        try:
            fn()
            print(f"[composite-dedup-guard] PASS  {name}")
        except AssertionError as exc:
            failures.append(name)
            print(f"[composite-dedup-guard] FAIL  {name}\n{exc}\n")
    if failures:
        print(f"[composite-dedup-guard] FAILED ({len(failures)}): {', '.join(failures)}")
        return 1
    print("[composite-dedup-guard] OK — G5 cross-source composite invariants intact.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
