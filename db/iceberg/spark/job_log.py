"""
job_log.py — ONE structured (JSON) line per Spark job, for the Brain V4 V4-pipeline observability slice.

WHY (the gap this closes): every Silver/Gold Spark job today prints a free-text "[job] DONE — … rows"
line. That is human-readable but NOT machine-parseable, carries no duration, no MERGE-upserted count, no
brand-agnostic in/out row counts, and no success/fail discriminant — so the v4-refresh-loop (and any log
shipper) cannot turn a refresh cycle into per-job metrics. This module adds a SINGLE structured line per
job, additively, without changing any job's transform or its return contract.

WHAT it emits (one line, stdout, JSON):
    {"evt":"spark_job","job":"silver-payment","status":"ok",
     "rows_in":1234,"rows_out":1180,"merge_upserted":42,"duration_ms":8123,
     "namespace":"rest.brain_silver","table":"silver_payment","ts":"2026-06-26T…Z"}

  - job            : the job's app_name (e.g. "silver-payment", "gold-funnel").
  - status         : "ok" | "fail".
  - rows_in        : brand-AGNOSTIC count of source rows the job staged this run (best-effort; -1 if the
                     job did not record one — additive, never blocks).
  - rows_out       : the final target-table row count (the number the legacy "DONE — N rows" printed).
  - merge_upserted : rows the MERGE actually inserted+updated this run (captured at the merge seam).
  - duration_ms    : wall-clock of build_fn.
  - namespace/table: parsed from the fully-qualified target ("rest.brain_silver.silver_payment").

HARD RULES honored: brand-AGNOSTIC by design — these are pipeline-health counts, NOT per-brand reads, so
no brand_id / tenant predicate is involved and NO money or PII is ever emitted (counts + identifiers only).
Purely ADDITIVE + observable: it imports nothing job-specific, changes no transform, and a failure to emit
a metric NEVER fails the job (every accessor is best-effort).

CORRELATION: the orchestrator (v4-refresh-loop.sh / the stream-worker) sets V4_CORRELATION_ID in the job's
environment; if present it is echoed on every line so a whole refresh cycle's job lines share one id — the
Spark-side half of the repo's correlation_id/brand_id child-logger discipline (the worker binds the same id
into its child logger when it shells out — see apps/stream-worker).
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer annotation eval.

import json
import os
import sys
import time
from datetime import datetime, timezone


class JobMetrics:
    """A tiny per-run, brand-AGNOSTIC counter bag the merge seams + build_fn write into.

    Best-effort: every field defaults to a sentinel so a job that records nothing still emits a valid
    line. `merge_upserted` accumulates across multiple MERGE calls in one job (a job may merge >1 table).
    """

    def __init__(self) -> None:
        self.rows_in: int = -1          # source rows staged this run (best-effort; -1 = not recorded)
        self.merge_upserted: int = 0    # rows the MERGE inserted+updated this run (summed over merges)

    def add_rows_in(self, n: int) -> None:
        # A job may stage from several sources; take the running max as the "in" signal (best-effort).
        try:
            n = int(n)
        except (TypeError, ValueError):
            return
        self.rows_in = n if self.rows_in < 0 else max(self.rows_in, n)

    def add_upserted(self, n: int) -> None:
        try:
            self.merge_upserted += int(n)
        except (TypeError, ValueError):
            pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _split_fqtn(fqtn: str | None) -> tuple[str | None, str | None]:
    """'rest.brain_silver.silver_payment' → ('rest.brain_silver', 'silver_payment'). Best-effort."""
    if not fqtn or not isinstance(fqtn, str):
        return None, None
    parts = fqtn.rsplit(".", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return None, fqtn


def emit_job_log(
    job: str,
    *,
    status: str,
    rows_out: int | None = None,
    metrics: JobMetrics | None = None,
    fqtn: str | None = None,
    duration_ms: int | None = None,
    error: str | None = None,
) -> None:
    """Print exactly ONE structured JSON line for the job. Never raises (best-effort observability)."""
    ns, table = _split_fqtn(fqtn)
    line = {
        "evt": "spark_job",
        "job": job,
        "status": status,
        "rows_in": (metrics.rows_in if metrics else -1),
        "rows_out": (int(rows_out) if rows_out is not None else -1),
        "merge_upserted": (metrics.merge_upserted if metrics else 0),
        "duration_ms": (int(duration_ms) if duration_ms is not None else -1),
        "namespace": ns,
        "table": table,
        "correlation_id": os.environ.get("V4_CORRELATION_ID") or None,
        "ts": _now_iso(),
    }
    if error:
        line["error"] = error[:500]  # bounded — never dump a stack into a metric line
    try:
        print(json.dumps(line, default=str), flush=True)
    except Exception:  # noqa: BLE001 — observability must never break the job
        pass


def observed_run(app_name: str, build_fn) -> JobMetrics:
    """Time + observe a Spark job's build_fn and emit ONE structured line.

    `build_fn(spark, metrics)` is called with the active SparkSession and a JobMetrics bag it (and the
    merge seams) may populate; it returns the legacy `(fqtn, rows_out)` tuple. On success an "ok" line is
    emitted; on exception a "fail" line is emitted AND the exception re-raised (the job must still fail
    loudly — observability is additive, not a swallow). Returns the metrics bag for the caller.

    Imported and wrapped by the _silver_base / _gold_base run_job seams (and the bespoke-main jobs) so the
    structured line is emitted from exactly one place per tier.
    """
    # Local import to avoid a hard import-order coupling; the base modules already put the spark root on
    # sys.path, so iceberg_base is importable here.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from iceberg_base import build_spark  # noqa: E402

    spark = build_spark(app_name)
    spark.sparkContext.setLogLevel("WARN")
    metrics = JobMetrics()
    started = time.monotonic()
    try:
        fqtn, rows_out = build_fn(spark, metrics)
        duration_ms = int((time.monotonic() - started) * 1000)
        emit_job_log(
            app_name, status="ok", rows_out=rows_out, metrics=metrics,
            fqtn=fqtn, duration_ms=duration_ms,
        )
        # Keep the legacy human line so existing log greps / tools still match (additive, not a swap).
        print(f"[{app_name}] DONE — {fqtn} now has {rows_out} rows", flush=True)
        return metrics
    except Exception as exc:  # noqa: BLE001
        duration_ms = int((time.monotonic() - started) * 1000)
        emit_job_log(app_name, status="fail", metrics=metrics, duration_ms=duration_ms, error=str(exc))
        raise
