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
COPY tools/pixel-fixture/package.json tools/pixel-fixture/package.json
COPY tools/seed/package.json tools/seed/package.json
COPY packages/action-core/package.json packages/action-core/package.json
COPY packages/ai-features/package.json packages/ai-features/package.json
COPY packages/ai-platform/package.json packages/ai-platform/package.json
COPY packages/decision-policies/package.json packages/decision-policies/package.json
COPY packages/domain-journey/package.json packages/domain-journey/package.json
COPY packages/identity-normalization/package.json packages/identity-normalization/package.json
COPY packages/platform-flags/package.json packages/platform-flags/package.json
COPY packages/prompt-loader/package.json packages/prompt-loader/package.json
COPY packages/semantic-metrics/package.json packages/semantic-metrics/package.json
COPY packages/testing-golden/package.json packages/testing-golden/package.json
RUN pnpm install --frozen-lockfile --prod=false

# Bring in the full source — the install layer above stays cached.
COPY . .

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
RUN groupadd -r -g 1001 brain && useradd -r -u 1001 -g brain -m brain
COPY --from=deps --chown=brain:brain /repo /repo
WORKDIR /repo/apps/core
USER brain

ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "exec", "tsx", "src/main.ts"]
