#!/usr/bin/env bash
# _spark_lock.sh — GLOBAL admission lock for BATCH Spark job containers (AUD-INFRA-006).
#
# Problem: overlapping refresh loops / manual run-*.sh invocations each `docker run` a 7g-cap Spark JVM
# with NO admission control — 3-4 concurrent containers oversubscribe the Docker VM (the still-open
# "cron scheduling-overlap gap" from the #323/#324 audit). Sourcing this file serializes them host-wide:
# at most ONE batch Spark job script runs at a time; later invocations QUEUE (bounded wait), so a second
# refresh loop or a manual run-*.sh waits its turn instead of stacking JVMs.
#
# Semantics:
#   - mkdir-based lock (atomic on POSIX; flock(1) does not exist on macOS hosts) + holder pidfile.
#   - RE-ENTRANT per process tree: a run script invoked by a holder (e.g. run-gold-attribution.sh →
#     run-gold-revenue.sh) sees BRAIN_SPARK_LOCK_HELD in its env and skips acquiring.
#   - STALE-SAFE: a lock whose recorded holder pid is dead is reclaimed immediately (covers hard kills
#     AND the `exec docker run` scripts, whose EXIT trap never fires — exec preserves the pid, so the
#     lock stays correctly "held" for the job's lifetime and is reclaimed after it exits).
#   - A never-ending STREAMING job must NOT source this file — it would starve every batch job.
#     (Moot today: ADR-0010 removed the Spark streaming Bronze sinks — the Bronze writer is the Kafka
#     Connect Iceberg sink, which runs outside these scripts — so every remaining run-*.sh is batch.)
#   - BRAIN_SPARK_LOCK_DISABLE=1 bypasses entirely (CI runners with no shared host, debugging).
#
# Usage (immediately after `set -euo pipefail`):
#   . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_spark_lock.sh"        # db/iceberg/spark/run-*.sh
#   . "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/_spark_lock.sh"     # silver/ gold/ parity/ run-*.sh

BRAIN_SPARK_LOCK_DIR="${BRAIN_SPARK_LOCK_DIR:-${TMPDIR:-/tmp}/brain-spark-batch.lock}"
BRAIN_SPARK_LOCK_TIMEOUT="${BRAIN_SPARK_LOCK_TIMEOUT:-3600}"  # seconds to queue before failing loudly

_brain_spark_lock_release() {
  # Only the acquiring process removes the lock (a re-entrant child must never release the parent's).
  if [ "${_BRAIN_SPARK_LOCK_OWNER:-}" = "$$" ]; then
    rm -rf "$BRAIN_SPARK_LOCK_DIR"
  fi
}

brain_spark_lock_acquire() {
  [ "${BRAIN_SPARK_LOCK_DISABLE:-0}" = "1" ] && return 0
  [ "${BRAIN_SPARK_LOCK_HELD:-0}" = "1" ] && return 0  # a parent in this process tree already holds it
  local waited=0 owner
  while ! mkdir "$BRAIN_SPARK_LOCK_DIR" 2>/dev/null; do
    owner="$(cat "$BRAIN_SPARK_LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$BRAIN_SPARK_LOCK_DIR"  # holder is dead (hard kill / exec'd job exited) — reclaim
      continue
    fi
    if [ "$waited" -ge "$BRAIN_SPARK_LOCK_TIMEOUT" ]; then
      echo "[spark-lock] ✗ timed out after ${BRAIN_SPARK_LOCK_TIMEOUT}s waiting on ${BRAIN_SPARK_LOCK_DIR} (held by pid ${owner:-unknown})" >&2
      return 1
    fi
    if [ "$waited" -eq 0 ]; then
      echo "[spark-lock] queued behind pid ${owner:-unknown} — at most one batch Spark container runs at a time (${BRAIN_SPARK_LOCK_DIR})" >&2
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "$$" >"$BRAIN_SPARK_LOCK_DIR/pid"
  _BRAIN_SPARK_LOCK_OWNER="$$"
  export BRAIN_SPARK_LOCK_HELD=1
  trap _brain_spark_lock_release EXIT
  return 0
}

brain_spark_lock_acquire
