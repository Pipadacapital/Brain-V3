# SPEC: A.1.4
"""
backfill_interop_hashes_guard_test.py — WA-10 CI guard: the one-off interop-hash backfill's
SQL invariants can never silently regress. (Unit-shape validation ONLY — per WA-10 this job is
NOT run against live data as part of acceptance.)

WHAT THIS GUARD ASSERTS (all static — source/import reads, no Spark/PG/Redis needed):
  1. COMPILES — the job module byte-compiles and imports Spark-free at module level (the pure
     builders are callable without a SparkSession).
  2. MERGE IDEMPOTENCY + TENANT-FIRST — the MERGE targets the additive side table, its ON clause
     covers the FULL grain (brand_id, source, order_id) with brand_id as the FIRST key, and it
     contains no DELETE clause (additive-only).
  3. SHREDDED-SUBJECT SKIP — the erased-identifier query joins identity.pii_erasure_log (the RTBF
     crypto-shred ledger) to ops.silver_identity_link, and the build path ANTI-JOINs it for BOTH
     the email and phone internal hashes.
  4. FLAG GATE — the job gates on exactly `connector.identity_fields` via _platform_flags
     (DEFAULT-OFF / fail-closed semantics live in that module and its own test).
  5. RAW LANES ONLY + NO RAW PII STORED — every source lane is a `*_raw` Connect lane read via
     rn.read_bronze, and the target column set carries ONLY the interop hashes (no raw_email /
     raw_phone / internal salted hash columns).

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions), same shape as
erasure_payload_path_guard_test.py.
"""
from __future__ import annotations

import py_compile
import re
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
SPARK_DIR = _THIS.parent  # db/iceberg/spark
JOB_FILE = SPARK_DIR / "backfill_interop_hashes.py"

sys.path.insert(0, str(SPARK_DIR))


def _job_source() -> str:
    return JOB_FILE.read_text(encoding="utf-8")


def _import_job():
    import importlib

    return importlib.import_module("backfill_interop_hashes")


# ── 1. compiles + imports (module level is Spark-free) ────────────────────────────────────────────
def test_job_compiles_and_imports():
    py_compile.compile(str(JOB_FILE), doraise=True)
    job = _import_job()
    assert callable(job.build_merge_sql)
    assert callable(job.build_erased_identifiers_query)


# ── 2. MERGE: additive, full-grain, brand_id-FIRST ────────────────────────────────────────────────
def test_merge_is_idempotent_tenant_first_and_additive():
    job = _import_job()
    sql = job.build_merge_sql("cat.ns.silver_order_interop_identifier", "interop_src")
    flat = " ".join(sql.split())

    on = re.search(r"\bON\s+(.+?)\s+WHEN\b", flat, re.IGNORECASE)
    assert on, f"MERGE has no ON clause: {flat}"
    on_clause = on.group(1)
    # brand_id is the FIRST key of the ON clause (tenant isolation invariant).
    assert on_clause.lower().startswith("t.brand_id = s.brand_id"), on_clause
    # Full grain key — a partial key would make re-runs non-idempotent (row fan-out).
    for key in ("t.source = s.source", "t.order_id = s.order_id"):
        assert key in on_clause, f"MERGE ON missing grain key {key}: {on_clause}"
    # Additive-only: no DELETE arm.
    assert "delete" not in flat.lower(), f"MERGE must not delete: {flat}"
    # Both arms present (idempotent upsert).
    assert re.search(r"WHEN MATCHED THEN UPDATE", flat, re.IGNORECASE)
    assert re.search(r"WHEN NOT MATCHED THEN INSERT", flat, re.IGNORECASE)


# ── 3. shredded-subject skip is ledger-encoded ────────────────────────────────────────────────────
def test_erased_query_joins_the_erasure_ledger():
    job = _import_job()
    q = job.build_erased_identifiers_query()
    assert "identity.pii_erasure_log" in q, q
    assert "ops.silver_identity_link" in q, q
    # brand_id leads the join predicate (tenant-first).
    assert re.search(r"ON\s+l\.brand_id\s*=\s*e\.brand_id", q), q
    assert "l.brain_id = e.brain_id" in q, q


def test_build_path_anti_joins_both_identifier_kinds():
    src = _job_source()
    # The anti-join is applied for BOTH internal hashes (email + phone).
    assert src.count('"left_anti"') >= 2, "expected left_anti joins for email AND phone hashes"
    assert '"internal_email"' in src and '"internal_phone"' in src


# ── 4. flag gate ───────────────────────────────────────────────────────────────────────────────────
def test_flag_gate_is_connector_identity_fields():
    job = _import_job()
    assert job.IDENTITY_FIELDS_FLAG == "connector.identity_fields"
    src = _job_source()
    assert "is_flag_enabled" in src, "flag gate must go through _platform_flags.is_flag_enabled"


# ── 5. raw lanes only + no raw PII stored ─────────────────────────────────────────────────────────
def test_lanes_are_raw_connect_and_target_stores_no_raw_pii():
    job = _import_job()
    assert set(job.LANES) == {"shopify_orders_raw", "woocommerce_orders_raw"}
    for lane_table, lane in job.LANES.items():
        assert lane_table.endswith("_raw"), lane_table  # rn.read_bronze appends `_connect`
        for k in ("source", "order_id_path", "email_path", "phone_path"):
            assert lane.get(k), (lane_table, k)
    cols = job.TARGET_COLUMNS_SQL.lower()
    for forbidden in ("raw_email", "raw_phone", "internal_email", "internal_phone", "salt"):
        assert forbidden not in cols, f"target must not store {forbidden}"
    for required in ("brand_id", "source", "order_id", "email_sha256", "phone_sha256", "derived_at"):
        assert required in cols, f"target missing {required}"
    # brand_id is the first column (tenant-first convention).
    assert cols.split()[0] == "brand_id", cols.split()[:2]


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    sys.exit(1 if failures else 0)
