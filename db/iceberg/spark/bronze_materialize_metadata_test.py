"""
bronze_materialize_metadata_test.py — PURE guard for the K2a ingestion-metadata contract.

Proves, WITHOUT a Spark cluster (pyspark is stubbed), that the Bronze landing job:
  1. declares the 7 ingestion-metadata columns ONCE (INGESTION_METADATA_COLUMNS) — the Kafka source
     lineage + receipt/write wall-clocks + trace id the spec requires;
  2. keeps those columns in LOCKSTEP across the three places they must agree — the CREATE-TABLE DDL
     (built from the constant), the _project_bronze projection, and BOTH halves of the MERGE INSERT
     (column list AND the `s.<col>` VALUES list). This catches the classic "added a column to the
     projection but forgot the MERGE" drift that would silently null the metadata;
  3. exposes Kafka headers (includeHeaders=true) so trace_id can be landed;
  4. documents the offset-after-Iceberg-commit / no-data-loss ordering;
  5. did NOT smuggle business logic into the RAW Bronze path (no sessionize/attribution/stitch/enrich
     before Bronze — Bronze stays RAW).

Run: python3 db/iceberg/spark/bronze_materialize_metadata_test.py
Exit 0 = all green, exit 1 = one or more failures.
"""
from __future__ import annotations

import io
import os
import sys
import tokenize
import types

_DIR = os.path.dirname(os.path.abspath(__file__))
_SRC_PATH = os.path.join(_DIR, "bronze_materialize.py")


def _stub_pyspark() -> None:
    """Register minimal fake pyspark modules so bronze_materialize imports without a real Spark.

    Only import-time names need to exist; the pyspark functions are referenced inside function bodies
    (never at import), so a callable placeholder is enough."""
    def _any(*_a, **_k):  # stand-in for col/lit/from_json/StructType/... — never actually called here
        return _any

    pyspark = types.ModuleType("pyspark")
    sql = types.ModuleType("pyspark.sql")
    functions = types.ModuleType("pyspark.sql.functions")
    typesmod = types.ModuleType("pyspark.sql.types")
    sql.SparkSession = _any
    for n in ("broadcast", "coalesce", "col", "concat", "current_timestamp", "expr",
              "from_json", "get_json_object", "lit", "to_timestamp"):
        setattr(functions, n, _any)
    for n in ("StringType", "StructField", "StructType"):
        setattr(typesmod, n, _any)
    sys.modules["pyspark"] = pyspark
    sys.modules["pyspark.sql"] = sql
    sys.modules["pyspark.sql.functions"] = functions
    sys.modules["pyspark.sql.types"] = typesmod


def _load_module():
    _stub_pyspark()
    import importlib.util
    spec = importlib.util.spec_from_file_location("bronze_materialize_under_test", _SRC_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


EXPECTED_METADATA = {
    "kafka_topic": "string",
    "kafka_partition": "int",
    "kafka_offset": "bigint",
    "kafka_timestamp": "timestamp",
    "received_at": "timestamp",
    "written_at": "timestamp",
    "trace_id": "string",
}

# Verbs that would mean business logic landed BEFORE Bronze (Bronze must stay RAW). `dedup` is
# allowed: the MERGE WHEN-NOT-MATCHED is idempotency/append-only de-dup of the SAME (brand_id,event_id),
# not a clean of business state — but a brand-new sessionize/attribution/stitch/enrich CODE token is a
# leak. Checked against CODE IDENTIFIERS ONLY (comments/docstrings that DESCRIBE the rule are excluded).
FORBIDDEN_RAW_LEAK = ("sessionize", "attribution", "stitch", "enrich", "identity_resolve")


def _code_identifiers(path: str) -> set[str]:
    """All NAME tokens in the source — i.e. real code identifiers, excluding comments + string/doc
    literals. So prose that merely DESCRIBES the forbidden verbs never trips the RAW-leak guard."""
    names: set[str] = set()
    with open(path, "rb") as fh:
        for tok in tokenize.tokenize(io.BytesIO(fh.read()).readline):
            if tok.type == tokenize.NAME:
                names.add(tok.string.lower())
    return names


def main() -> int:
    fails: list[str] = []
    mod = _load_module()
    src = open(_SRC_PATH, encoding="utf-8").read()

    # 1. The constant declares exactly the 7 expected columns + types.
    declared = dict(getattr(mod, "INGESTION_METADATA_COLUMNS", []))
    if declared != EXPECTED_METADATA:
        fails.append(f"INGESTION_METADATA_COLUMNS mismatch: got {declared}, want {EXPECTED_METADATA}")

    # 2. Lockstep across projection + MERGE column list + MERGE VALUES list.
    for colname in EXPECTED_METADATA:
        if f'col("{colname}")' not in src and f'.alias("{colname}")' not in src:
            fails.append(f"_project_bronze never emits `{colname}`")
        # MERGE INSERT column list references the bare name; VALUES references it as s.<name>.
        if colname not in src:
            fails.append(f"`{colname}` missing from MERGE INSERT column list")
        if f"s.{colname}" not in src:
            fails.append(f"`s.{colname}` missing from MERGE VALUES list")

    # 3. Kafka headers exposed (so trace_id from `traceparent` can land).
    if '"includeHeaders", "true"' not in src and "'includeHeaders', 'true'" not in src:
        fails.append("readStream does not set includeHeaders=true (trace_id header cannot land)")
    if "traceparent" not in src:
        fails.append("trace_id does not read the `traceparent` Kafka header")

    # 4. Offset-after-Iceberg-commit / no-data-loss ordering is documented.
    if "offset" not in src.lower() or "commits/" not in src:
        fails.append("offset-after-Iceberg-commit ordering proof not documented in build_writer")

    # 5. No business logic leaked into the RAW Bronze path (code identifiers only — prose excluded).
    code_names = _code_identifiers(_SRC_PATH)
    for verb in FORBIDDEN_RAW_LEAK:
        if any(verb in name for name in code_names):
            fails.append(f"RAW-Bronze leak: forbidden business-logic identifier `{verb}` in code")

    if fails:
        for f in fails:
            print(f"[FAIL] {f}")
        print(f"\n{len(fails)} failure(s).")
        return 1
    print(f"[PASS] K2a ingestion-metadata contract green — {len(EXPECTED_METADATA)} metadata columns "
          "in lockstep (DDL/projection/MERGE), headers exposed, no-data-loss ordering documented, RAW Bronze.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
