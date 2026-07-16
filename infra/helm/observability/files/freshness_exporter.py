#!/usr/bin/env python3
"""
Brain V4 — data-freshness SLA exporter (deliverable 2.5).

Emits `brain_data_freshness_seconds` (labelled by mart/schema/sla_class) = age in
seconds since the latest successful Gold Iceberg snapshot for each serving mart, so
Prometheus can alert when a dashboard goes stale (15m for executive marts, 1h for
customer-segment marts — thresholds enforced by infra/observe/alerts/freshness.rules.yml).

WHY snapshot metadata (not a scheduler heartbeat): Iceberg is the system of record
(CLAUDE.md). Every successful Gold batch commits a new snapshot; its commit timestamp
is the authoritative "last successful write" timestamp. We read it through duckdb-serving
— the SOLE serving engine (ADR-0014) — exactly the way the app does, via the same
`iceberg` catalog attach:

    SELECT epoch(max(timestamp_ms))
    FROM iceberg_snapshots(iceberg.brain_gold."gold_executive_metrics")

`epoch()` is done server-side (the serving session is pinned to UTC) so we never parse
timestamp strings. `iceberg_snapshots()` is the DuckDB-Iceberg metadata table function —
the analogue of Trino's `"<table>$snapshots"` — and accepts the attached-catalog
identifier directly (verified against the live REST catalog).

STACK: stdlib-only (urllib + http.server + threading). No pip install, no Dockerfile
required — it runs as a plain `python3 freshness_exporter.py`. This mirrors the medallion's
Python tooling (db/iceberg/duckdb/**) and the single-POST /v1/query flow implemented in
packages/metric-engine/src/duckdb-serving-adapter.ts (no /v1/statement polling, no nextUri).

ANTI-FANTASY (matches the C2 doctrine in brain-slo.rules.yml): a metric that silently
never fires is worse than no metric. So when a mart's snapshot query FAILS or returns NULL
(table missing / never written), we do NOT emit a fake freshness number — we emit
`brain_data_freshness_query_success{mart=...} 0`, and freshness.rules.yml alerts on that
too. The exporter's own liveness is `up` (Prometheus scrape) + `brain_data_freshness_up`.

Env config (all optional, dev defaults shown):
  FRESHNESS_SERVING_URL     duckdb-serving base URL             (default http://duckdb-serving:8091)
  FRESHNESS_ICEBERG_CATALOG attached Iceberg catalog name       (default iceberg)
  FRESHNESS_GOLD_SCHEMA     Iceberg Gold schema                 (default brain_gold)
  FRESHNESS_LISTEN_ADDR     /metrics bind host                  (default 0.0.0.0)
  FRESHNESS_LISTEN_PORT     /metrics bind port                  (default 9095)
  FRESHNESS_REFRESH_SEC     background refresh interval seconds  (default 60)
  FRESHNESS_QUERY_TIMEOUT_SEC  per-HTTP-request timeout          (default 20)
  FRESHNESS_MARTS_FILE      path to a JSON registry override    (default: built-in DEFAULT_MARTS)

JSON registry override format (FRESHNESS_MARTS_FILE):
  [ {"mart": "gold_executive_metrics", "sla_class": "executive"},
    {"mart": "gold_customer_segments", "sla_class": "segment", "schema": "brain_gold"} ]
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional


# ── Mart registry ───────────────────────────────────────────────────────────────
# sla_class drives the alert threshold in freshness.rules.yml:
#   executive → 900s (15m)   |   segment → 3600s (1h)
# Grounded in the DuckDB Gold marts (db/iceberg/duckdb/gold/*.py) that back the
# executive dashboard and the customer-segment surfaces.
DEFAULT_MARTS: list[dict[str, str]] = [
    # ── Executive dashboard marts (15-minute SLA) ──
    {"mart": "gold_executive_metrics", "sla_class": "executive"},
    {"mart": "gold_revenue_ledger", "sla_class": "executive"},
    {"mart": "gold_revenue_analytics", "sla_class": "executive"},
    {"mart": "gold_cac", "sla_class": "executive"},
    {"mart": "gold_contribution_margin", "sla_class": "executive"},
    {"mart": "gold_marketing_attribution", "sla_class": "executive"},
    # ── Customer-segment marts (1-hour SLA) ──
    {"mart": "gold_customer_segments", "sla_class": "segment"},
    {"mart": "gold_customer_360", "sla_class": "segment"},
    {"mart": "gold_customer_scores", "sla_class": "segment"},
    {"mart": "gold_customer_health", "sla_class": "segment"},
    {"mart": "gold_cohorts", "sla_class": "segment"},
    {"mart": "gold_retention", "sla_class": "segment"},
]


# ── Config ───────────────────────────────────────────────────────────────────────
def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v is not None and v != "" else default


SERVING_URL = _env("FRESHNESS_SERVING_URL", "http://duckdb-serving:8091").rstrip("/")
ICEBERG_CATALOG = _env("FRESHNESS_ICEBERG_CATALOG", "iceberg")
GOLD_SCHEMA = _env("FRESHNESS_GOLD_SCHEMA", "brain_gold")
LISTEN_ADDR = _env("FRESHNESS_LISTEN_ADDR", "0.0.0.0")
LISTEN_PORT = int(_env("FRESHNESS_LISTEN_PORT", "9095"))
REFRESH_SEC = int(_env("FRESHNESS_REFRESH_SEC", "60"))
QUERY_TIMEOUT_SEC = int(_env("FRESHNESS_QUERY_TIMEOUT_SEC", "20"))


def _load_marts() -> list[dict[str, str]]:
    path = os.environ.get("FRESHNESS_MARTS_FILE")
    if not path:
        return DEFAULT_MARTS
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise ValueError(f"FRESHNESS_MARTS_FILE {path} must contain a JSON array")
    out: list[dict[str, str]] = []
    for entry in data:
        if not isinstance(entry, dict) or "mart" not in entry or "sla_class" not in entry:
            raise ValueError(f"invalid mart entry (need mart + sla_class): {entry!r}")
        out.append(
            {
                "mart": str(entry["mart"]),
                "sla_class": str(entry["sla_class"]),
                "schema": str(entry.get("schema", GOLD_SCHEMA)),
            }
        )
    return out


# ── duckdb-serving HTTP client (stdlib) ───────────────────────────────────────────
# Mirrors packages/metric-engine/src/duckdb-serving-adapter.ts: a SINGLE
# POST /v1/query {"sql": ...} → {"columns": [...], "data": [[...]]} round-trip
# (no polling). Errors arrive as non-200 with {"error": {"message": ...}}.
def serving_query_scalar(sql: str) -> Optional[float]:
    """Run a single-column/single-row query, returning the scalar as float or None."""
    req = urllib.request.Request(
        f"{SERVING_URL}/v1/query",
        data=json.dumps({"sql": sql}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=QUERY_TIMEOUT_SEC) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Surface the engine's honest error message (400/503/504/500 all carry one).
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        try:
            detail = json.loads(detail).get("error", {}).get("message", detail)
        except (ValueError, AttributeError):
            pass
        raise RuntimeError(f"duckdb-serving error (HTTP {exc.code}): {detail}") from exc
    rows: list[list[Any]] = list(body.get("data") or [])
    if not rows or rows[0] is None or rows[0][0] is None:
        return None
    return float(rows[0][0])


def fetch_latest_snapshot_epoch(schema: str, mart: str) -> Optional[float]:
    """Latest successful Iceberg snapshot commit time (epoch seconds) for a Gold mart."""
    # mart/schema come from a trusted registry, never user input (see the
    # duckdb-serving-adapter.ts INVARIANT). Quote the table identifier so reserved
    # words / dashes in mart names parse; epoch() is UTC-safe (serving session is UTC).
    sql = (
        f'SELECT epoch(max(timestamp_ms)) '
        f'FROM iceberg_snapshots({ICEBERG_CATALOG}.{schema}."{mart}")'
    )
    return serving_query_scalar(sql)


# ── Metric state ──────────────────────────────────────────────────────────────────
class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        # mart -> {sla_class, schema, snapshot_epoch (float|None), ok (bool), error (str|None)}
        self.results: dict[str, dict[str, Any]] = {}
        self.last_scrape_duration = 0.0
        self.last_scrape_unixtime = 0.0
        self.scrape_total = 0
        self.exporter_up = 0


STATE = State()


def refresh_once(marts: list[dict[str, str]]) -> None:
    start = time.time()
    results: dict[str, dict[str, Any]] = {}
    any_ok = False
    for m in marts:
        mart = m["mart"]
        schema = m.get("schema", GOLD_SCHEMA)
        rec: dict[str, Any] = {
            "sla_class": m["sla_class"],
            "schema": schema,
            "snapshot_epoch": None,
            "ok": False,
            "error": None,
        }
        try:
            epoch = fetch_latest_snapshot_epoch(schema, mart)
            if epoch is None:
                # Reachable but no snapshot / NULL → mart never written. NOT a fake number.
                rec["ok"] = False
                rec["error"] = "no_snapshot"
            else:
                rec["snapshot_epoch"] = epoch
                rec["ok"] = True
                any_ok = True
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, OSError, ValueError) as exc:
            rec["ok"] = False
            rec["error"] = str(exc)[:200]
        results[mart] = rec

    with STATE.lock:
        STATE.results = results
        STATE.last_scrape_duration = time.time() - start
        STATE.last_scrape_unixtime = time.time()
        STATE.scrape_total += 1
        # exporter_up reflects duckdb-serving reachability: at least one mart query succeeded.
        STATE.exporter_up = 1 if any_ok else 0


def refresh_loop(marts: list[dict[str, str]]) -> None:
    while True:
        try:
            refresh_once(marts)
        except Exception as exc:  # never let the loop die silently
            sys.stderr.write(f"[freshness-exporter] refresh error: {exc}\n")
            sys.stderr.flush()
            with STATE.lock:
                STATE.exporter_up = 0
        time.sleep(REFRESH_SEC)


# ── Prometheus exposition ──────────────────────────────────────────────────────────
def _labels(mart: str, schema: str, sla_class: str) -> str:
    return f'mart="{mart}",schema="{schema}",sla_class="{sla_class}"'


def render_metrics() -> str:
    now = time.time()
    lines: list[str] = []

    lines.append(
        "# HELP brain_data_freshness_seconds Age in seconds since the latest successful "
        "Gold Iceberg snapshot for a serving mart."
    )
    lines.append("# TYPE brain_data_freshness_seconds gauge")

    lines.append(
        "# HELP brain_data_freshness_last_snapshot_timestamp_seconds Unix time of the "
        "latest successful Gold Iceberg snapshot for a serving mart."
    )
    lines.append("# TYPE brain_data_freshness_last_snapshot_timestamp_seconds gauge")

    lines.append(
        "# HELP brain_data_freshness_query_success 1 if the mart snapshot query "
        "succeeded and returned a snapshot, else 0 (mart unreachable/empty)."
    )
    lines.append("# TYPE brain_data_freshness_query_success gauge")

    with STATE.lock:
        results = dict(STATE.results)
        scrape_dur = STATE.last_scrape_duration
        scrape_unix = STATE.last_scrape_unixtime
        scrape_total = STATE.scrape_total
        exporter_up = STATE.exporter_up

    for mart, rec in sorted(results.items()):
        lbl = _labels(mart, rec["schema"], rec["sla_class"])
        if rec["ok"] and rec["snapshot_epoch"] is not None:
            age = max(0.0, now - float(rec["snapshot_epoch"]))
            lines.append(f"brain_data_freshness_seconds{{{lbl}}} {age:.3f}")
            lines.append(
                f"brain_data_freshness_last_snapshot_timestamp_seconds{{{lbl}}} "
                f"{float(rec['snapshot_epoch']):.3f}"
            )
            lines.append(f"brain_data_freshness_query_success{{{lbl}}} 1")
        else:
            # No fabricated freshness value — only the failure signal (anti-fantasy).
            lines.append(f"brain_data_freshness_query_success{{{lbl}}} 0")

    lines.append(
        "# HELP brain_data_freshness_scrape_duration_seconds Wall time of the last "
        "background snapshot-metadata scrape."
    )
    lines.append("# TYPE brain_data_freshness_scrape_duration_seconds gauge")
    lines.append(f"brain_data_freshness_scrape_duration_seconds {scrape_dur:.4f}")

    lines.append(
        "# HELP brain_data_freshness_last_scrape_timestamp_seconds Unix time of the last "
        "background scrape (0 if none completed yet)."
    )
    lines.append("# TYPE brain_data_freshness_last_scrape_timestamp_seconds gauge")
    lines.append(f"brain_data_freshness_last_scrape_timestamp_seconds {scrape_unix:.3f}")

    lines.append("# HELP brain_data_freshness_scrape_total Count of completed background scrapes.")
    lines.append("# TYPE brain_data_freshness_scrape_total counter")
    lines.append(f"brain_data_freshness_scrape_total {scrape_total}")

    lines.append(
        "# HELP brain_data_freshness_up 1 if the exporter reached duckdb-serving on the last "
        "scrape (>=1 mart query succeeded), else 0."
    )
    lines.append("# TYPE brain_data_freshness_up gauge")
    lines.append(f"brain_data_freshness_up {exporter_up}")

    return "\n".join(lines) + "\n"


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        if self.path == "/metrics":
            body = render_metrics().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path in ("/healthz", "/-/healthy"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok\n")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:  # silence per-request access logs
        return


def main() -> int:
    marts = _load_marts()

    # --once: scrape a single time, print the Prometheus exposition to stdout, and exit.
    # Backs the CronJob+Pushgateway topology in infra/observe/k8s/freshness-exporter.yaml
    # and makes the exporter trivially testable without a long-lived server.
    if "--once" in sys.argv[1:]:
        try:
            refresh_once(marts)
        except Exception as exc:
            sys.stderr.write(f"[freshness-exporter] --once refresh failed: {exc}\n")
        sys.stdout.write(render_metrics())
        return 0

    sys.stderr.write(
        f"[freshness-exporter] serving={SERVING_URL} catalog={ICEBERG_CATALOG} "
        f"schema={GOLD_SCHEMA} marts={len(marts)} listen={LISTEN_ADDR}:{LISTEN_PORT} "
        f"refresh={REFRESH_SEC}s\n"
    )
    sys.stderr.flush()

    # Prime once synchronously so the first scrape is meaningful, then refresh in background.
    try:
        refresh_once(marts)
    except Exception as exc:
        sys.stderr.write(f"[freshness-exporter] initial refresh failed (continuing): {exc}\n")

    t = threading.Thread(target=refresh_loop, args=(marts,), daemon=True)
    t.start()

    server = ThreadingHTTPServer((LISTEN_ADDR, LISTEN_PORT), MetricsHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
