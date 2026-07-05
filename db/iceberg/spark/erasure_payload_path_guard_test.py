"""
erasure_payload_path_guard_test.py — Brain V4 CI guard: the ADR-0010 RTBF posture for the
payload-only Bronze SoR can never silently regress.

WHY THIS EXISTS
  brain_bronze.collector_events_connect is payload-only (verbatim envelope JSON string + kafka
  coordinates — no lifted identifier columns), so erasure_raw_delete.py's column-equality DELETEs
  cannot target it. The 2026-07-05 fix added PAYLOAD-PATH PREDICATE ERASURE (PAYLOAD_PATH_TABLES /
  erase_subject_payload_path): per-subject DELETEs whose predicates are get_json_object() reads on
  the envelope's grounded identifier paths, tenant-scoped on the envelope's $.brand_id. In the same
  step the legacy Bronze generation (brain_bronze.events, collector_events, collector_events_raw +
  the 9 per-connector *_raw) was DROPPED (unify-bronze-decommission Step 3 executed), so neither
  GDPR job may keep listing those tables.

WHAT THIS GUARD ASSERTS (all static — source/AST reads, no Spark/Trino needed, runnable in CI)
  1. PAYLOAD-PATH SCOPE — PAYLOAD_PATH_TABLES targets EXACTLY collector_events_connect, and that
     table is NOT in the column-equality map (a lifted-column DELETE against a payload-only table
     silently deletes nothing).
  2. GET_JSON_OBJECT PREDICATES — the payload-path DELETE is built ONLY from get_json_object()
     predicates on '$.'-rooted JSON paths (never a bare column-equality on the payload table).
  3. TENANT SCOPING — every DELETE in BOTH mechanisms is brand-scoped: the column-equality DELETE
     leads with `WHERE brand_id = '<brand_id>'`; the payload-path DELETE leads with
     `get_json_object(payload, '$.brand_id') = '<brand_id>'` (the table has no brand_id column).
     Erasure must never cross tenants.
  4. LEGACY TABLES GONE — no legacy table name in either job's table list, no UNIFIED_EVENTS_TABLE
     row-TTL block, and every remaining raw table is a *_raw_connect lane.
  5. ROW-TTL EXCLUSION — collector_events_connect stays OUT of bronze_raw_retention.py's RAW_TABLES
     (system-of-record event stream: "Bronze is source of truth / no event loss") and the exclusion
     stays documented in that file.

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions), same shape as
db/iceberg/spark/silver/gate_admission_guard_test.py.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

# ── Locate the job sources (repo-root-relative, robust to cwd) ────────────────────────────────────
_THIS = Path(__file__).resolve()
SPARK_DIR = _THIS.parent  # db/iceberg/spark
ERASURE_FILE = SPARK_DIR / "erasure_raw_delete.py"
RETENTION_FILE = SPARK_DIR / "bronze_raw_retention.py"

# The dropped legacy generation (unify-bronze-decommission Step 3, executed 2026-07-05). None of
# these may appear in either job's TABLE LISTS (comments noting the drop are fine).
LEGACY_TABLE_NAMES = frozenset(
    {
        "events",                # brain_bronze.events — the retired unified Spark-SS landing table
        "collector_events",      # the retired Spark-SS collector lane
        "collector_events_raw",
        "shopify_orders_raw",
        "woocommerce_orders_raw",
        "meta_spend_raw",
        "google_spend_raw",
        "ga4_rows_raw",
        "shiprocket_shipments_raw",
        "gokwik_events_raw",
        "shopflo_checkout_raw",
        "razorpay_settlement_raw",
    }
)

PAYLOAD_ONLY_TABLE = "collector_events_connect"


# ── AST extraction helpers ─────────────────────────────────────────────────────────────────────────
def _module(path: Path) -> ast.Module:
    return ast.parse(path.read_text())


def _find_assign(path: Path, name: str) -> ast.expr:
    """The value expression assigned to module-level `name` (plain or annotated assignment)."""
    for node in ast.walk(_module(path)):
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id == name:
                    return node.value
        if isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and node.target.id == name and node.value is not None:
                return node.value
    raise AssertionError(f"could not find a module-level assignment `{name}` in {path}")


def _dict_str_keys(path: Path, name: str) -> set:
    value = _find_assign(path, name)
    assert isinstance(value, ast.Dict), f"`{name}` in {path} is not a dict literal"
    return {k.value for k in value.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)}


def _list_str(path: Path, name: str) -> list:
    value = _find_assign(path, name)
    assert isinstance(value, (ast.List, ast.Tuple, ast.Set)), f"`{name}` in {path} is not a list literal"
    return [el.value for el in value.elts if isinstance(el, ast.Constant) and isinstance(el.value, str)]


def _payload_spec(table: str) -> dict:
    """The literal spec dict for one PAYLOAD_PATH_TABLES entry (paths only; strings/lists)."""
    value = _find_assign(ERASURE_FILE, "PAYLOAD_PATH_TABLES")
    assert isinstance(value, ast.Dict)
    for k, v in zip(value.keys, value.values):
        if isinstance(k, ast.Constant) and k.value == table:
            return ast.literal_eval(v)
    raise AssertionError(f"PAYLOAD_PATH_TABLES has no entry for {table}")


def _strip_comments(src: str) -> str:
    """Source with `# … EOL` comments removed — so a table name in a drop-note comment never trips
    the 'legacy tables gone' scan. (No string literal in either job contains a '#'.)"""
    return "\n".join(re.sub(r"#.*$", "", line) for line in src.splitlines())


# ── The checks ─────────────────────────────────────────────────────────────────────────────────────
def check_payload_path_targets_connect_table_only():
    tables = _dict_str_keys(ERASURE_FILE, "PAYLOAD_PATH_TABLES")
    assert tables == {PAYLOAD_ONLY_TABLE}, (
        f"PAYLOAD_PATH_TABLES must target EXACTLY {PAYLOAD_ONLY_TABLE} (the payload-only Bronze SoR); "
        f"got: {sorted(tables)}"
    )
    col_tables = _dict_str_keys(ERASURE_FILE, "RAW_TABLE_IDENTIFIER_COLS")
    assert PAYLOAD_ONLY_TABLE not in col_tables, (
        f"{PAYLOAD_ONLY_TABLE} is payload-only — a column-equality DELETE silently deletes nothing; "
        "it must live ONLY in PAYLOAD_PATH_TABLES"
    )


def check_payload_delete_uses_get_json_object_predicates():
    spec = _payload_spec(PAYLOAD_ONLY_TABLE)
    # Every declared path is a '$.'-rooted JSON path (payload-internal — never a column name).
    paths = [spec["brand_path"], *spec["hash_paths"], *spec["anon_paths"], *spec["device_paths"]]
    bad = [p for p in paths if not (isinstance(p, str) and p.startswith("$."))]
    assert not bad, f"non-JSON-path entries in the {PAYLOAD_ONLY_TABLE} spec: {bad}"

    src = ERASURE_FILE.read_text()
    fn = src[src.index("def erase_subject_payload_path") : src.index("# ── Entry point")]
    # The subject + brand predicates are get_json_object reads, and the DELETE template composes them.
    assert "get_json_object(payload, {_sql_str(spec['brand_path'])})" in fn, (
        "payload-path brand predicate must be a get_json_object read of the envelope brand path"
    )
    assert fn.count("get_json_object(payload, {_sql_str(p)})") >= 2, (
        "payload-path subject predicates (hash paths + IN-list raw-id paths) must be get_json_object reads"
    )
    assert 'f"DELETE FROM {fqtn} WHERE {brand_pred} AND ({subject_pred})"' in fn, (
        "payload-path DELETE template changed — it must be brand-predicate-first over get_json_object predicates"
    )


def check_brand_scoping_in_every_delete():
    src = ERASURE_FILE.read_text()
    # Column-equality mechanism: brand_id column is ALWAYS the first predicate.
    assert "WHERE brand_id = '{brand_id}'" in src, (
        "column-equality DELETE lost its brand_id-first tenant scoping"
    )
    # Payload-path mechanism: the envelope $.brand_id is the tenant seam (no brand_id column exists).
    spec = _payload_spec(PAYLOAD_ONLY_TABLE)
    assert spec["brand_path"] == "$.brand_id", (
        f"payload-path brand seam must be the envelope's $.brand_id; got {spec['brand_path']!r}"
    )
    fn = src[src.index("def erase_subject_payload_path") : src.index("# ── Entry point")]
    assert "WHERE {brand_pred} AND" in fn, (
        "payload-path DELETE must lead with the brand predicate (tenant isolation invariant)"
    )


def check_legacy_tables_absent_from_both_jobs():
    erasure_tables = _dict_str_keys(ERASURE_FILE, "RAW_TABLE_IDENTIFIER_COLS")
    retention_tables = set(_list_str(RETENTION_FILE, "RAW_TABLES"))

    for job, tables in (("erasure_raw_delete.py", erasure_tables), ("bronze_raw_retention.py", retention_tables)):
        leftover = tables & LEGACY_TABLE_NAMES
        assert not leftover, (
            f"{job} still lists DROPPED legacy Bronze tables (unify-bronze-decommission Step 3 "
            f"executed 2026-07-05): {sorted(leftover)}"
        )
        non_connect = {t for t in tables if not t.endswith("_raw_connect")}
        assert not non_connect, (
            f"{job} lists non-*_raw_connect tables — only the ADR-0010 Connect generation remains: "
            f"{sorted(non_connect)}"
        )

    # The unified brain_bronze.events row-TTL block must be gone with its table.
    retention_code = _strip_comments(RETENTION_FILE.read_text())
    assert "UNIFIED_EVENTS_TABLE" not in retention_code, (
        "bronze_raw_retention.py still carries the UNIFIED_EVENTS_TABLE row-TTL block for the "
        "dropped brain_bronze.events table"
    )


def check_collector_connect_excluded_from_row_ttl():
    retention_tables = set(_list_str(RETENTION_FILE, "RAW_TABLES"))
    assert PAYLOAD_ONLY_TABLE not in retention_tables, (
        f"{PAYLOAD_ONLY_TABLE} is the system-of-record event stream (no event loss) — it must NEVER "
        "be row-TTL'd by bronze_raw_retention.py"
    )
    # The exclusion must stay documented (the 'DELIBERATELY NOT here' comment).
    assert PAYLOAD_ONLY_TABLE in RETENTION_FILE.read_text(), (
        f"bronze_raw_retention.py no longer documents why {PAYLOAD_ONLY_TABLE} is excluded from row TTL"
    )


_CHECKS = [
    ("payload_path_targets_connect_table_only", check_payload_path_targets_connect_table_only),
    ("payload_delete_uses_get_json_object_predicates", check_payload_delete_uses_get_json_object_predicates),
    ("brand_scoping_in_every_delete", check_brand_scoping_in_every_delete),
    ("legacy_tables_absent_from_both_jobs", check_legacy_tables_absent_from_both_jobs),
    ("collector_connect_excluded_from_row_ttl", check_collector_connect_excluded_from_row_ttl),
]


# pytest entrypoints (one test per check, for granular CI output)
def test_payload_path_targets_connect_table_only():
    check_payload_path_targets_connect_table_only()


def test_payload_delete_uses_get_json_object_predicates():
    check_payload_delete_uses_get_json_object_predicates()


def test_brand_scoping_in_every_delete():
    check_brand_scoping_in_every_delete()


def test_legacy_tables_absent_from_both_jobs():
    check_legacy_tables_absent_from_both_jobs()


def test_collector_connect_excluded_from_row_ttl():
    check_collector_connect_excluded_from_row_ttl()


def main() -> int:
    failures = []
    for name, fn in _CHECKS:
        try:
            fn()
            print(f"[erasure-payload-path-guard] PASS  {name}")
        except AssertionError as exc:
            failures.append(name)
            print(f"[erasure-payload-path-guard] FAIL  {name}\n{exc}\n")
    if failures:
        print(f"[erasure-payload-path-guard] FAILED ({len(failures)}): {', '.join(failures)}")
        return 1
    print("[erasure-payload-path-guard] OK — payload-path RTBF posture + legacy-drop invariants intact.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
