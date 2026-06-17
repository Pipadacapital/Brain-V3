/** @type {import('next').NextConfig} */
const nextConfig = {
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
