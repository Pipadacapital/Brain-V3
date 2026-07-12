"""
bronze_collector_partition_migrate_guard_test.py — AUD-IMPL-025 guards for the one-time
collector-Bronze partition migration (pure — no Spark session; source reads + pure-helper calls).

WHAT THIS ASSERTS
  1. IDEMPOTENCY PARSER — partition_fields_from_describe() correctly extracts the Iceberg
     `# Partitioning` section from DESCRIBE rows (present, absent, and multi-field cases), and
     has_partition_on() matches days()/day() transforms on kafka_timestamp — so a re-run after a
     successful apply is a no-op, never a duplicate-field ALTER failure.
  2. DRY-RUN GATE — the job source applies the ALTER ONLY behind the PARTITION_MIGRATE_EXECUTE=1
     env gate (the prod run is an explicit apply decision; the default invocation is a dry run).
  3. APPEND-ONLY BRONZE — the job source contains no INSERT/UPDATE/DELETE/MERGE statement: a
     metadata-only migration must never touch a Bronze row.
  4. WATERMARK PAIRING — silver_collector_event.py actually consumes the physical column this
     migration partitions on (a kafka_timestamp watermark read + a silver_job_watermark write),
     so the partition spec and the incremental filter can never drift apart silently.

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions) — same shape as
erasure_payload_path_guard_test.py.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

MIGRATE_SRC = (HERE / "bronze_collector_partition_migrate.py").read_text(encoding="utf-8")
SILVER_SRC = (HERE / "silver" / "silver_collector_event.py").read_text(encoding="utf-8")

# Extract ONLY the pure helpers via AST + exec — importing the job module would pull in pyspark,
# which this static CI guard must not require (same no-Spark posture as the sibling guard tests).
_ns: dict = {}
for _node in ast.parse(MIGRATE_SRC).body:
    if isinstance(_node, ast.FunctionDef) and _node.name in (
        "partition_fields_from_describe",
        "has_partition_on",
    ):
        exec(compile(ast.Module(body=[_node], type_ignores=[]), "<partition-migrate-guard>", "exec"), _ns)
partition_fields_from_describe = _ns["partition_fields_from_describe"]
has_partition_on = _ns["has_partition_on"]


def test_describe_parser_unpartitioned() -> None:
    rows = [
        ("payload", "string"),
        ("kafka_topic", "string"),
        ("kafka_timestamp", "timestamp"),
    ]
    assert partition_fields_from_describe(rows) == []
    assert not has_partition_on([], "kafka_timestamp")


def test_describe_parser_partitioned() -> None:
    rows = [
        ("payload", "string"),
        ("kafka_timestamp", "timestamp"),
        ("", ""),
        ("# Partitioning", ""),
        ("Part 0", "days(kafka_timestamp)"),
    ]
    fields = partition_fields_from_describe(rows)
    assert fields == ["days(kafka_timestamp)"]
    assert has_partition_on(fields, "kafka_timestamp")
    # day() (the Connect auto-create spelling) matches too — idempotent across writers.
    assert has_partition_on(["day(kafka_timestamp)"], "kafka_timestamp")


def test_describe_parser_ignores_metadata_sections() -> None:
    # A `# Metadata Columns`-style section after Partitioning must not leak rows into the fields.
    rows = [
        ("kafka_timestamp", "timestamp"),
        ("# Partitioning", ""),
        ("Part 0", "bucket(16, brand_id)"),
        ("Part 1", "days(kafka_timestamp)"),
        ("# Metadata Columns", ""),
        ("_spec_id", "int"),
    ]
    fields = partition_fields_from_describe(rows)
    assert fields == ["bucket(16, brand_id)", "days(kafka_timestamp)"]
    assert has_partition_on(fields, "kafka_timestamp")
    assert not has_partition_on(["bucket(16, brand_id)"], "kafka_timestamp")


def test_execute_gate_present() -> None:
    assert 'PARTITION_MIGRATE_EXECUTE' in MIGRATE_SRC, "the dry-run/apply gate is gone"
    assert 'os.environ.get("PARTITION_MIGRATE_EXECUTE", "") == "1"' in MIGRATE_SRC, (
        "the apply gate must be an explicit ==\"1\" opt-in (dry run by default)"
    )


def test_append_only_bronze() -> None:
    # Every spark.sql(...) in the job must be read-only or metadata-only: DESCRIBE / SELECT /
    # ALTER (the ADD PARTITION FIELD). No INSERT/UPDATE/DELETE/MERGE may ever touch a Bronze row.
    allowed = {"DESCRIBE", "SELECT", "ALTER"}
    seen = []
    for node in ast.walk(ast.parse(MIGRATE_SRC)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "sql"):
            continue
        arg = node.args[0] if node.args else None
        text = ""
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            text = arg.value
        elif isinstance(arg, ast.JoinedStr):  # f-string: concatenate the static parts
            text = "".join(v.value for v in arg.values if isinstance(v, ast.Constant) and isinstance(v.value, str))
        elif isinstance(arg, ast.Name):  # a named statement (PARTITION_DDL) — resolve from source
            text = "ALTER" if arg.id == "PARTITION_DDL" else arg.id
        first = text.strip().split(None, 1)[0].upper() if text.strip() else "<empty>"
        seen.append(first)
        assert first in allowed, f"spark.sql statement kind '{first}' is not read/metadata-only"
    assert "ALTER" in seen, "the ADD PARTITION FIELD ALTER disappeared from the job"
    assert "ALTER TABLE" in MIGRATE_SRC and "ADD PARTITION FIELD days(" in MIGRATE_SRC


def test_silver_watermark_pairing() -> None:
    # The Silver incremental must filter on the PHYSICAL kafka_timestamp (pushdown/pruning) and
    # track it through the silver_job_watermark side-table — the whole point of the partition spec.
    assert 'col("kafka_timestamp")' in SILVER_SRC, "silver_collector_event no longer selects kafka_timestamp"
    assert 'read_job_watermark(spark, "silver_collector_event")' in SILVER_SRC
    assert 'write_job_watermark(spark, "silver_collector_event"' in SILVER_SRC
    # Legacy upgrade path retained: one target-derived ingested_at run when no side-table mark exists.
    assert "max(ingested_at) AS wm FROM" in SILVER_SRC


def main() -> None:
    failures = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures.append(f"{name}: {exc}")
                print(f"FAIL {name}: {exc}")
    if failures:
        sys.exit(1)
    print("bronze_collector_partition_migrate_guard_test: ALL PASS")


if __name__ == "__main__":
    main()
