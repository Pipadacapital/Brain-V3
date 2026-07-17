#!/usr/bin/env bash
# compose-up-healthy.sh — `docker compose up -d` + a deterministic health poll.
#
# We deliberately do NOT use `docker compose up --wait`: depending on the compose
# version it aborts non-zero when a one-shot init container (minio-init,
# iceberg-catalog-init, jmx-exporter-init, kafka-init) exits 0 *during* the wait
# window — exactly what happens on a cold start (bit dev-up first, then CI:
# integration.yml died on "brain-v4-minio-init-1 exited (0)"). A service is
# "good" when it is running-and-(healthy | has-no-healthcheck) or exited 0.
#
# usage: compose-up-healthy.sh [--profile X]...   (args pass straight to compose)
set -uo pipefail

PROFILES=("$@")
# --build: duckdb-serving is the ONLY locally-built service and its image BAKES IN the serving
# views (db/iceberg/duckdb/views/**) — without a rebuild, a branch that adds/changes a view
# (e.g. ADR-0015's mv_silver_collector_event, which the silver-identity stage reads) keeps
# serving the STALE image and the refresh identity stage 500s. Layer-cached → a no-op when
# nothing under db/iceberg/duckdb changed.
docker compose "${PROFILES[@]}" up -d --build --remove-orphans

deadline=$((SECONDS + 360))
while :; do
  bad=$(docker compose "${PROFILES[@]}" ps -a \
          --format '{{.Service}}\t{{.State}}\t{{.Health}}\t{{.ExitCode}}' \
        | awk -F'\t' '
            $2=="running" && ($3=="" || $3=="healthy") { next }
            $2=="exited"  && $4=="0"                    { next }
            { print $1" ("$2" "$3" exit="$4")" }')
  [ -z "$bad" ] && { echo "  all services healthy."; exit 0; }
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "  ✗ services not healthy after 360s:" >&2
    printf '    %s\n' "$bad" >&2
    docker compose "${PROFILES[@]}" ps -a >&2
    exit 1
  fi
  sleep 3
done
