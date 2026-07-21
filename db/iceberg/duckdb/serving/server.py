"""
server.py — duckdb-serving: the HTTP facade (FastAPI + uvicorn, 1 worker per replica; plan §A2).

The Trino-replacement serving endpoint the TS adapter (duckdb-serving-adapter.ts) talks to.
ONE round-trip per query — no /v1/statement polling, no nextUri:

  POST /v1/query   {"sql": "SELECT …"}  →  200 {"columns":[{name,type},…], "data":[[…],…]}
                   errors → {"error":{"message":…}} with an honest status:
                   400 guard-rejected · 503 not-ready/saturated · 504 watchdog timeout · 500 engine
  GET  /healthz    process liveness (200 once the server is up — even with the catalog down,
                   so k8s doesn't restart-loop a pod that is self-healing its attach)
  GET  /readyz     200 + {views_applied, views_skipped} once the first epoch is live; 503 before.
                   An empty views dir is READY (0 applied) — the views land in a parallel
                   workstream; dev-up's gate checks views_skipped, not this status.
  GET  /metrics    Prometheus text exposition (hand-rolled — counters + gauges, no client dep)

Params are substituted CLIENT-SIDE by the TS adapter (verbatim from the Trino adapter, incl.
the AUD-ARCH-013 count guard), so the body carries final SQL only. Brand isolation is upstream
too: `${BRAND_PREDICATE}` is already injected into the SQL before it reaches this service —
this tier executes read-only (READ_ONLY catalog attach + SELECT/WITH guard) and never widens.

Run: uvicorn server:app --host 0.0.0.0 --port 8091 --workers 1  (one DuckDB per process —
scale horizontally with replicas, never with uvicorn workers sharing a pod's memory budget).
"""
from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import serialize  # noqa: E402
from engine import Engine, EngineNotReady, EngineSaturated, QueryRejected, QueryTimeout  # noqa: E402

ENGINE = Engine()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    ENGINE.start()  # best-effort first epoch; a down catalog leaves /readyz 503 and self-heals
    try:
        yield
    finally:
        ENGINE.stop()


app = FastAPI(title="duckdb-serving", lifespan=_lifespan)


class QueryRequest(BaseModel):
    """The single-round-trip query body. SQL arrives FINAL (params substituted client-side)."""

    sql: str
    # Optional per-request watchdog raise (the TS adapter always sends its queryTimeoutMs here;
    # previously silently DROPPED — the silver-identity batch lane needs > the 25s OLTP default).
    # Engine-side clamp_timeout_ms bounds it to [1s, STATEMENT_TIMEOUT_MAX_MS]; absent → default.
    timeout_ms: int | None = None


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"message": message}})


# `def` (not `async def`) on purpose: DuckDB calls BLOCK, so FastAPI must run them on its
# threadpool — the admission semaphore in the engine bounds actual DuckDB concurrency.
@app.post("/v1/query")
def v1_query(req: QueryRequest):
    try:
        description, rows = ENGINE.query(req.sql, timeout_ms=req.timeout_ms)
    except QueryRejected as exc:
        return _error(400, str(exc))
    except (EngineNotReady, EngineSaturated) as exc:
        return _error(503, str(exc))
    except QueryTimeout as exc:
        return _error(504, str(exc))
    except Exception as exc:  # noqa: BLE001 — engine/SQL error: honest 500, message surfaced
        return _error(500, str(exc))
    return {"columns": serialize.columns_of(description), "data": serialize.serialize_rows(rows)}


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/readyz")
def readyz():
    status = ENGINE.status()
    if not status["ready"]:
        return JSONResponse(status_code=503, content=status)
    return status


@app.get("/metrics")
def metrics():
    """Prometheus text exposition — counter/gauge names are the serving SLO surface (alert
    rules bind to these; keep them stable)."""
    s = ENGINE.status()
    lines = []

    def counter(name: str, help_text: str, value) -> None:
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} counter")
        lines.append(f"{name} {value}")

    def gauge(name: str, help_text: str, value) -> None:
        lines.append(f"# HELP {name} {help_text}")
        lines.append(f"# TYPE {name} gauge")
        lines.append(f"{name} {value}")

    counter("duckdb_serving_queries_total", "Queries admitted to the engine", ENGINE.queries_total)
    counter("duckdb_serving_query_failures_total", "Queries that failed in the engine (5xx)",
            ENGINE.query_failures_total)
    counter("duckdb_serving_query_timeouts_total", "Queries interrupted by the watchdog (504)",
            ENGINE.query_timeouts_total)
    counter("duckdb_serving_query_rejected_total", "Statements rejected by the SELECT/WITH guard (400)",
            ENGINE.query_rejected_total)
    counter("duckdb_serving_query_saturated_total", "Admissions refused — semaphore full (503)",
            ENGINE.query_saturated_total)
    counter("duckdb_serving_epoch_rotations_total", "Successful epoch rotations", ENGINE.rotations_total)
    counter("duckdb_serving_epoch_rotation_failures_total", "Failed epoch builds (old epoch kept serving)",
            ENGINE.rotation_failures_total)
    gauge("duckdb_serving_inflight_queries", "Queries currently executing", ENGINE.inflight)
    gauge("duckdb_serving_ready", "1 once an epoch is live", 1 if s["ready"] else 0)
    gauge("duckdb_serving_epoch", "Current epoch index (monotonic)", s["epoch"] or 0)
    gauge("duckdb_serving_views_applied", "Views applied in the current epoch", s["views_applied"])
    gauge("duckdb_serving_views_skipped", "Views skipped in the current epoch (deps not ready)",
          len(s["views_skipped"]))
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8091")), workers=1)
