# DuckDB medallion transform image (Spark→DuckDB cutover, feat/spark-to-duckdb-cutover).
#
# Replaces db/iceberg/spark/Dockerfile: the transform tier is now DuckDB-on-Iceberg (Silver/Gold marts)
# + a Trino client for the Iceberg MAINTENANCE that DuckDB can't do (compaction / expire_snapshots /
# remove_orphan_files / erasure DELETE — those are Trino `ALTER TABLE … EXECUTE` procedures). NO JVM,
# NO Spark, NO Maven — a lightweight python image whose runtime needs only the pip deps below.
#
# Layout under /opt/brain (PRESERVED so the jobs' `sys.path.insert(0, <parent>)` self-import works):
#   /opt/brain/duckdb/{_base.py,_catalog.py,silver/*.py,gold/*.py}   ← the ~96 transform jobs
#   /opt/brain/trino/{trino_base.py,bronze_maintenance.py,…}         ← the 4 maintenance/erasure scripts
#
# Invocation (the Argo CronWorkflows / erasure WorkflowTemplate pass an explicit path):
#   python /opt/brain/duckdb/silver/<job>.py     (transform marts)
#   python /opt/brain/duckdb/gold/<job>.py
#   python /opt/brain/trino/<script>.py          (bronze_maintenance / bronze_raw_retention /
#                                                  medallion_maintenance / erasure_raw_delete)
#
# Pin the image by digest in the deploy manifest (never :latest) — same B3 posture as the old Spark image.

# arm64 Graviton target (the batch/streaming Karpenter pools are arm64) — python:3.12 is multi-arch;
# the deploy.yml build matrix builds --platform linux/arm64 natively.
FROM python:3.12-slim

# Python deps: duckdb (MERGE INTO + REST-catalog Iceberg writes), numpy (Markov attribution solve),
# splink>=4 (probabilistic stitch via the DuckDB backend, DORMANT/flag-gated), pyiceberg (table
# maintenance where Trino isn't used), and the Trino client used by trino/*.py. The requirements file
# is the migration floor (see its header). --no-cache-dir keeps the layer lean.
WORKDIR /opt/brain
COPY duckdb/requirements.txt /opt/brain/duckdb/requirements.txt
RUN pip install --no-cache-dir -r /opt/brain/duckdb/requirements.txt \
    && pip install --no-cache-dir 'trino>=0.330'   # Trino DBAPI client for db/iceberg/trino/*.py

# The transform tier + the Trino maintenance/erasure scripts. Directory structure is preserved verbatim
# so each job's `sys.path.insert(0, os.path.dirname(...))` resolves its sibling _base/_catalog/trino_base.
COPY duckdb/ /opt/brain/duckdb/
COPY trino/  /opt/brain/trino/

# Non-root runtime (parity with the Spark image's `USER spark`).
RUN useradd --system --create-home --uid 10001 brain \
    && chown -R brain:brain /opt/brain
USER brain

# Default: bronze maintenance (the Trino compaction + snapshot-expiry sweep). The Argo CronWorkflows
# always pass an explicit job path, so this default only serves a bare `docker run`.
ENTRYPOINT ["python", "/opt/brain/trino/bronze_maintenance.py"]
