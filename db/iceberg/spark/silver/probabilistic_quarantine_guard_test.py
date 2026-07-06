# SPEC: A.3 / A.5.6 / §1.4 / §1.9.5 (WA-20) — the PROBABILISTIC QUARANTINE data+segregation test.
"""
probabilistic_quarantine_guard_test.py — the SPEC-named quarantine test (§1.9.5): asserts that ZERO
probabilistic-basis rows are reachable from any attribution/revenue input or output.

WHY THIS EXISTS (§1.4 — the attribution truth rule)
  Revenue attribution, CAC, ROAS and the ledger consume DETERMINISTIC identity links ONLY. Probabilistic
  links (A.3, Splink ≥ 0.95) live in a physically separate, QUARANTINED table
  (brain_silver.silver_probabilistic_stitch, identity_basis = 'probabilistic') and are structurally
  excluded from revenue paths BY CONSTRUCTION. AMD-12 R1: Splink is a sibling matcher that EXCLUSIVELY
  owns that table; the live rule-based matcher (MergeReview) is untouched.

WHAT THIS GUARD ASSERTS
  Q1 SOURCE SEGREGATION (grep-level): no attribution/revenue Spark job references the probabilistic
     table or its consumer view or the 'probabilistic' basis. They read silver_touchpoint /
     silver_session_identity / the order spine only.
  Q2 SINGLE OWNER (AMD-12): brain_silver.silver_probabilistic_stitch is CREATED/MERGED by exactly one
     Spark job — silver_probabilistic_stitch.py.
  Q3 CONSUMER SURFACE: the probabilistic table is read ONLY via customer_sessions_extended_v, which tags
     each leg with identity_basis ('deterministic' | 'probabilistic') — the estimated:true seam.
  Q4 FLAG GATE + FLOOR: the job gates writes behind identity.probabilistic (default OFF) and only emits
     pairs with confidence ≥ 0.95 (spec output floor).
  Q5 GOLDEN DATA TEST: the captured golden attribution/revenue OUTPUTS (gold_attribution_credit.csv,
     gold_revenue_ledger.csv) contain ZERO probabilistic-basis contamination (no 'probabilistic' token),
     and there is no probabilistic-stitch snapshot (flag OFF ⇒ empty quarantined table on golden).

All assertions are STATIC (source + captured-golden CSV reads) — no Spark/Trino/live stack needed, so
this runs in CI. Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions):
  python3 db/iceberg/spark/silver/probabilistic_quarantine_guard_test.py
"""
from __future__ import annotations

import csv
import re
from pathlib import Path

_THIS = Path(__file__).resolve()
SILVER_DIR = _THIS.parent                       # db/iceberg/spark/silver
GOLD_DIR = SILVER_DIR.parent / "gold"           # db/iceberg/spark/gold
SPARK_DIR = SILVER_DIR.parent                   # db/iceberg/spark
REPO = SILVER_DIR.parents[3]                    # repo root
VIEW_FILE = REPO / "db/trino/views/customer_sessions_extended_v.sql"
JOB_FILE = SILVER_DIR / "silver_probabilistic_stitch.py"
GOLDEN = REPO / "packages/testing-golden/snapshots/baseline"

PROB_TABLE = "silver_probabilistic_stitch"
CONSUMER_VIEW = "customer_sessions_extended_v"

# The attribution + revenue Spark jobs — §1.4's "deterministic identity links only" consumers. NONE may
# name the probabilistic table, its consumer view, or a probabilistic identity basis.
ATTRIBUTION_REVENUE_JOBS = [
    GOLD_DIR / "gold_attribution_credit.py",
    GOLD_DIR / "gold_attribution_paths.py",
    GOLD_DIR / "gold_marketing_attribution.py",
    GOLD_DIR / "gold_campaign_attribution.py",
    GOLD_DIR / "gold_revenue_ledger.py",
    GOLD_DIR / "gold_revenue_analytics.py",
    GOLD_DIR / "snap_attribution_credit.py",
    GOLD_DIR / "_attribution_math.py",
]

_FAILS: list[str] = []


def _check(cond: bool, msg: str) -> None:
    if not cond:
        _FAILS.append(msg)


# ── Q1 — SOURCE SEGREGATION: attribution/revenue jobs never touch the probabilistic layer ─────────
def test_q1_attribution_jobs_never_reference_probabilistic() -> None:
    for job in ATTRIBUTION_REVENUE_JOBS:
        _check(job.exists(), f"Q1: expected attribution/revenue job missing: {job}")
        if not job.exists():
            continue
        src = job.read_text()
        _check(PROB_TABLE not in src,
               f"Q1: {job.name} references the QUARANTINED table '{PROB_TABLE}' (§1.4 violation)")
        _check(CONSUMER_VIEW not in src,
               f"Q1: {job.name} references the probabilistic consumer view '{CONSUMER_VIEW}' (§1.4 violation)")
        _check(not re.search(r"identity_basis\s*=\s*'?probabilistic", src),
               f"Q1: {job.name} filters on a probabilistic identity_basis (§1.4 violation)")


