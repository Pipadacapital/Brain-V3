#!/usr/bin/env bash
# _retry.sh — shared bounded-retry helper for the Brain V4 Spark run-*.sh scripts.
#
# Every Spark Silver/Gold job writes via an idempotent Iceberg MERGE (replay-safe on its model PK), so a
# transient failure (Ivy resolve hiccup, a momentary StarRocks/Neo4j/MinIO blip, an OOM that frees on a
# fresh JVM) is safe to retry — re-running produces the SAME table state. This helper gives every script
# (and the Argo cron that invokes it) a bounded retry with a CLEAR per-job failure exit, instead of a
# single attempt that fails the whole pipeline on a blip.
#
# Usage:  source "$(dirname "$0")/../_retry.sh"   # adjust the relative path to reach this file
#         spark_retry "<job label>" <command...>
#
# Env:   SPARK_MAX_RETRIES   total attempts = SPARK_MAX_RETRIES + 1   (default 1 → one retry → 2 attempts)
#        SPARK_RETRY_SLEEP   seconds between attempts                 (default 10)
# Returns the command's last exit code; on persistent failure prints "✗ <label> FAILED" and returns it.

SPARK_MAX_RETRIES="${SPARK_MAX_RETRIES:-1}"
SPARK_RETRY_SLEEP="${SPARK_RETRY_SLEEP:-10}"

spark_retry() {
  local label="$1"; shift
  local attempt=0 rc=0
  while :; do
    attempt=$((attempt+1))
    if "$@"; then
      [ "$attempt" -gt 1 ] && echo "[spark-retry] ✓ ${label} (attempt ${attempt}/$((SPARK_MAX_RETRIES+1)))"
      return 0
    fi
    rc=$?
    if [ "$attempt" -gt "$SPARK_MAX_RETRIES" ]; then
      echo "[spark-retry] ✗ ${label} FAILED after ${attempt} attempt(s) (rc=${rc})" >&2
      return "$rc"
    fi
    echo "[spark-retry] ⚠ ${label} failed (rc=${rc}, attempt ${attempt}/$((SPARK_MAX_RETRIES+1))) — retrying in ${SPARK_RETRY_SLEEP}s" >&2
    sleep "$SPARK_RETRY_SLEEP"
  done
}
