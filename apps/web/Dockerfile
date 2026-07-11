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
# ── Cache the install layer on manifests only ──────────────────────────────────
# Copy the lockfile + EVERY workspace package.json FIRST, then install. Docker reuses
# this layer on any build that doesn't change a manifest, so editing source no longer
# busts the install — avoiding a full reinstall + argon2 node-gyp recompile every time.
# Adding a new workspace package? Add its package.json to the list below.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/collector/package.json apps/collector/package.json
COPY apps/core/package.json apps/core/package.json
COPY apps/stream-worker/package.json apps/stream-worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/ad-spend-mapper/package.json packages/ad-spend-mapper/package.json
COPY packages/ai-gateway-client/package.json packages/ai-gateway-client/package.json
COPY packages/attribution-writer/package.json packages/attribution-writer/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/connector-core/package.json packages/connector-core/package.json
COPY packages/connector-secrets/package.json packages/connector-secrets/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/ga4-mapper/package.json packages/ga4-mapper/package.json
COPY packages/gokwik-mapper/package.json packages/gokwik-mapper/package.json
COPY packages/identity-core/package.json packages/identity-core/package.json
COPY packages/logistics-status/package.json packages/logistics-status/package.json
COPY packages/metric-engine/package.json packages/metric-engine/package.json
COPY packages/money/package.json packages/money/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/pii-vault/package.json packages/pii-vault/package.json
COPY packages/pixel-sdk/package.json packages/pixel-sdk/package.json
COPY packages/razorpay-mapper/package.json packages/razorpay-mapper/package.json
COPY packages/shiprocket-mapper/package.json packages/shiprocket-mapper/package.json
COPY packages/shopflo-mapper/package.json packages/shopflo-mapper/package.json
COPY packages/shopify-mapper/package.json packages/shopify-mapper/package.json
COPY packages/tenant-context/package.json packages/tenant-context/package.json
COPY packages/woocommerce-mapper/package.json packages/woocommerce-mapper/package.json
COPY tools/data-quality/package.json tools/data-quality/package.json
COPY tools/isolation-fuzz/package.json tools/isolation-fuzz/package.json
COPY tools/parity-oracle/package.json tools/parity-oracle/package.json
COPY tools/pixel-fixture/package.json tools/pixel-fixture/package.json
COPY tools/seed/package.json tools/seed/package.json
RUN pnpm install --frozen-lockfile --prod=false

# Bring in the full source — the install layer above stays cached.
COPY . .
# next.config.js rewrites() bakes the BFF/core proxy target into the routes
# manifest at BUILD time — runtime env (the web-env secret) CANNOT override it.
# Without this the deployed image freezes the 'http://localhost:3001' dev
# fallback and every /api/bff/* and /api/v1/* call ECONNREFUSEs in-cluster.
# Provide the in-cluster core Service URL here so `next build` bakes the real
# target (overridable per-env via --build-arg).
ARG BFF_BASE_URL=http://core.core.svc.cluster.local:3001
ARG CORE_API_URL=http://core.core.svc.cluster.local:3001
ENV BFF_BASE_URL=${BFF_BASE_URL} \
    CORE_API_URL=${CORE_API_URL}
# Build only the web app (and its workspace deps via turbo's ^build).
RUN pnpm --filter @brain/web build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd -r -g 1001 brain && useradd -r -u 1001 -g brain -m brain
COPY --from=builder --chown=brain:brain /repo /repo
WORKDIR /repo/apps/web
USER brain

EXPOSE 3000

# `/` is server-rendered; treat any non-5xx response as healthy (auth redirects are fine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "exec", "next", "start"]
