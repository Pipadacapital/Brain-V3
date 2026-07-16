"""
views.py — the serving-view applier (duckdb-serving, plan §A2).

Applies every db/iceberg/duckdb/views/*.sql (the DuckDB port of db/trino/views/*.sql) into the
LOCAL `brain_serving` schema of an epoch's connection — plus `brain_bronze` for the collector
lift view. The catalog attaches as `iceberg`, and DuckDB resolves an unqualified two-part
`brain_serving.mv_x` to the LOCAL schema over the catalog namespace (spike gate d), so the
metric SQL's `FROM brain_serving.mv_*` reads these views verbatim while their bodies'
`iceberg.brain_gold.*` refs reach the catalog.

CONTINUE-ON-ERROR (parity with run-trino-views.sh): a view over a Gold mart that has not been
built yet (fresh boot, refresh not there yet) must NOT abort the whole serving layer — every
view whose dependencies DO exist is still created; failures are tallied and returned so
/readyz reports `views_skipped` and the next epoch rotation retries them (the self-heal role
of rotation — freshness does NOT need it, spike gate b). An EMPTY or missing views dir is a
valid state (the views land in a parallel workstream): 0 applied, 0 skipped, still ready.
"""
from __future__ import annotations

import glob
import os

# db/iceberg/duckdb/views/ — sibling of serving/, populated by the views port (plan §B).
DEFAULT_VIEWS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "views")

# Local schemas the views are created INTO (shadowing the catalog namespaces of the same name):
# brain_serving for the mv_*/identity views, brain_bronze for collector_events_connect_lifted.
LOCAL_SCHEMAS = ("brain_serving", "brain_bronze")


def strip_sql(text: str) -> str:
    """Strip full-line `--` comments, blank lines, and the trailing ';' — the same normalization
    run-trino-views.sh applied before POSTing one bare statement (inline comments are left alone;
    DuckDB parses them natively)."""
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("--")]
    return "\n".join(lines).rstrip().rstrip(";").rstrip()


def apply_views(con, views_dir: str | None = None) -> tuple[int, list[str]]:
    """
    Create the local schemas, then apply every *.sql in `views_dir` (sorted — deterministic
    order) with continue-on-error. Returns (applied_count, skipped_basenames).
    """
    for schema in LOCAL_SCHEMAS:
        con.execute(f"CREATE SCHEMA IF NOT EXISTS {schema};")

    vdir = views_dir if views_dir is not None else DEFAULT_VIEWS_DIR
    applied = 0
    skipped: list[str] = []
    for path in sorted(glob.glob(os.path.join(vdir, "*.sql"))):
        base = os.path.basename(path)
        with open(path, encoding="utf-8") as f:
            sql = strip_sql(f.read())
        if not sql:
            continue  # comment-only / empty file — nothing to apply, not a skip
        try:
            con.execute(sql)
            applied += 1
        except Exception as exc:  # noqa: BLE001 — per-view failure must not abort the serving layer
            skipped.append(base)
            print(f"views: skipped {base} (dependency not ready?): {exc}", flush=True)
    return applied, skipped
