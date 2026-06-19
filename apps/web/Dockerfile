# syntax=docker/dockerfile:1
#
# @brain/web — Next.js 15 dashboard (port 3000).
# Build context MUST be the repo root:  docker build -f apps/web/Dockerfile .
#
# next.config.js uses transpilePackages for the @brain/* workspace packages (which ship
# TS source), so `next build` compiles them into .next; the image then runs `next start`.

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ── Install + production build ─────────────────────────────────────────────────
FROM base AS builder
# argon2 (pulled in transitively across the workspace) compiles via node-gyp.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
# Build only the web app (and its workspace deps via turbo's ^build).
RUN pnpm --filter @brain/web build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd -r brain && useradd -r -g brain -m brain
COPY --from=builder --chown=brain:brain /repo /repo
WORKDIR /repo/apps/web
USER brain

EXPOSE 3000

# `/` is server-rendered; treat any non-5xx response as healthy (auth redirects are fine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "exec", "next", "start"]
