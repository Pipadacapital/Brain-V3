/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace TS packages are published as raw source (main: src/index.ts) and some
  // (notably @brain/pixel-sdk) re-export with explicit `.js` ESM specifiers (NodeNext
  // style). Next/webpack must resolve those `.js` specifiers against the `.ts` source.
  // extensionAlias maps `.js` → the TS source so the workspace barrels resolve in build.
  // (Pre-existing: create-brand-form.tsx → @brain/pixel-sdk failed to build without this.)
  transpilePackages: ['@brain/pixel-sdk', '@brain/money', '@brain/ui', '@brain/contracts'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
  // Web app talks ONLY to the frontend-api BFF (ADR-011).
  // BFF base URL is environment-specific; in dev, it proxies to apps/core.
  async rewrites() {
    return [
      {
        source: '/api/bff/:path*',
        destination: `${process.env.BFF_BASE_URL ?? 'http://localhost:3001'}/api/:path*`,
      },
      // Direct core API routes (backfill trigger + progress — not BFF-wrapped).
      // POST /api/v1/connectors/:id/backfill and GET /api/v1/connectors/:id/jobs
      // live on core directly (ADR-BF-3/4); the web app proxies them transparently.
      {
        source: '/api/v1/:path*',
        destination: `${process.env.CORE_API_URL ?? 'http://localhost:3001'}/api/v1/:path*`,
      },
    ];
  },
  // Strict mode for catching side effects in dev
  reactStrictMode: true,
};

module.exports = nextConfig;
