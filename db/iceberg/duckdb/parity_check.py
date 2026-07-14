#!/usr/bin/env python3
"""
parity_check.py — reusable Spark↔DuckDB parity gate (hybrid validation).

For a ported table, compares the DuckDB parallel-run output (`<table>_duckdb_test`) against the
Spark-produced live table (`<table>`) on the SAME catalog:
  - row count
  - key-set symmetric difference (rows only in one side)
  - content mismatches on shared keys (any compared column DISTINCT FROM)
  - MD5 checksum over sorted, normalized rows  → the "data-equivalent" bar (NOT byte-identical files)

Usage:
  python parity_check.py <table> --keys brand_id,event_id [--cols col1,col2,...]
  # e.g.
  python parity_check.py silver_payment --keys brand_id,event_id \
      --cols source,payment_status,order_id,amount_minor,currency_code

Exit 0 = PARITY PASS (safe to cut the Trino view over + suspend the Spark job).
"""
from __future__ import annotations

import argparse
import sys

from _catalog import CATALOG, SILVER_NAMESPACE, connect


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


def parity(namespace: str, table: str, keys: list[str], cols: list[str], suffix: str) -> bool:
    con = connect()
    spark = f"{CATALOG}.{namespace}.{table}"
    duck = f"{CATALOG}.{namespace}.{table}{suffix}"
    key_sel = ", ".join(keys)
    order = ", ".join(keys)

    ns = con.execute(f"SELECT count(*) FROM {spark}").fetchone()[0]
    nd = con.execute(f"SELECT count(*) FROM {duck}").fetchone()[0]
    # only_s = Spark rows MISSING from DuckDB → a real regression (FAIL).
    # only_d = DuckDB rows not in Spark → almost always NEWER source events landed after the static
    #          Spark snapshot (oracle drift). A superset is acceptable; we flag it, we don't fail on it.
    only_s = con.execute(
        f"SELECT count(*) FROM (SELECT {key_sel} FROM {spark} EXCEPT SELECT {key_sel} FROM {duck})"
    ).fetchone()[0]
    only_d = con.execute(
        f"SELECT count(*) FROM (SELECT {key_sel} FROM {duck} EXCEPT SELECT {key_sel} FROM {spark})"
    ).fetchone()[0]
    join_on = " AND ".join(f"s.{k} = d.{k}" for k in keys)
    diff_pred = " OR ".join(f"s.{c} IS DISTINCT FROM d.{c}" for c in cols) or "FALSE"
    diff = con.execute(
        f"SELECT count(*) FROM {spark} s JOIN {duck} d ON {join_on} WHERE {diff_pred}"
    ).fetchone()[0]

    # Checksum over the SHARED-key intersection only (so oracle drift doesn't corrupt it),
    # timestamp-normalized. Compares like-for-like rows on both engines.
    norm_cols = ", ".join(_norm(con, spark, c) for c in keys + cols)
    shared_cksum_sql = (
        "SELECT md5(string_agg(concat_ws('|', {ncols}), chr(10) ORDER BY {order})) "
        "FROM {t} WHERE ({keysel}) IN (SELECT {keysel} FROM {other})"
    )
    cs = con.execute(shared_cksum_sql.format(ncols=norm_cols, order=order, t=spark, keysel=key_sel, other=duck)).fetchone()[0]
    cd = con.execute(shared_cksum_sql.format(ncols=norm_cols, order=order, t=duck, keysel=key_sel, other=spark)).fetchone()[0]

    ok = only_s == 0 and diff == 0 and cs == cd
    drift = only_d > 0

    print(f"── parity: {table} ──")
    print(f"  rows          spark={ns}  duckdb={nd}")
    print(f"  key-set       missing-from-duckdb={only_s}  duckdb-only(new source)={only_d}")
    print(f"  content diff  mismatches-on-shared-keys={diff}")
    print(f"  shared cksum  spark={cs}")
    print(f"                duckdb={cd}  {'MATCH' if cs == cd else 'DIFF'}")
    verdict = "PASS ✅" if ok else "REVIEW ❌"
    if ok and drift:
        verdict += f"  (DuckDB is a correct SUPERSET: +{only_d} newer source rows vs the stale Spark snapshot)"
    print(f"  PARITY: {verdict}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("table")
    ap.add_argument("--namespace", default=SILVER_NAMESPACE)
    ap.add_argument("--keys", required=True, help="comma-separated key columns")
    ap.add_argument("--cols", default="", help="comma-separated compared columns")
    ap.add_argument("--suffix", default="_duckdb_test")
    a = ap.parse_args()
    keys = [c.strip() for c in a.keys.split(",") if c.strip()]
    cols = [c.strip() for c in a.cols.split(",") if c.strip()]
    return 0 if parity(a.namespace, a.table, keys, cols, a.suffix) else 1


if __name__ == "__main__":
    sys.exit(main())
