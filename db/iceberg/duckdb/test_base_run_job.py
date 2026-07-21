"""
test_base_run_job.py — run_job's source_table=None branch (ADR-0017 A3).

The 4 Neo4j→Iceberg identity projections (silver_identity_map/alias/customer_identity/unmerge) project the
graph — they do NOT read the keystone. Pinning `max(ingested_at)` off the fragmented keystone was ~4.5 min
COLD × 4 jobs (the "15-min empty export"), and the keystone watermark they wrote was meaningless. A3 makes
them pass source_table=None so run_job SKIPS both the pin query and the watermark write.

Self-contained: _base.connect + write_watermark are stubbed, so no catalog / DuckDB is needed.

Run:  python -m pytest db/iceberg/duckdb/test_base_run_job.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _base  # noqa: E402


class _FakeCon:
    def __init__(self):
        self.queries: list[str] = []

    def execute(self, q):
        self.queries.append(q)
        return self

    def fetchone(self):
        return [None]

    def close(self):
        pass


def _run(source_table, monkeypatch):
    con = _FakeCon()
    watermarks: list[tuple] = []
    monkeypatch.setattr(_base, "connect", lambda: con)
    monkeypatch.setattr(_base, "write_watermark", lambda c, job, ts: watermarks.append((job, ts)))
    _base.run_job("t-job", lambda c: 3, target_table="rest.brain_silver.x", source_table=source_table)
    return con, watermarks


def test_source_table_none_skips_pin_and_watermark(monkeypatch):
    con, watermarks = _run(None, monkeypatch)
    # A3: no `SELECT max(...)` pin query, and no watermark write
    assert not any("max(" in q.lower() for q in con.queries), con.queries
    assert watermarks == []


def test_default_source_table_still_pins_and_advances(monkeypatch):
    # Regression guard: the normal entity-job path (source_table defaulted) still pins the keystone hi.
    con, _ = _run(_base.GATED_SOURCE, monkeypatch)
    assert any("max(ingested_at)" in q.lower() for q in con.queries), con.queries


if __name__ == "__main__":
    import pytest  # noqa: E402

    raise SystemExit(pytest.main([__file__, "-q"]))
