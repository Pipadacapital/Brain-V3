# duckdb-serving image (Trino→DuckDB serving replacement, ADR-0014 / plan §A2).
#
# The stateless serving replica: FastAPI + ONE DuckDB attached READ-ONLY to the Iceberg REST
# catalog, serving POST /v1/query to the app/BFF/metric-engine. NO JVM (Trino's 7g heap →
# a 4g-bounded python pod); scale is horizontal (replicas behind a Service/HPA), never
# uvicorn workers (one DuckDB per process owns the pod's memory budget).
#
# BUILD CONTEXT is db/iceberg/duckdb (NOT this dir): the image needs the sibling _catalog.py
# (the shared DuckDB⇄REST-catalog seam) and views/ (the ported serving views — created by the
# views workstream; present by PR time):
#   docker build -f serving/Dockerfile db/iceberg/duckdb
#
# Layout under /opt/brain (parity with the transform image so sys.path self-imports work):
#   /opt/brain/duckdb/_catalog.py          ← shared catalog seam (read_only=True here)
#   /opt/brain/duckdb/views/*.sql          ← serving views, applied per epoch into LOCAL schemas
#   /opt/brain/duckdb/serving/*.py         ← server / engine / serialize / views
#
# Pin the image by digest in the deploy manifest (never :latest) — same B3 posture as the
# transform image.

# arm64 Graviton target (the serving Karpenter pool is arm64) — python:3.12 is multi-arch.
FROM python:3.12-slim

WORKDIR /opt/brain/duckdb
COPY serving/requirements.txt /opt/brain/duckdb/serving/requirements.txt
RUN pip install --no-cache-dir -r /opt/brain/duckdb/serving/requirements.txt

COPY _catalog.py /opt/brain/duckdb/_catalog.py
COPY views/      /opt/brain/duckdb/views/
COPY serving/    /opt/brain/duckdb/serving/

# Non-root runtime (parity with the transform image's uid 10001).
RUN useradd --system --create-home --uid 10001 brain \
    && chown -R brain:brain /opt/brain
USER brain

# Bake the DuckDB extensions into the RUNTIME user's ~/.duckdb at build time — a serving pod
# must cold-start with no egress to extensions.duckdb.org (json is autoloadable but baked too,
# for fully-offline parity). Must run AFTER `USER brain`: extensions cache per-user.
RUN python -c "import duckdb; con = duckdb.connect(); con.execute('INSTALL iceberg; INSTALL httpfs; INSTALL json;')"

EXPOSE 8091
# 1 uvicorn worker — see header. Container-level healthcheck lives in compose/helm (/readyz).
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8091", \
     "--workers", "1", "--app-dir", "/opt/brain/duckdb/serving"]
