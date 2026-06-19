# syntax=docker/dockerfile:1
#
# @brain/stream-worker — Kafka/Redpanda consumer pipeline (headless worker, no HTTP port).
# Build context MUST be the repo root:  docker build -f apps/stream-worker/Dockerfile .
#
# Runtime note: the @brain/* workspace packages ship TypeScript source
# (package.json "main": "src/index.ts"), so the worker runs with tsx — the same way
# `pnpm dev` runs it. `node dist/main.js` cannot resolve those .ts entrypoints.
#
# This service exposes NO HTTP endpoint, so there is no Docker HEALTHCHECK. Liveness in
# Kubernetes should use a process/consumer-lag probe (tracked: the worker has no health
# endpoint yet — see the audit's observability/operational-readiness findings).
# MUST connect as the brain_app role (not superuser) so RLS is enforced (see src/main.ts).

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ── Install the full workspace (devDeps included: tsx is the runtime) ──────────
FROM base AS deps
# argon2 (pulled in transitively across the workspace) compiles via node-gyp.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile --prod=false

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
RUN groupadd -r brain && useradd -r -g brain -m brain
COPY --from=deps --chown=brain:brain /repo /repo
WORKDIR /repo/apps/stream-worker
USER brain

CMD ["pnpm", "exec", "tsx", "src/main.ts"]
