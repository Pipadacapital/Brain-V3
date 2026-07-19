#!/usr/bin/env python3
"""
parity_check.py — reusable parity gate (hybrid validation).

Two modes, ONE comparator (`parity()` diffs two suffixed builds of the SAME logical table on the SAME
catalog):

1. Spark↔DuckDB (default, migration gate): compares the DuckDB parallel-run output
   (`<table>_duckdb_test`) against the Spark-produced live table (`<table>`).

2. Incremental↔Full (ADR-0016 P1.1 Gold gate): compares an incremental build (`<table>_incr`) against a
   full-recompute build (`<table>_full`) of the SAME DuckDB job. This is the pre-merge gate for flipping
   GOLD_INCREMENTAL default-on: an incremental Gold mart MUST be provably equal to its full recompute,
   money byte-exact. Drive it with `--namespace <gold ns> --left-suffix _full --right-suffix _incr`, or the
   canned Gold manifest below (`--gold-manifest`) which knows every incremental-safe Gold mart's keys +
   money columns.

Each comparison checks:
  - row count
  - key-set symmetric difference (rows only in one side)
  - content mismatches on shared keys (any compared column DISTINCT FROM)
  - MD5 checksum over sorted, normalized rows  → the "data-equivalent" bar (NOT byte-identical files)

The Gold incremental gate is STRICTER than the migration gate: for incremental==full there is NO oracle
drift (both sides are built from the SAME frozen snapshot), so `only_d` (right-only rows) must ALSO be 0.
`--strict` (implied by `--gold-manifest`) fails on any right-only row.

Usage:
  # Spark↔DuckDB migration gate
  python parity_check.py <table> --keys brand_id,event_id [--cols col1,col2,...]
  python parity_check.py silver_payment --keys brand_id,event_id \
      --cols source,payment_status,order_id,amount_minor,currency_code

  # ADR-0016 Gold incremental↔full gate — one mart
  python parity_check.py gold_customer_360 --namespace brain_gold \
      --keys brand_id,brain_id --cols lifetime_value_minor,order_count \
      --left-suffix _full --right-suffix _incr --strict

  # ADR-0016 Gold incremental↔full gate — every incremental-safe Gold mart (CI harness)
  python parity_check.py --gold-manifest --left-suffix _full --right-suffix _incr

Exit 0 = PARITY PASS.
"""
from __future__ import annotations

import argparse
import sys

from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, connect

# ── Gold incremental-safe mart manifest (ADR-0016 P1.1) ────────────────────────────────────────────────
# The 30 Gold marts that pass enabled=GOLD_INCREMENTAL to incremental_window() — i.e. the marts whose
# incremental output MUST equal their full recompute before GOLD_INCREMENTAL flips default-on. Each entry is
# (mart, keys, money+material cols to diff). The three full-recompute money marts (gold_revenue_ledger,
# gold_cac, gold_contribution_margin) are DELIBERATELY ABSENT — they never window (delete_orphans /
# multi-source money-safety), so incremental==full is vacuous for them and the flag never touches their path.
GOLD_INCREMENTAL_MARTS: dict[str, tuple[list[str], list[str]]] = {
    "gold_customer_360": (["brand_id", "brain_id"], ["lifetime_value_minor", "order_count", "currency_code"]),
    "gold_order_economics": (["brand_id", "order_id"], ["net_revenue_minor", "gross_revenue_minor", "currency_code"]),
    "gold_customer_health": (["brand_id", "brain_id"], ["health_score", "order_count"]),
    "gold_customer_scores": (["brand_id", "brain_id"], ["score"]),
    "gold_customer_segments": (["brand_id", "brain_id"], ["segment"]),
    "gold_journey": (["brand_id", "journey_id"], ["touchpoint_count"]),
    "gold_journey_events": (["brand_id", "event_id"], ["seq"]),
    "gold_journey_paths": (["brand_id", "path_id"], ["path_count"]),
    "gold_attribution_paths": (["brand_id", "path_id"], ["conversions"]),
    "gold_campaign_attribution": (["brand_id", "campaign_id"], ["attributed_revenue_minor", "currency_code"]),
    "gold_campaign_performance": (["brand_id", "campaign_id"], ["spend_minor", "currency_code"]),
    "gold_marketing_attribution": (["brand_id", "channel"], ["attributed_revenue_minor", "currency_code"]),
    "gold_utm_source": (["brand_id", "utm_source"], ["revenue_minor", "currency_code"]),
    "gold_behavior": (["brand_id", "visitor_id"], ["event_count"]),
    "gold_engagement": (["brand_id", "brain_id"], ["engagement_score"]),
    "gold_cohorts": (["brand_id", "cohort_month"], ["cohort_size"]),
    "gold_cohort_member": (["brand_id", "brain_id"], ["cohort_month"]),
    "gold_retention": (["brand_id", "cohort_month"], ["retained_count"]),
    "gold_repeat_latency": (["brand_id", "brain_id"], ["days_to_repeat"]),
    "gold_revenue_analytics": (["brand_id", "day"], ["revenue_minor", "currency_code"]),
    "gold_executive_metrics": (["brand_id", "metric_date"], ["revenue_minor", "currency_code"]),
    "gold_cod_rto": (["brand_id", "order_id"], ["rto_flag"]),
    "gold_delivery_time": (["brand_id", "shipment_id"], ["delivery_hours"]),
    "gold_product_economics": (["brand_id", "product_id"], ["margin_minor", "currency_code"]),
    "gold_measurement_fees": (["brand_id", "settlement_id"], ["fee_minor", "currency_code"]),
}


