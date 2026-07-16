"""test_views.py — the serving-view applier (pure unit; in-memory DuckDB, no stack).

Proves the three behaviors dev-up and /readyz depend on:
  1. continue-on-error: a view over a missing table is SKIPPED, later views still apply
     (parity with run-trino-views.sh — the bug it fixed left only the first view applied),
  2. an EMPTY or MISSING views dir is a valid ready state (0 applied, 0 skipped) — the views
     land in a parallel workstream,
  3. comment/semicolon normalization + local-schema creation (brain_serving/brain_bronze).
Run: python -m pytest db/iceberg/duckdb/serving/test_views.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import duckdb  # noqa: E402

import views  # noqa: E402


def _write(dirpath, name, text):
    with open(os.path.join(dirpath, name), "w", encoding="utf-8") as f:
        f.write(text)


def test_empty_dir_applies_nothing_and_is_ready(tmp_path):
    con = duckdb.connect()
    applied, skipped = views.apply_views(con, str(tmp_path))
    assert (applied, skipped) == (0, [])


def test_missing_dir_applies_nothing_and_is_ready(tmp_path):
    con = duckdb.connect()
    applied, skipped = views.apply_views(con, str(tmp_path / "does-not-exist"))
    assert (applied, skipped) == (0, [])


def test_local_schemas_created_even_with_no_views(tmp_path):
    con = duckdb.connect()
    views.apply_views(con, str(tmp_path))
    schemas = {r[0] for r in con.execute("SELECT schema_name FROM information_schema.schemata").fetchall()}
    assert {"brain_serving", "brain_bronze"} <= schemas


def test_continue_on_error_skips_bad_view_and_applies_the_rest(tmp_path):
    # Sorted application order: a_bad.sql fails (missing table), the two later views MUST still apply.
    _write(tmp_path, "a_bad.sql", "CREATE OR REPLACE VIEW brain_serving.mv_bad AS SELECT * FROM no_such_table;")
    _write(tmp_path, "b_ok.sql", "CREATE OR REPLACE VIEW brain_serving.mv_ok AS SELECT 1 AS one;")
    _write(tmp_path, "c_lift.sql", "CREATE OR REPLACE VIEW brain_bronze.lifted AS SELECT 2 AS two;")
    con = duckdb.connect()
    applied, skipped = views.apply_views(con, str(tmp_path))
    assert applied == 2
    assert skipped == ["a_bad.sql"]
    assert con.execute("SELECT one FROM brain_serving.mv_ok").fetchone()[0] == 1
    assert con.execute("SELECT two FROM brain_bronze.lifted").fetchone()[0] == 2


def test_comment_and_semicolon_normalization(tmp_path):
    _write(
        tmp_path, "mv_commented.sql",
        "-- header comment (run-trino-views.sh style)\n"
        "--   more prose\n"
        "\n"
        "CREATE OR REPLACE VIEW brain_serving.mv_commented AS\n"
        "SELECT 42 AS answer  -- inline comment survives (DuckDB parses it)\n"
        ";\n",
    )
    con = duckdb.connect()
    applied, skipped = views.apply_views(con, str(tmp_path))
    assert (applied, skipped) == (1, [])
    assert con.execute("SELECT answer FROM brain_serving.mv_commented").fetchone()[0] == 42


def test_comment_only_file_is_neither_applied_nor_skipped(tmp_path):
    _write(tmp_path, "notes.sql", "-- placeholder, nothing to run\n")
    con = duckdb.connect()
    applied, skipped = views.apply_views(con, str(tmp_path))
    assert (applied, skipped) == (0, [])


def test_reapply_is_idempotent(tmp_path):
    # Every view file is CREATE OR REPLACE — epoch rotation re-applies the whole dir safely.
    _write(tmp_path, "mv_ok.sql", "CREATE OR REPLACE VIEW brain_serving.mv_ok AS SELECT 1 AS one;")
    con = duckdb.connect()
    assert views.apply_views(con, str(tmp_path)) == (1, [])
    assert views.apply_views(con, str(tmp_path)) == (1, [])


if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-q"]))
