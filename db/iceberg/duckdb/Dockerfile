# DuckDB medallion transform + maintenance image (Trino removal, ADR-0014).
#
# The transform tier is DuckDB-on-Iceberg (Silver/Gold marts) + the PyIceberg maintenance client for
# the Iceberg housekeeping DuckDB doesn't do natively (compaction as COW rewrites / expire_snapshots
# with the physical file sweep / erasure COW DELETE — db/iceberg/duckdb/maintenance/, replacing the
# retired Trino `ALTER TABLE … EXECUTE` client). NO JVM, NO Spark, NO Trino — a lightweight python
# image whose runtime needs only the pip deps below.
#
# Layout under /opt/brain (PRESERVED so the jobs' `sys.path.insert(0, <parent>)` self-import works):
#   /opt/brain/duckdb/{_base.py,_catalog.py,silver/*.py,gold/*.py}     ← the ~96 transform jobs
#   /opt/brain/duckdb/maintenance/{_maintenance_base.py,…}             ← the 4 maintenance/erasure scripts
#   /opt/brain/duckdb/views/*.sql                                      ← serving views (the transform-tier
#                                                                        preagg refresh job applies these)
#
# Invocation (the Argo CronWorkflows / erasure WorkflowTemplate pass an explicit path):
#   python /opt/brain/duckdb/silver/<job>.py            (transform marts)
#   python /opt/brain/duckdb/gold/<job>.py
#   python /opt/brain/duckdb/maintenance/<script>.py    (bronze_maintenance / bronze_raw_retention /
#                                                        medallion_maintenance / erasure_raw_delete)
#
# Pin the image by digest in the deploy manifest (never :latest) — same B3 posture as the old Spark image.

# arm64 Graviton target (the batch/streaming Karpenter pools are arm64) — python:3.12 is multi-arch;
# the deploy.yml build matrix builds --platform linux/arm64 natively.
FROM python:3.12-slim

# Python deps: duckdb (MERGE INTO + REST-catalog Iceberg writes), numpy (Markov attribution solve),
# splink>=4 (probabilistic stitch via the DuckDB backend, DORMANT/flag-gated), pyiceberg+pyarrow (the
# maintenance tier: COW rewrites, snapshot expiry + sweep, erasure). The requirements file is the
# migration floor (see its header). --no-cache-dir keeps the layer lean.
WORKDIR /opt/brain
COPY duckdb/requirements.txt /opt/brain/duckdb/requirements.txt
RUN pip install --no-cache-dir -r /opt/brain/duckdb/requirements.txt

# The transform tier + the PyIceberg maintenance/erasure scripts + the serving view SQL. Directory
# structure is preserved verbatim so each job's `sys.path.insert(0, os.path.dirname(...))` resolves
# its sibling _base/_catalog/_maintenance_base.
COPY duckdb/ /opt/brain/duckdb/

# Non-root runtime (parity with the Spark image's `USER spark`).
RUN useradd --system --create-home --uid 10001 brain \
    && chown -R brain:brain /opt/brain
USER brain

# Default: bronze maintenance (the PyIceberg compaction + snapshot-expiry sweep). The Argo
# CronWorkflows always pass an explicit job path, so this default only serves a bare `docker run`.
ENTRYPOINT ["python", "/opt/brain/duckdb/maintenance/bronze_maintenance.py"]