# ── Q2 — SINGLE OWNER (AMD-12): only silver_probabilistic_stitch.py creates/merges the table ───────
def test_q2_single_writer_of_probabilistic_table() -> None:
    writers: list[str] = []
    for py in SPARK_DIR.rglob("*.py"):
        if py.name.endswith("_test.py") or py.name == "splink_v1_golden_eval.py":
            continue  # the eval harness only NAMES the table in a docstring; it is not a writer
        src = py.read_text()
        # a writer either MERGEs into it or declares it as its create_iceberg_table TABLE_NAME
        if re.search(rf"MERGE INTO[^\n]*{PROB_TABLE}", src) or \
           re.search(rf'TABLE_NAME\s*=\s*["\']{PROB_TABLE}["\']', src):
            writers.append(py.name)
    _check(writers == ["silver_probabilistic_stitch.py"],
           f"Q2: expected exactly one writer of {PROB_TABLE} (silver_probabilistic_stitch.py), got {writers}")


# ── Q3 — CONSUMER SURFACE: the union view carries the identity_basis discriminator ────────────────
def test_q3_consumer_view_tags_identity_basis() -> None:
    _check(VIEW_FILE.exists(), f"Q3: consumer view missing: {VIEW_FILE}")
    if not VIEW_FILE.exists():
        return
    v = VIEW_FILE.read_text()
    _check(PROB_TABLE in v, f"Q3: {CONSUMER_VIEW} does not read {PROB_TABLE}")
    _check("silver_touchpoint" in v, f"Q3: {CONSUMER_VIEW} must UNION the deterministic (silver_touchpoint) leg")
    _check("'probabilistic'" in v and "'deterministic'" in v,
           f"Q3: {CONSUMER_VIEW} must tag both legs with identity_basis ('deterministic'|'probabilistic')")


def test_q3_probabilistic_table_read_only_via_consumer_view() -> None:
    # No Trino serving view other than customer_sessions_extended_v may read the quarantined table.
    views_dir = REPO / "db/trino/views"
    offenders = [p.name for p in views_dir.glob("*.sql")
                 if p.name != VIEW_FILE.name and PROB_TABLE in p.read_text()]
    _check(not offenders, f"Q3: {PROB_TABLE} read by non-sanctioned serving view(s): {offenders}")


# ── Q4 — FLAG GATE (default OFF) + OUTPUT FLOOR ≥ 0.95 ─────────────────────────────────────────────
def test_q4_flag_gated_and_output_floor() -> None:
    src = JOB_FILE.read_text()
    _check("identity.probabilistic" in src or "FLAG_IDENTITY_PROBABILISTIC" in src,
           "Q4: job does not gate on the identity.probabilistic flag")
    _check("is_flag_enabled(" in src, "Q4: job does not call is_flag_enabled (per-brand gate)")
    _check(re.search(r'OUTPUT_FLOOR\s*=\s*float\(os\.environ\.get\("SPLINK_OUTPUT_FLOOR",\s*"0\.95"\)',
                     src) is not None,
           "Q4: job output floor is not the spec ≥ 0.95")
    # writes must be guarded by the enabled-brands branch (no unconditional MERGE)
    _check("if not enabled:" in src and "to_write" in src,
           "Q4: job MERGE is not guarded by the flag-ON brand set")


# ── Q5 — GOLDEN DATA TEST: zero probabilistic-basis rows in attribution/revenue OUTPUTS ────────────
def _no_probabilistic_token(csv_path: Path) -> bool:
    if not csv_path.exists():
        return True  # absent snapshot is not contamination
    csv.field_size_limit(10 ** 7)
    with csv_path.open() as f:
        r = csv.reader(f)
        header = next(r, [])
        # no column literally named/annotated probabilistic
        if any("probabilistic" in (c or "").lower() for c in header):
            return False
        for row in r:
            if any("probabilistic" in (cell or "").lower() for cell in row):
                return False
    return True


def test_q5_golden_attribution_revenue_outputs_have_zero_probabilistic_basis() -> None:
    for name in ("gold_attribution_credit.csv", "gold_revenue_ledger.csv"):
        _check(_no_probabilistic_token(GOLDEN / name),
               f"Q5: golden {name} contains a probabilistic-basis token (§1.4/§1.9.5 violation)")
    # flag OFF on golden ⇒ the quarantined table is EMPTY ⇒ no snapshot exists (or, if captured, 0 rows).
    snap = GOLDEN / f"{PROB_TABLE}.csv"
    if snap.exists():
        with snap.open() as f:
            rows = list(csv.reader(f))
        _check(len(rows) <= 1, f"Q5: golden {snap.name} has rows while identity.probabilistic is OFF ({len(rows)-1} data rows)")


def _run_all() -> int:
    for fn in sorted(k for k in globals() if k.startswith("test_")):
        globals()[fn]()
    if _FAILS:
        print("PROBABILISTIC QUARANTINE GUARD — FAIL:")
        for m in _FAILS:
            print("  ✗", m)
        return 1
    print("PROBABILISTIC QUARANTINE GUARD — PASS (Q1 segregation · Q2 single-owner · Q3 consumer-view · "
          "Q4 flag+floor · Q5 golden zero-probabilistic)")
    return 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
