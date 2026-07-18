"""test_medallion_freshness.py — unit tests for the ADR-0016 end-to-end freshness gauge.

Pure unit (no network / no duckdb-serving): we import the stdlib-only exporter, monkeypatch its
single HTTP call (`serving_query_scalar`), drive `refresh_once` + `render_metrics`, and assert the
`medallion_freshness_seconds` / `medallion_freshness_query_success` exposition — including the
anti-fantasy contract (no fabricated freshness number when the spine is unreachable/empty).

Run: python -m pytest tools/observability/freshness-exporter/test_medallion_freshness.py
"""
from __future__ import annotations

import importlib.util
import os
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "freshness_exporter_under_test", os.path.join(_HERE, "freshness_exporter.py")
)
fx = importlib.util.module_from_spec(_SPEC)
assert _SPEC and _SPEC.loader
_SPEC.loader.exec_module(fx)  # type: ignore[union-attr]


def _lines(text: str) -> list[str]:
    return [ln for ln in text.splitlines() if ln and not ln.startswith("#")]


def _metric_value(text: str, name: str) -> str | None:
    for ln in _lines(text):
        if ln.startswith(name + " "):
            return ln.split(" ", 1)[1].strip()
    return None


def test_medallion_freshness_happy_path(monkeypatch):
    """A fresh spine ingested_at 120s ago → gauge ~120s, query_success 1."""
    ingested_epoch = time.time() - 120.0

    def fake_scalar(sql: str):
        if "ingested_at" in sql:
            return ingested_epoch
        return time.time() - 30.0  # per-mart snapshot queries

    monkeypatch.setattr(fx, "serving_query_scalar", fake_scalar)
    fx.refresh_once(fx.DEFAULT_MARTS)
    out = fx.render_metrics()

    assert _metric_value(out, "medallion_freshness_query_success") == "1"
    age = float(_metric_value(out, "medallion_freshness_seconds"))
    # Wall-clock passes between refresh and render; allow a generous window.
    assert 115.0 <= age <= 130.0


def test_medallion_freshness_empty_spine_anti_fantasy(monkeypatch):
    """Spine reachable but empty (NULL max) → NO fabricated freshness number, query_success 0."""

    def fake_scalar(sql: str):
        if "ingested_at" in sql:
            return None  # empty/never-written view
        return time.time() - 30.0

    monkeypatch.setattr(fx, "serving_query_scalar", fake_scalar)
    fx.refresh_once(fx.DEFAULT_MARTS)
    out = fx.render_metrics()

    assert _metric_value(out, "medallion_freshness_query_success") == "0"
    assert _metric_value(out, "medallion_freshness_seconds") is None


def test_medallion_freshness_serving_unreachable_anti_fantasy(monkeypatch):
    """Serving errors on the probe → query_success 0, no fabricated gauge, loop stays alive."""

    def fake_scalar(sql: str):
        if "ingested_at" in sql:
            raise RuntimeError("duckdb-serving error (HTTP 503): unreachable")
        return time.time() - 30.0

    monkeypatch.setattr(fx, "serving_query_scalar", fake_scalar)
    fx.refresh_once(fx.DEFAULT_MARTS)
    out = fx.render_metrics()

    assert _metric_value(out, "medallion_freshness_query_success") == "0"
    assert _metric_value(out, "medallion_freshness_seconds") is None
