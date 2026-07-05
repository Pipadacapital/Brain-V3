#!/usr/bin/env bash
# dev-down.sh — the complete inverse of `pnpm dev:up`: stops HOST processes first
# (supervisors respawn containers if killed last), then every compose profile.
#
# Data SURVIVES this (named volumes since AUD-INFRA-011): `pnpm dev:up` resumes
# where you left off. A deliberate factory reset is `pnpm dev:down -- -v` (or
# `docker compose --profile core down -v`), which wipes the warehouse/PG/Neo4j.
set -uo pipefail
cd "$(dirname "$0")/../.."

echo "[dev-down] stopping host processes (dev-up, refresh loop, apps)"
# pkill exits 1 when nothing matches — that's fine, keep going.
pkill -f 'tools/dev/dev-up.sh'           2>/dev/null || true
pkill -f 'tools/dev/v4-refresh-loop.sh'  2>/dev/null || true
# turbo-spawned app watchers (tsx watch / next dev) scoped to THIS repo only.
pkill -f 'turbo run dev'                 2>/dev/null || true
pkill -f "$(pwd)/apps/.*(tsx|next)"      2>/dev/null || true
sleep 1

echo "[dev-down] compose down (all profiles); extra args pass through: $*"
docker compose --profile core --profile ai --profile debug --profile full-obs --profile schema down "$@"

echo "[dev-down] done — state kept on named volumes (use 'pnpm dev:down -- -v' to wipe)"