def _norm(con, table: str, col: str) -> str:
    """Render a column for the checksum in a type-stable, TZ-artifact-free way.

    Timestamp/timestamptz → canonical UTC microsecond string (so a Spark timestamptz UTC instant and a
    DuckDB timestamp of the same instant render identically). Everything else → plain CAST to VARCHAR.
    """
    t = con.execute(
        "SELECT data_type FROM information_schema.columns "
        "WHERE table_name = ? AND column_name = ? LIMIT 1",
        [table.split(".")[-1], col],
    ).fetchone()
    dtype = (t[0] if t else "").upper()
    if "TIMESTAMP" in dtype:
        return f"strftime(CAST({col} AS TIMESTAMP), '%Y-%m-%d %H:%M:%S.%g')"
    return f"CAST({col} AS VARCHAR)"


def parity(namespace: str, table: str, keys: list[str], cols: list[str], suffix: str,
           *, left_suffix: str = "", strict: bool = False) -> bool:
    """Compare two suffixed builds of `table` on the same catalog.

    LEFT (the oracle/full side)  = `{table}{left_suffix}`     (default "" → the Spark live table)
    RIGHT (the candidate side)   = `{table}{suffix}`          (default "_duckdb_test" → the DuckDB port)

    only_l = LEFT rows MISSING from RIGHT → always a regression (FAIL — the candidate dropped a row).
    only_r = RIGHT rows not in LEFT.
      - migration gate (default, non-strict): almost always newer source events landed after the static
        Spark snapshot (oracle drift). A superset is acceptable; flagged, not failed.
      - incremental↔full gate (--strict): both sides are built from the SAME frozen snapshot, so there is
        NO drift — a right-only row means the incremental path INVENTED a row → FAIL.
    """
    con = connect()
    left = f"{CATALOG}.{namespace}.{table}{left_suffix}"
    right = f"{CATALOG}.{namespace}.{table}{suffix}"
    key_sel = ", ".join(keys)
    order = ", ".join(keys)

    nl = con.execute(f"SELECT count(*) FROM {left}").fetchone()[0]
    nr = con.execute(f"SELECT count(*) FROM {right}").fetchone()[0]
    only_l = con.execute(
        f"SELECT count(*) FROM (SELECT {key_sel} FROM {left} EXCEPT SELECT {key_sel} FROM {right})"
    ).fetchone()[0]
    only_r = con.execute(
        f"SELECT count(*) FROM (SELECT {key_sel} FROM {right} EXCEPT SELECT {key_sel} FROM {left})"
    ).fetchone()[0]
    join_on = " AND ".join(f"s.{k} = d.{k}" for k in keys)
    diff_pred = " OR ".join(f"s.{c} IS DISTINCT FROM d.{c}" for c in cols) or "FALSE"
    diff = con.execute(
        f"SELECT count(*) FROM {left} s JOIN {right} d ON {join_on} WHERE {diff_pred}"
    ).fetchone()[0]

    # Checksum over the SHARED-key intersection only (so oracle drift doesn't corrupt it),
    # timestamp-normalized. Compares like-for-like rows on both sides.
    norm_cols = ", ".join(_norm(con, left, c) for c in keys + cols)
    shared_cksum_sql = (
        "SELECT md5(string_agg(concat_ws('|', {ncols}), chr(10) ORDER BY {order})) "
        "FROM {t} WHERE ({keysel}) IN (SELECT {keysel} FROM {other})"
    )
    cs = con.execute(shared_cksum_sql.format(ncols=norm_cols, order=order, t=left, keysel=key_sel, other=right)).fetchone()[0]
    cd = con.execute(shared_cksum_sql.format(ncols=norm_cols, order=order, t=right, keysel=key_sel, other=left)).fetchone()[0]

    # STRICT (incremental↔full): also require equal row counts + zero right-only rows — no drift is allowed
    # when both sides share a frozen snapshot. Money-column diffs are surfaced by the same `diff`/checksum.
    ok = only_l == 0 and diff == 0 and cs == cd
    if strict:
        ok = ok and only_r == 0 and nl == nr
    drift = only_r > 0

    print(f"── parity: {table} ──")
    print(f"  rows          left={nl}  right={nr}")
    print(f"  key-set       missing-from-right={only_l}  right-only={only_r}")
    print(f"  content diff  mismatches-on-shared-keys={diff}")
    print(f"  shared cksum  left={cs}")
    print(f"                right={cd}  {'MATCH' if cs == cd else 'DIFF'}")
    verdict = "PASS ✅" if ok else "REVIEW ❌"
    if ok and drift and not strict:
        verdict += f"  (RIGHT is a correct SUPERSET: +{only_r} newer source rows vs the stale LEFT snapshot)"
    if strict and only_r > 0:
        verdict += f"  (STRICT FAIL: incremental invented +{only_r} rows absent from the full recompute)"
    print(f"  PARITY: {verdict}")
    return ok


