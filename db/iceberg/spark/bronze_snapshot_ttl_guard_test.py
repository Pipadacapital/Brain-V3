"""
bronze_snapshot_ttl_guard_test.py — Brain V4 CI guard: the AUD-OPS-015 recovery-window posture for
Bronze snapshot expiry can never silently regress.

WHY THIS EXISTS
  AUD-OPS-015 (audit/04-operational-gaps.md): the Iceberg time-travel recovery window on the whole
  Bronze namespace was ~7 days — a bad Silver/Gold job or erroneous delete discovered later could
  only be recovered via untooled S3 noncurrent-version restoration. The fix gives the DURABLE
  collector lane (brain_bronze.collector_events_connect — the append-only system-of-record whose
  rows are NEVER deleted: "no event loss") a 14-day snapshot window (audit range 14-30d), while the
  PII *_raw_connect lanes deliberately KEEP the short default — their 7-day D4 retention
  (bronze_raw_retention.py) is a privacy contract and a long time-travel window would resurrect
  purged raw PII.

WHAT THIS GUARD ASSERTS (all static — source/values reads, no Spark needed, runnable in CI)
  1. DURABLE WINDOW — bronze_maintenance.py defines DURABLE_SNAPSHOT_TTL_MS with a default in the
     audit-mandated 14-30 day range, and DURABLE_TABLES defaults to exactly the collector lane.
  2. APPLIED IN THE SWEEP — maintain() selects the durable TTL for durable tables (the constant is
     not dead config).
  3. RAW LANES UNCHANGED — the general SNAPSHOT_TTL_MS default stays 7 days (privacy window for the
     raw lanes must not be silently widened by this mechanism).
  4. RTBF NOT WEAKENED — erase mode still expires with ttl_ms=0 (immediate purge of pre-deletion
     snapshots on the durable table; the longer window never protects erased data).
  5. AUDITABLE FROM VALUES — infra/helm/cronworkflows/values.yaml pins DURABLE_SNAPSHOT_TTL_MS to
     the same value as the code default and pins DURABLE_TABLES to the collector lane.

Runs as a plain script (exit 1 on failure) AND under pytest (test_* functions), same shape as
db/iceberg/spark/erasure_payload_path_guard_test.py.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

# ── Locate the sources (repo-root-relative, robust to cwd) ───────────────────────────────────────
_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[2]  # db/iceberg/spark -> repo root
MAINTENANCE_SRC = (_HERE / "bronze_maintenance.py").read_text(encoding="utf-8")
VALUES_YAML = (_REPO_ROOT / "infra" / "helm" / "cronworkflows" / "values.yaml").read_text(
    encoding="utf-8"
)

_DAY_MS = 86_400_000
_COLLECTOR_LANE = "collector_events_connect"


def _env_int_default(src: str, name: str) -> int:
    """Extract int(os.environ.get('<name>', str(<literal>))) default via AST."""
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            continue
        for call in ast.walk(node.value):
            if (
                isinstance(call, ast.Call)
                and isinstance(call.func, ast.Attribute)
                and call.func.attr == "get"
                and len(call.args) == 2
                and isinstance(call.args[0], ast.Constant)
                and call.args[0].value == name
            ):
                default = call.args[1]
                # str(<int literal>) wrapper
                if (
                    isinstance(default, ast.Call)
                    and isinstance(default.func, ast.Name)
                    and default.func.id == "str"
                    and isinstance(default.args[0], ast.Constant)
                ):
                    return int(default.args[0].value)
                if isinstance(default, ast.Constant):
                    return int(default.value)
    raise AssertionError(f"could not find env-default assignment for {name}")


def test_durable_ttl_default_in_audit_range() -> None:
    ttl = _env_int_default(MAINTENANCE_SRC, "DURABLE_SNAPSHOT_TTL_MS")
    assert 14 * _DAY_MS <= ttl <= 30 * _DAY_MS, (
        f"DURABLE_SNAPSHOT_TTL_MS default {ttl}ms is outside the AUD-OPS-015 14-30 day range"
    )


def test_durable_tables_default_is_collector_lane() -> None:
    m = re.search(r'DURABLE_TABLES"\s*,\s*"([^"]+)"', MAINTENANCE_SRC)
    assert m, "DURABLE_TABLES env default not found in bronze_maintenance.py"
    tables = {t.strip() for t in m.group(1).split(",") if t.strip()}
    assert tables == {_COLLECTOR_LANE}, (
        f"DURABLE_TABLES default must be exactly the durable SoR lane, got {tables} — "
        "adding a *_raw_connect PII lane here would widen its privacy window"
    )


def test_maintain_applies_durable_ttl() -> None:
    assert re.search(
        r"DURABLE_SNAPSHOT_TTL_MS\s+if\s+\w+\s+in\s+DURABLE_TABLES\s+else\s+SNAPSHOT_TTL_MS",
        MAINTENANCE_SRC,
    ), "maintain() no longer selects the durable TTL per table — AUD-OPS-015 mechanism is dead config"


def test_default_snapshot_ttl_still_seven_days() -> None:
    ttl = _env_int_default(MAINTENANCE_SRC, "SNAPSHOT_TTL_MS")
    assert ttl == 7 * _DAY_MS, (
        f"general SNAPSHOT_TTL_MS default changed to {ttl}ms — the raw-lane (PII) window must stay "
        "7d; only DURABLE_TABLES get the long window"
    )


def test_erase_mode_still_purges_immediately() -> None:
    assert re.search(r"_expire\(\s*spark\s*,\s*ttl_ms=0\s*\)", MAINTENANCE_SRC), (
        "erase() must keep _expire(spark, ttl_ms=0) — RTBF purges pre-deletion snapshots "
        "immediately regardless of the durable window"
    )


def test_helm_values_pin_matches_code_default() -> None:
    ttl_code = _env_int_default(MAINTENANCE_SRC, "DURABLE_SNAPSHOT_TTL_MS")
    m = re.search(r'name:\s*DURABLE_SNAPSHOT_TTL_MS,\s*value:\s*"(\d+)"', VALUES_YAML)
    assert m, "cronworkflows values.yaml no longer pins DURABLE_SNAPSHOT_TTL_MS (auditability)"
    assert int(m.group(1)) == ttl_code, (
        f"values.yaml pins {m.group(1)}ms but code default is {ttl_code}ms — keep them in lockstep"
    )
    m2 = re.search(r'name:\s*DURABLE_TABLES,\s*value:\s*"([^"]+)"', VALUES_YAML)
    assert m2, "cronworkflows values.yaml no longer pins DURABLE_TABLES"
    assert m2.group(1) == _COLLECTOR_LANE


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
    raise SystemExit(1 if failures else 0)
