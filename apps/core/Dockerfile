# syntax=docker/dockerfile:1
#
# @brain/core — API gateway / BFF + domain services (Fastify, port 3001).
# Build context MUST be the repo root:  docker build -f apps/core/Dockerfile .
#
# Runtime note: the @brain/* workspace packages ship TypeScript source
# (package.json "main": "src/index.ts"), so the service is run with tsx — the same
# way `pnpm dev` runs it. `node dist/main.js` cannot resolve those .ts entrypoints.

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ── Install the full workspace (devDeps included: tsx is the runtime) ──────────
FROM base AS deps
# argon2 (core's password hasher) compiles via node-gyp.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile --prod=false

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
RUN groupadd -r brain && useradd -r -g brain -m brain
COPY --from=deps --chown=brain:brain /repo /repo
WORKDIR /repo/apps/core
USER brain

ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "exec", "tsx", "src/main.ts"]