def run_gold_manifest(left_suffix: str, right_suffix: str) -> bool:
    """ADR-0016 P1.1 Gold gate: run STRICT incremental↔full parity across every incremental-safe Gold mart.

    Presumes a harness has already produced, on the SAME frozen Bronze/Silver snapshot, both a full-recompute
    build (`{mart}{left_suffix}`, GOLD_INCREMENTAL off / FULL_REFRESH=1) and an incremental build
    (`{mart}{right_suffix}`, GOLD_INCREMENTAL=1 with a mid-snapshot watermark). Returns True IFF EVERY mart is
    byte-exact (money included). Any mart FAIL blocks flipping GOLD_INCREMENTAL default-on in prod.
    """
    all_ok = True
    for mart, (keys, cols) in GOLD_INCREMENTAL_MARTS.items():
        ok = parity(GOLD_NAMESPACE, mart, keys, cols, right_suffix,
                    left_suffix=left_suffix, strict=True)
        all_ok = all_ok and ok
    print(f"\n══ GOLD incremental↔full manifest: {'ALL PASS ✅' if all_ok else 'FAIL ❌'} "
          f"({len(GOLD_INCREMENTAL_MARTS)} marts) ══")
    return all_ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("table", nargs="?", help="table to compare (omit with --gold-manifest)")
    ap.add_argument("--namespace", default=SILVER_NAMESPACE)
    ap.add_argument("--keys", help="comma-separated key columns")
    ap.add_argument("--cols", default="", help="comma-separated compared columns")
    ap.add_argument("--suffix", "--right-suffix", dest="suffix", default="_duckdb_test",
                    help="RIGHT/candidate suffix (default _duckdb_test; incremental gate: _incr)")
    ap.add_argument("--left-suffix", default="",
                    help="LEFT/oracle suffix (default '' → Spark live table; incremental gate: _full)")
    ap.add_argument("--strict", action="store_true",
                    help="fail on any right-only row / row-count mismatch (incremental↔full has no drift)")
    ap.add_argument("--gold-manifest", action="store_true",
                    help="ADR-0016 P1.1: STRICT incremental↔full over every incremental-safe Gold mart")
    a = ap.parse_args()

    if a.gold_manifest:
        left = a.left_suffix or "_full"
        right = a.suffix if a.suffix != "_duckdb_test" else "_incr"
        return 0 if run_gold_manifest(left, right) else 1

    if not a.table or not a.keys:
        ap.error("table and --keys are required unless --gold-manifest is given")
    keys = [c.strip() for c in a.keys.split(",") if c.strip()]
    cols = [c.strip() for c in a.cols.split(",") if c.strip()]
    ok = parity(a.namespace, a.table, keys, cols, a.suffix,
                left_suffix=a.left_suffix, strict=a.strict)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
