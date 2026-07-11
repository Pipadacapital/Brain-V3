"""
refold_supersede_guard_test.py — pure (no Spark) CI guard for the Wave-2 replay/backfill fixes on the
Gold tier: AUD-IMPL-012 (orphan DELETE on full-recompute merge_on_pk marts) and AUD-IMPL-013
(gold_attribution_credit supersede-on-refold) — gate_admission_guard_test.py style.

WHY THIS EXISTS
  AUD-IMPL-012: _gold_base.merge_on_pk's MATCHED-UPDATE / NOT-MATCHED-INSERT MERGE can never REMOVE a
  Gold row whose source group disappeared from Silver (RTBF erasure, dedup correction, quarantine) —
  the exact orphan class that inflated gold_revenue_ledger by +₹0.98 Cr before that one job moved to
  overwritePartitions() (gold_revenue_ledger.py:362-372). The fix is an OPT-IN
  `WHEN NOT MATCHED BY SOURCE THEN DELETE` (Spark 3.5) that MUST be brand-scoped under
  partition-incremental (the staged rollup covers only the bucket's brands — an unscoped delete would
  wipe every other tenant's rows) and MUST scope on the RECOMPUTED brands (the bucket), not the brands
  present in staged (a fully-erased brand has zero staged rows but must still shed its orphans).
  AUD-IMPL-013: the credit-ledger MERGE is insert-only on the deterministic credit_id. Re-folding an
  order whose journey MUTATED (stitch-v2 lift added touches; identity merge changed the earliest-touch
  anon) inserts new-shape rows BESIDE the old-shape rows → Σ weight_fraction ≠ 1 and
  Σ credited_revenue_minor ≠ realized for that (order, model). The fix deletes the superseded 'credit'
  rows of exactly the re-emitted (brand, order, model) groups first — never touching clawback-referenced
  rows (deleting one would orphan an economic reversal) and never touching orders absent from this fold.

WHAT THIS GUARD ASSERTS
  1. BEHAVIORAL (the pure _orphan_delete_clause helper is AST-extracted and exec'd — no pyspark):
     unscoped delete on a full pass; a quoted, escaped brand IN-list under a bucket; NO delete clause at
     all for an empty bucket (nothing recomputed → nothing may be deleted).
  2. WIRING — merge_on_pk defaults delete_orphans=False (prior behavior byte-identical), reads the
     recompute scope from _BRAND_BUCKET_VIEW, and appends the clause to the MERGE.
  3. OPT-INS — every full-recompute gap mart (no time-bounded read; PK re-derived per brand each run)
     passes delete_orphans=True; the versioned/append-only ledgers (journey_events, its reversion job)
     do NOT.
  4. SUPERSEDE — gold_attribution_credit calls _supersede_refolded_credits BEFORE the insert MERGE;
     the stale set is scoped semi-join (brand_id, order_id, model_id) ∧ anti-join (brand_id, credit_id)
     ∧ anti-join the clawback-referenced ids (reversed_of_credit_id); the delete is a
     WHEN MATCHED THEN DELETE MERGE; and the insert MERGE stays insert-only (ON-CONFLICT-keep).

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions).
Run: python3 db/iceberg/spark/gold/refold_supersede_guard_test.py
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
GOLD_DIR = _THIS.parent                                    # db/iceberg/spark/gold
BASE_FILE = GOLD_DIR / "_gold_base.py"
CREDIT_FILE = GOLD_DIR / "gold_attribution_credit.py"

# The full-recompute gap marts (the _gold_base GROUP): staged = a per-brand FULL rollup each run, no
# time-bounded source read → the orphan DELETE is safe and required. Verified 2026-07-12 against each
# mart's build SQL (no interval/current_date bound; PK groups re-derived from the full silver() read).
ORPHAN_DELETE_MARTS = (
    "gold_funnel.py",
    "gold_abandoned_cart.py",
    "gold_engagement.py",
    "gold_behavior.py",
    "gold_conversion_feedback.py",
    "gold_campaign_performance.py",
    "gold_contribution_margin.py",
    "gold_logistics_performance.py",
    "gold_cod_rto.py",
    "gold_settlement_summary.py",
)

# Versioned / append-only ledgers where a not-matched-by-source DELETE would DESTROY history.
NEVER_DELETE_ORPHANS = ("gold_journey_events.py", "gold_journey_events_reversion.py")


def _extract_function(path: Path, name: str):
    """AST-extract ONE top-level function and exec it in isolation (the module imports pyspark)."""
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


# ── 1. AUD-IMPL-012 behavioral: the pure orphan-delete-clause helper ───────────────────────────────
def check_orphan_clause_behavior():
    clause = _extract_function(BASE_FILE, "_orphan_delete_clause")

    # Full recompute (no bucket) → unscoped delete.
    full = clause(None)
    assert "WHEN NOT MATCHED BY SOURCE THEN DELETE" in full, f"unscoped clause wrong: {full!r}"
    assert "brand_id IN" not in full

    # Bucketed recompute → tenant-scoped to the RECOMPUTED brands (quoted literals).
    scoped = clause(["brand-a", "brand-b"])
    assert "WHEN NOT MATCHED BY SOURCE AND t.brand_id IN ('brand-a', 'brand-b') THEN DELETE" in scoped, (
        f"AUD-IMPL-012: bucket scope must inline the bucket brands, got: {scoped!r}"
    )

    # SQL-quote escaping (same '' doubling as gold_journey_paths).
    esc = clause(["it's"])
    assert "'it''s'" in esc, f"brand-id quote escaping missing: {esc!r}"

    # Empty bucket → NOTHING was recomputed → the MERGE must not delete anything.
    assert clause([]) == "", "AUD-IMPL-012: an empty bucket must suppress the delete clause entirely"
    assert clause([None, ""]) == "", "null/empty brand ids must not produce a delete clause"


# ── 2. AUD-IMPL-012 wiring: opt-in default-off, bucket-scoped, appended to the MERGE ───────────────
def check_orphan_clause_wired():
    src = _function_source(BASE_FILE, "merge_on_pk")
    assert re.search(r"delete_orphans:\s*bool\s*=\s*False", src), (
        "AUD-IMPL-012: delete_orphans must default False — prior merge behavior stays byte-identical"
    )
    assert "_BRAND_BUCKET_VIEW" in src, (
        "AUD-IMPL-012: the delete scope must come from the partition-incremental bucket view (the "
        "authoritative recompute scope), NOT from the brands present in staged"
    )
    assert "WHEN NOT MATCHED THEN INSERT *{orphan_clause}" in src, (
        "AUD-IMPL-012: the orphan clause must be appended to the MERGE after the INSERT branch"
    )


# ── 3. AUD-IMPL-012 opt-ins: full-recompute marts ON; versioned ledgers OFF ────────────────────────
def check_orphan_delete_opt_ins():
    for name in ORPHAN_DELETE_MARTS:
        text = (GOLD_DIR / name).read_text()
        assert re.search(r"merge_on_pk\([^)]*delete_orphans=True", text, re.S), (
            f"AUD-IMPL-012: {name} is a full per-brand recompute and must pass delete_orphans=True "
            f"(a disappeared Silver group otherwise survives as a stale Gold row forever)"
        )
    for name in NEVER_DELETE_ORPHANS:
        text = (GOLD_DIR / name).read_text()
        assert "delete_orphans=True" not in text, (
            f"{name} is a VERSIONED ledger — a not-matched-by-source DELETE would destroy history"
        )


# ── 4. AUD-IMPL-013: supersede-on-refold in the credit ledger ──────────────────────────────────────
def check_credit_supersede():
    text = CREDIT_FILE.read_text()
    sup = _function_source(CREDIT_FILE, "_supersede_refolded_credits")

    # Scope: ONLY the re-emitted (brand, order, model) groups; keep everything this fold did not touch.
    assert '["brand_id", "order_id", "model_id"], "left_semi"' in sup, (
        "AUD-IMPL-013: the stale set must be scoped to the (brand_id, order_id, model_id) groups this "
        "fold re-emitted — an order absent from the fold keeps its saved rows (stale-but-consistent)"
    )
    # Fresh ids survive: deterministic credit_id makes an unchanged-journey replay delete nothing.
    assert '["brand_id", "credit_id"], "left_anti"' in sup, (
        "AUD-IMPL-013: rows whose credit_id is re-emitted this run must NOT be deleted (idempotent replay)"
    )
    # Ledger honesty: never delete a credit a clawback references.
    assert "reversed_of_credit_id" in sup and sup.count("left_anti") >= 2, (
        "AUD-IMPL-013: clawback-referenced credit rows must be excluded from the supersede delete "
        "(deleting one would orphan the economic reversal)"
    )
    # Only credit rows are superseded — clawback rows are immutable reversal facts.
    assert 'F.col("row_kind") == F.lit("credit")' in sup, (
        "AUD-IMPL-013: only row_kind='credit' rows may be superseded"
    )
    assert "WHEN MATCHED THEN DELETE" in sup, "the supersede must be a MERGE ... WHEN MATCHED THEN DELETE"
    assert ".persist()" in sup, (
        "the target-derived stale set must be persisted before deleting from the same table "
        "(pin the pre-delete snapshot — gold_journey_events_reversion pattern)"
    )

    # Ordering: supersede runs BEFORE the insert MERGE, on the same staged source.
    call_pos = text.index("_supersede_refolded_credits(spark, fqtn, src)")
    merge_pos = text.index("USING attribution_credit_src s")
    assert call_pos < merge_pos, "AUD-IMPL-013: supersede must run BEFORE the insert MERGE"

    # The insert MERGE itself stays insert-only (ON-CONFLICT-keep — deterministic ids, saved rows win).
    insert_merge = text[merge_pos: merge_pos + 400]
    assert "WHEN NOT MATCHED THEN INSERT" in insert_merge
    assert "WHEN MATCHED THEN UPDATE" not in insert_merge and "WHEN MATCHED THEN DELETE" not in insert_merge, (
        "the credit insert MERGE must stay insert-only; superseding is the delete's job"
    )


# ── pytest bindings ─────────────────────────────────────────────────────────────────────────────────
def test_orphan_clause_behavior():
    check_orphan_clause_behavior()


def test_orphan_clause_wired():
    check_orphan_clause_wired()


def test_orphan_delete_opt_ins():
    check_orphan_delete_opt_ins()


def test_credit_supersede():
    check_credit_supersede()


if __name__ == "__main__":
    failed = False
    for fn in (check_orphan_clause_behavior, check_orphan_clause_wired,
               check_orphan_delete_opt_ins, check_credit_supersede):
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as exc:
            failed = True
            print(f"FAIL {fn.__name__}: {exc}", file=sys.stderr)
    sys.exit(1 if failed else 0)
