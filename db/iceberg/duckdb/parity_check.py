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


def parity(namespace: str, table: str, keys: list[str], cols: list[str], suffix: str) -> bool:
    con = connect()
    spark = f"{CATALOG}.{namespace}.{table}"
    duck = f"{CATALOG}.{namespace}.{table}{suffix}"
    all_cols = keys + cols
    cl = ", ".join(all_cols)
    key_sel = ", ".join(keys)
    order = ", ".join(keys)

    ns = con.execute(f"SELECT count(*) FROM {spark}").fetchone()[0]
    nd = con.execute(f"SELECT count(*) FROM {duck}").fetchone()[0]
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

    def cksum(t: str) -> str:
        return con.execute(
            f"SELECT md5(string_agg(concat_ws('|', {cl}), chr(10) ORDER BY {order})) FROM {t}"
        ).fetchone()[0]

    cs, cd = cksum(spark), cksum(duck)
    ok = ns == nd and only_s == 0 and only_d == 0 and diff == 0 and cs == cd

    print(f"── parity: {table} ──")
    print(f"  rows          spark={ns}  duckdb={nd}  {'MATCH' if ns == nd else 'DIFF'}")
    print(f"  key-set diff  only-spark={only_s}  only-duckdb={only_d}")
    print(f"  content diff  mismatches-on-shared-keys={diff}")
    print(f"  checksum      spark={cs}")
    print(f"                duckdb={cd}  {'MATCH' if cs == cd else 'DIFF'}")
    print(f"  PARITY: {'PASS ✅' if ok else 'REVIEW ❌'}")
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
