# dbt-runner image — the runtime for scheduled dbt mart rebuilds (Argo CronWorkflows).
#
# Node job images (core / stream-worker) can't run dbt: they have no dbt/StarRocks-catalog runtime.
# This image bundles the dbt project (db/dbt) + the StarRocks catalog bootstrap SQL (db/starrocks) +
# the dbt-starrocks adapter, so the attribution gold refresh (chain step 4) and Silver intraday
# rebuilds can run on a schedule. See db/dbt/docker-entrypoint.sh for the parameterized run.
#
# BUILD CONTEXT = db/ (so it can COPY both dbt/ and starrocks/):
#   docker build -f db/dbt/Dockerfile -t brain-dbt-runner db
#
# B3 (deploy): pin by digest in the Argo manifest; never :latest.
FROM python:3.11-slim

# Adapter + CLI clients for the (optional, idempotent) catalog bootstrap. dbt-starrocks pins dbt-core.
ARG DBT_STARROCKS_VERSION=1.12.0
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client default-mysql-client; \
    rm -rf /var/lib/apt/lists/*; \
    pip install --no-cache-dir "dbt-starrocks==${DBT_STARROCKS_VERSION}"

WORKDIR /opt/brain
# Context is db/ → these are db/dbt and db/starrocks.
COPY dbt/ /opt/brain/dbt/
COPY starrocks/ /opt/brain/starrocks/
RUN chmod +x /opt/brain/dbt/docker-entrypoint.sh

# Non-root runtime.
RUN useradd -m -u 10001 dbt && chown -R dbt:dbt /opt/brain
USER dbt

ENV DBT_PROFILES_DIR=/opt/brain/dbt/profiles
ENTRYPOINT ["/opt/brain/dbt/docker-entrypoint.sh"]
